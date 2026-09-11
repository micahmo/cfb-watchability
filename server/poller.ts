import { RateLimitError, fetchPregameLine, fetchScoreboard, type RawGame } from "./espn.js";
import { LineStore } from "./lines.js";
import { anticipationScore, buildTags, scoreGame } from "./scoring.js";
import { SwingStore } from "./store.js";
import type { Game, League, Snapshot } from "../shared/types.js";

const POLL_MS = Number(process.env.POLL_MS ?? 30_000);
/** With nothing live there is nothing to refresh, so back right off. */
const IDLE_POLL_MS = Number(process.env.IDLE_POLL_MS ?? 5 * 60_000);
const MAX_BACKOFF_MS = 15 * 60_000;
const GROUPS = process.env.ESPN_GROUPS ?? "80";
/** YYYYMMDD, or a YYYYMMDD-YYYYMMDD range. Unset means the live date range. */
const DATES = process.env.ESPN_DATES || undefined;
/** How far back the "just finished" recap reaches. Widen it to replay an old slate. */
const RECENT_WINDOW_MS = Number(process.env.RECENT_WINDOW_HOURS ?? 10) * 60 * 60 * 1000;
/** The schedule barely moves, so it is fetched far less often than the scores. */
const SCHEDULE_POLL_MS = Number(process.env.SCHEDULE_POLL_MS ?? 10 * 60 * 1000);
/** How many days ahead the planning list looks. */
const SCHEDULE_DAYS = Number(process.env.SCHEDULE_DAYS ?? 8);
/** Generous cap: the client groups these by day, so slicing by score alone here
 *  would silently drop a whole day off the planning list. */
const MAX_UPCOMING = 60;
const MAX_RECENT = 12;
/** Cap the one-off line lookups per poll so a full Saturday cannot burst. */
const MAX_LINE_LOOKUPS_PER_POLL = 4;

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Yesterday through today, rather than ESPN's "current week".
 *
 * ESPN rolls the current week over at midnight ET, which drops a still-running
 * late game out of the default scoreboard entirely: the board reported nothing
 * live while a game was actually being played. Asking by date keeps a game that
 * runs past midnight visible, and keeps it in the recap afterwards.
 */
function liveDateRange(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return `${yyyymmdd(yesterday)}-${yyyymmdd(now)}`;
}

/** Hook for league-specific data the scoreboard does not carry, such as NFL divisions. */
export type Enricher = (games: RawGame[]) => void | Promise<void>;

/**
 * Owns everything for one league: its snapshot, its caches and its own adaptive
 * poll cadence. Two leagues run side by side without sharing state, so a quiet
 * NFL week cannot slow down a busy college Saturday or vice versa.
 */
export class LeaguePoller {
  readonly league: League;
  private readonly enrich: Enricher | null;
  private readonly swings = new SwingStore();
  private readonly lines = new LineStore();
  private scheduled: RawGame[] = [];
  private consecutiveFailures = 0;
  /** Non-zero only while honouring an actual HTTP 429 from ESPN. */
  private rateLimitedUntil = 0;

  snapshot: Snapshot;

  constructor(league: League, enrich: Enricher | null = null) {
    this.league = league;
    this.enrich = enrich;
    this.snapshot = {
      league,
      updatedAt: new Date(0).toISOString(),
      season: null,
      week: null,
      live: [],
      upcoming: [],
      recent: [],
      market: null,
      error: null,
    };
  }

  start(): void {
    void this.pollSchedule().then(() => this.pollLoop());
    setInterval(() => void this.pollSchedule(), SCHEDULE_POLL_MS);
  }

  health() {
    return {
      ok: this.snapshot.error === null,
      updatedAt: this.snapshot.updatedAt,
      liveGames: this.snapshot.live.length,
      consecutiveFailures: this.consecutiveFailures,
      rateLimited: Date.now() < this.rateLimitedUntil,
      nextPollSeconds: Math.round(this.nextPollDelay() / 1000),
      error: this.snapshot.error,
    };
  }

  private tag(): string {
    return this.league.toUpperCase();
  }

  private async pollSchedule(): Promise<void> {
    if (DATES) return; // A pinned date is a replay; do not fetch a live schedule over it.
    try {
      const from = new Date();
      const to = new Date(Date.now() + SCHEDULE_DAYS * 24 * 60 * 60 * 1000);
      const { games } = await fetchScoreboard({
        league: this.league,
        groups: GROUPS,
        dates: `${yyyymmdd(from)}-${yyyymmdd(to)}`,
      });
      this.scheduled = games.filter((g) => g.state === "pre");
      await this.enrich?.(this.scheduled);
      console.log(
        `[${this.tag()}] schedule: ${this.scheduled.length} upcoming over the next ${SCHEDULE_DAYS} days`,
      );
    } catch (err) {
      console.error(
        `[${this.tag()}] schedule failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async backfillLines(live: RawGame[]): Promise<void> {
    // Games that kicked off before this process started have no cached line, since
    // the scoreboard drops odds at kickoff. One summary call each, then never again.
    const missing = live
      .filter((g) => !this.lines.isResolved(g.id))
      .slice(0, MAX_LINE_LOOKUPS_PER_POLL);
    for (const game of missing) {
      try {
        const line = await fetchPregameLine(this.league, game.id);
        if (line === null) {
          this.lines.markUnavailable(game.id);
          continue;
        }
        this.lines.record(game.id, line);
        console.log(`[${this.tag()}] line ${game.shortName}: ${line.details ?? line.homeSpread}`);
      } catch (err) {
        this.lines.markUnavailable(game.id);
        console.error(
          `[${this.tag()}] line ${game.shortName} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private withScore(raw: RawGame, swingMovement: number): Game {
    // Finished games are scored as if the clock hit zero, which gives a fair
    // retrospective "how good was that one" number for the recap list.
    const period = raw.state === "post" ? Math.max(raw.period, 4) : raw.period;
    const clockSeconds = raw.state === "post" ? 0 : raw.clockSeconds;

    const line = this.lines.get(raw.id);
    const breakdown = scoreGame({
      league: this.league,
      homeSpread: line?.homeSpread ?? raw.homeSpread,
      overUnder: line?.overUnder ?? raw.overUnder,
      period,
      clockSeconds,
      home: raw.home,
      away: raw.away,
      homeWinProb: raw.state === "post" ? null : raw.homeWinProb,
      conferenceGame: raw.conferenceGame,
      divisionGame: raw.divisionGame,
      startDate: raw.startDate,
      swingMovement,
      possessionTeamId: raw.possessionTeamId,
      network: raw.broadcast,
      isFinal: raw.state === "post",
    });

    const game: Game = {
      ...raw,
      score: breakdown,
      anticipation: null,
      pregameSpread: line?.homeSpread ?? raw.homeSpread,
      pregameOdds: line?.details ?? raw.odds,
      tags: [],
    };
    game.tags = buildTags(game, breakdown);
    return game;
  }

  private withAnticipation(raw: RawGame): Game {
    return {
      ...raw,
      score: null,
      tags: [],
      pregameSpread: raw.homeSpread,
      pregameOdds: raw.odds,
      anticipation: anticipationScore({
        league: this.league,
        spread: raw.spread,
        overUnder: raw.overUnder,
        home: raw.home,
        away: raw.away,
        network: raw.broadcast,
        conferenceGame: raw.conferenceGame,
        divisionGame: raw.divisionGame,
        startDate: raw.startDate,
      }),
    };
  }

  private async poll(): Promise<void> {
    if (Date.now() < this.rateLimitedUntil) {
      console.log(`[${this.tag()}] poll skipped, still inside the rate-limit hold`);
      return;
    }
    try {
      const { games, season, week } = await fetchScoreboard({
        league: this.league,
        groups: GROUPS,
        dates: DATES ?? liveDateRange(),
      });
      await this.enrich?.(games);
      const now = Date.now();

      // Capture every line we see while a game is still pregame; the scoreboard
      // stops carrying odds the moment it kicks off.
      for (const raw of games) this.lines.recordFromScoreboard(raw);
      for (const raw of this.scheduled) this.lines.recordFromScoreboard(raw);
      await this.backfillLines(games.filter((g) => g.state === "in"));

      for (const raw of games) {
        if (raw.state === "in") this.swings.record(raw.id, raw.homeWinProb, now);
      }
      this.swings.prune(now);

      const live = games
        .filter((g) => g.state === "in")
        .map((g) => this.withScore(g, this.swings.movement(g.id)))
        .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));

      // Prefer the forward-looking fetch, falling back to whatever the current
      // week's board happens to carry.
      const upcomingSource =
        this.scheduled.length > 0 ? this.scheduled : games.filter((g) => g.state === "pre");
      const seen = new Set([...live, ...games.filter((g) => g.state === "post")].map((g) => g.id));
      const upcoming = upcomingSource
        .filter((g) => !seen.has(g.id))
        .map((g) => this.withAnticipation(g))
        .sort((a, b) => (b.anticipation ?? 0) - (a.anticipation ?? 0))
        .slice(0, MAX_UPCOMING);

      const recent = games
        .filter((g) => g.state === "post" && now - Date.parse(g.startDate) < RECENT_WINDOW_MS)
        .map((g) => this.withScore(g, this.swings.movement(g.id)))
        .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0))
        .slice(0, MAX_RECENT);

      this.snapshot = {
        league: this.league,
        updatedAt: new Date(now).toISOString(),
        season,
        week,
        live,
        upcoming,
        recent,
        market: null,
        error: null,
      };
      console.log(
        `[${this.tag()}] ${new Date(now).toLocaleTimeString()} live=${live.length} upcoming=${upcoming.length} recent=${recent.length}` +
          (live[0] ? ` top="${live[0].shortName}" ${live[0].score?.total}` : ""),
      );
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (err instanceof RateLimitError) {
        const wait = (err.retryAfterSeconds ?? 300) * 1000;
        this.rateLimitedUntil = Date.now() + Math.min(wait, MAX_BACKOFF_MS);
        console.error(`[${this.tag()}] rate limited, holding off ${Math.round(wait / 1000)}s`);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.snapshot = { ...this.snapshot, error: message };
      console.error(
        `[${this.tag()}] poll failed (${this.consecutiveFailures} in a row): ${message}`,
      );
    }
  }

  /**
   * Adaptive cadence. Polling every 30 seconds around the clock is ~3k requests a
   * day against an undocumented endpoint for no benefit, since outside game windows
   * nothing changes. Fast while games are live, slow when they are not, and it wakes
   * up just after the next kickoff so a game is never missed by more than a poll.
   */
  private nextPollDelay(): number {
    const now = Date.now();
    if (now < this.rateLimitedUntil) return this.rateLimitedUntil - now;
    if (this.consecutiveFailures > 0) {
      return Math.min(POLL_MS * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS);
    }
    if (this.snapshot.live.length > 0) return POLL_MS;

    const nextKickoff = this.scheduled
      .map((g) => Date.parse(g.startDate))
      .filter((t) => Number.isFinite(t) && t > now)
      .sort((a, b) => a - b)[0];
    if (nextKickoff !== undefined) {
      // Land just after kickoff rather than up to a full idle period late.
      const untilKickoff = nextKickoff - now + 15_000;
      return Math.max(POLL_MS, Math.min(IDLE_POLL_MS, untilKickoff));
    }
    return IDLE_POLL_MS;
  }

  private async pollLoop(): Promise<void> {
    await this.poll();
    const delay = this.nextPollDelay();
    console.log(`[${this.tag()}] next poll in ${Math.round(delay / 1000)}s`);
    setTimeout(() => void this.pollLoop(), delay);
  }
}
