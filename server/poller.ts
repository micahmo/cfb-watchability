import {
  RateLimitError,
  fetchPregameLine,
  fetchScoreboard,
  normalizeEvents,
  type RawGame,
} from "./espn.js";
import { FastcastClient, TOPICS, applyPatch, splitPath, type Patch } from "./fastcast.js";
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
/**
 * How far back the "just finished" recap reaches, measured from kickoff. Widen it
 * to replay an old slate.
 *
 * Eighteen hours rather than ten so a Sunday night game is still there on Monday
 * morning. Ten put an afternoon game out of reach by late the same evening, which
 * is no use to anyone catching up the next day.
 */
const RECENT_WINDOW_MS = Number(process.env.RECENT_WINDOW_HOURS ?? 18) * 60 * 60 * 1000;
/** The schedule barely moves, so it is fetched far less often than the scores. */
const SCHEDULE_POLL_MS = Number(process.env.SCHEDULE_POLL_MS ?? 10 * 60 * 1000);
/** Retry gap after a failed schedule fetch, while the list is still empty. */
const SCHEDULE_RETRY_MS = 30_000;
/** How many days ahead the planning list looks. */
const SCHEDULE_DAYS = Number(process.env.SCHEDULE_DAYS ?? 8);
/**
 * Per day, not per slate.
 *
 * A single global cap sorted by anticipation quietly guts the near term. Over an
 * eight-day college window ESPN returns around 157 upcoming games, and a cap of 60
 * across all of them is decided by next Saturday's conference play, which outranks
 * this Saturday's non-conference schedule. Measured on a live board: tomorrow got 17
 * of its 71 games while next Saturday got 39, so three games kicked off today that
 * had never appeared in the planning list at all.
 *
 * Capping within each day keeps every day's own best games. Sized above the biggest
 * real Saturday on purpose, so in normal weeks it never binds and nothing is lost:
 * it is a bound on a pathological response, not a ranking decision. The day boundary
 * is the server's local one, which matches the viewer's grouping whenever they share
 * a timezone; where they do not, a game near midnight lands in the neighbouring day's
 * budget, which at this size trims nothing.
 */
const MAX_UPCOMING_PER_DAY = 100;
/**
 * The client renders three days. Shipping four covers it with a day of slack while
 * keeping the payload honest: the old eight-day list spent most of its budget on
 * days the client discarded without drawing them.
 */
const MAX_UPCOMING_DAYS = 4;
const MAX_RECENT = 12;
/** Cap the one-off line lookups per poll so a full Saturday cannot burst. */
const MAX_LINE_LOOKUPS_PER_POLL = 4;
/**
 * How long to gather pushes before rebuilding the board.
 *
 * Patches arrive in bursts, a dozen or more for a single play as ESPN updates the
 * clock, the score, the drive and the situation in turn, and rebuilding on each
 * one would re-score the whole slate a dozen times to land on the same answer.
 * Waiting a second collapses a burst into one rebuild and still leaves the board
 * an order of magnitude fresher than the thirty-second poll it replaces.
 */
const PATCH_COALESCE_MS = 1000;
/**
 * How long a missing situation may be filled in from the last one seen.
 *
 * Forty-five seconds rather than four minutes. The carry now fires on the common
 * case rather than the rare one, so its job changed: it is bridging the seconds
 * between snaps and through a timeout, not surviving a long outage, and a down
 * and distance from four minutes ago describes a different drive.
 */
const SITUATION_CARRY_MS = 45 * 1000;
/**
 * How long a missing win probability may be filled in from the last one seen.
 *
 * Shorter than the situation carry and, unlike it, not abandoned when the score
 * changes. The two fields go stale differently. A carried "3rd & 6" after a
 * touchdown is precisely wrong, so it is dropped; a carried win probability is
 * only approximately wrong, and the alternative is very much worse. Without it
 * `tensionScore` falls back to a margin curve which disagrees with the real number
 * violently: 0-0 in a mismatch reads as perfectly close on margin and 0.99 on
 * probability, so a game sat at 19.6, dropped to 7.6 and came back with nothing
 * about it having changed but whether ESPN was sending the field.
 */
const WIN_PROB_CARRY_MS = 90 * 1000;
/**
 * How far behind a side has to be before its win probability stops being credible.
 *
 * Not a judgement about football, a bound measured from ESPN's own numbers. Across
 * 11,597 live frames of finished games: with a side trailing by 17 to 24 its win
 * probability never once exceeded 0.194 in 1,786 frames, and trailing by 25 or more
 * it never exceeded 0.043 in 3,415. Below 17 it can be anything, and rightly so, a
 * one-score game late is a coin flip however it looks on the scoreboard.
 *
 * Which is what makes the guard safe and why it is written this narrowly. The
 * obvious version, letting the scoreboard override any optimistic probability,
 * would fire on 31% of all frames and gut the games this board exists to find: the
 * 43-41 game that ran to the wire sat at a 7-point margin with a probability
 * saying coin flip and a margin curve saying 0.08, and the probability was right.
 */
const IMPLAUSIBLE_DEFICIT = 17;
const IMPLAUSIBLE_WIN_PROB = 0.35;

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

/** Where a scoreboard document has got to, for comparing two of them. */
function progressOf(event: any): { period: number; clock: number; points: number } {
  const comp = event?.competitions?.[0];
  const status = event?.status ?? comp?.status ?? {};
  const scores = (comp?.competitors ?? []).map((c: any) => Number(c?.score));
  return {
    period: Number(status?.period) || 0,
    clock: Number(status?.clock) || 0,
    points: scores.reduce((a: number, b: number) => a + (Number.isFinite(b) ? b : 0), 0),
  };
}

/**
 * Whether `candidate` describes an earlier moment of the game than `held`.
 *
 * The two-second tolerance on the clock is for rounding between sources, not for
 * doubt: a real clock never climbs inside a period.
 */
function isBehind(candidate: any, held: any): boolean {
  const a = progressOf(candidate);
  const b = progressOf(held);
  if (a.period !== b.period) return a.period < b.period;
  return a.clock > b.clock + 2 || a.points < b.points;
}

/** Local calendar day, matching how the client groups the planning list. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Keeps the best games of each of the next few days, rather than the best games
 * overall. Input must already be sorted by anticipation; output stays in that
 * order, since the client re-groups and re-sorts it anyway.
 */
function capPerDay(games: Game[]): Game[] {
  const days = [...new Set(games.map((g) => localDay(g.startDate)))]
    .sort()
    .slice(0, MAX_UPCOMING_DAYS);
  const budget = new Map(days.map((d) => [d, MAX_UPCOMING_PER_DAY]));
  const kept: Game[] = [];
  for (const game of games) {
    const day = localDay(game.startDate);
    const left = budget.get(day);
    if (left === undefined || left === 0) continue;
    budget.set(day, left - 1);
    kept.push(game);
  }
  return kept;
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
  /**
   * ESPN's own event documents, keyed by uid, which is what the push feed patches.
   *
   * The normalised `RawGame` view cannot be patched: a delta addresses a path
   * inside ESPN's document, and normalising throws that structure away. So the
   * raw document is kept and re-normalised after every burst, which also means a
   * pushed update goes through exactly the same scoring as a polled one.
   */
  private rawEvents = new Map<string, any>();
  /**
   * The last live situation seen for a game, so a gap in it does not blank the card.
   *
   * ESPN drops `situation` for stretches of a live game, taking win probability,
   * possession, down and distance and the last play with it. That has always been
   * true; the push feed made it conspicuous, because a thirty-second poll only
   * sometimes landed inside a gap, while this sees every removal the moment it
   * happens and the card visibly flickers.
   */
  /** The last win probability seen per game, carried on its own terms. */
  private lastWinProb = new Map<string, { at: number; value: number }>();
  private lastSituation = new Map<
    string,
    {
      at: number;
      score: string;
      homeWinProb: number | null;
      possessionTeamId: string | null;
      downDistance: string | null;
      isRedZone: boolean;
      lastPlay: string | null;
      yardLine: number | null;
      down: number | null;
      distance: number | null;
      driveStart: number | null;
    }
  >();
  private season: number | null = null;
  private week: number | null = null;
  private fastcast: FastcastClient | null = null;
  private patchTimer: NodeJS.Timeout | null = null;
  /** Patches applied since the last rebuild, for the log line. */
  private patchesApplied = 0;
  private consecutiveFailures = 0;
  private polling = false;
  private lastPollAt = 0;
  /** Non-zero only while honouring an actual HTTP 429 from ESPN. */
  private rateLimitedUntil = 0;

  snapshot: Snapshot;

  /** Notified after every successful poll, so alerts see each new snapshot once. */
  private readonly onSnapshot: ((snapshot: Snapshot) => void) | null;

  constructor(
    league: League,
    enrich: Enricher | null = null,
    onSnapshot: ((snapshot: Snapshot) => void) | null = null,
  ) {
    this.league = league;
    this.enrich = enrich;
    this.onSnapshot = onSnapshot;
    this.snapshot = {
      league,
      updatedAt: new Date(0).toISOString(),
      season: null,
      week: null,
      live: [],
      upcoming: [],
      recent: [],
      market: null,
      build: null,
      error: null,
    };
  }

  start(): void {
    void this.pollSchedule().then(() => this.pollLoop());
    setInterval(() => void this.pollSchedule(), SCHEDULE_POLL_MS);

    // Polling continues unchanged underneath this. The push feed only closes the
    // gap between polls, so losing it costs freshness and nothing else.
    this.fastcast = new FastcastClient(
      TOPICS[this.league],
      {
        onPatches: (patches) => this.onPatches(patches),
        // A gap in the stream leaves the held document wrong in ways no later
        // patch corrects, because a patch carries only the field that changed.
        // Skipped when a poll is running or has just run. Measured against the
        // attempt rather than the resulting snapshot, because at startup the
        // websocket connects while the first poll is still in flight and both
        // would otherwise fetch the same slate.
        onResync: () => {
          if (this.polling || Date.now() - this.lastPollAt < POLL_MS) return;
          void this.poll();
        },
      },
      (message) => console.log(`[${this.tag()}] fastcast ${message}`),
    );
    this.fastcast.start();
  }

  /**
   * Applies a burst of pushes to the held documents.
   *
   * Patches for games outside the current window are dropped on the floor: the
   * topic carries every game in the league, and `rawEvents` holds only the ones
   * this board is tracking, so an unknown uid is the normal filter rather than an
   * error worth logging.
   */
  private onPatches(patches: Patch[]): void {
    let applied = 0;
    for (const patch of patches) {
      const target = splitPath(patch.path);
      if (target === null) continue;
      const event = this.rawEvents.get(target.uid);
      if (event === undefined) continue;
      if (applyPatch(event, target.segments, patch.op, patch.value)) applied += 1;
    }
    if (applied === 0) return;

    this.patchesApplied += applied;
    if (this.patchTimer !== null) return;
    this.patchTimer = setTimeout(() => {
      this.patchTimer = null;
      void this.rebuildFromPatches();
    }, PATCH_COALESCE_MS);
    this.patchTimer.unref?.();
  }

  /** Re-normalises the patched documents and rescores, with no network at all. */
  private async rebuildFromPatches(): Promise<void> {
    const count = this.patchesApplied;
    this.patchesApplied = 0;
    try {
      const games = normalizeEvents([...this.rawEvents.values()], this.league);
      /*
       * Awaited, not fired and forgotten.
       *
       * Normalising builds fresh objects every rebuild, so nothing carries over,
       * and enrichment resolving a microtask after `compose` publishes means it
       * never lands at all on this path. That costs the NFL its divisions, playoff
       * seeds and standings win percentage, which prominence and stakes are scored
       * from, on every push-driven rebuild until the next poll quietly repaired it.
       * The lookup is cached behind a TTL, so awaiting it is nearly always free.
       */
      await this.enrich?.(games);
      for (const raw of games) this.lines.recordFromScoreboard(raw);
      this.compose(games, Date.now(), ` push(${count})`);
    } catch (err) {
      // The next poll rebuilds from scratch regardless, so a bad burst costs one
      // rebuild rather than the board.
      console.error(
        `[${this.tag()}] rebuild from pushes failed: ${err instanceof Error ? err.message : err}`,
      );
    }
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
      // Try again soon rather than waiting out the full interval. A failure on
      // startup otherwise leaves the planning list empty for ten minutes, which
      // looks exactly like a slate with no games in it.
      if (this.scheduled.length === 0) {
        setTimeout(() => void this.pollSchedule(), SCHEDULE_RETRY_MS);
      }
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
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const { season, week, events } = await fetchScoreboard({
        league: this.league,
        groups: GROUPS,
        dates: DATES ?? liveDateRange(),
      });
      const now = Date.now();

      /*
       * Replaced, but never rewound.
       *
       * The scoreboard lags the push feed, so replacing wholesale meant every poll
       * rolled the board back to whatever REST happened to know. Measured on a live
       * slate: six scores went backwards in ninety seconds, 27-21, 23-17, 20-14,
       * and one clock jumped from three seconds remaining to 723, all of it at
       * thirty-second intervals, which is the poll.
       *
       * So a polled document is taken unless it is demonstrably behind the one
       * already held. Game state only moves one way: periods climb, the clock falls
       * within a period, points never drop. Anything failing that is stale and the
       * patched document stands, and as soon as REST catches up it is accepted
       * again, which is what keeps the poll able to heal a missed patch.
       */
      const fresh = new Map<string, any>();
      let rewound = 0;
      for (const event of events) {
        if (typeof event?.uid !== "string") continue;
        const held = this.rawEvents.get(event.uid);
        if (held !== undefined && isBehind(event, held)) {
          fresh.set(event.uid, held);
          rewound += 1;
        } else {
          fresh.set(event.uid, event);
        }
      }
      this.rawEvents = fresh;
      if (rewound > 0) {
        console.log(`[${this.tag()}] kept ${rewound} pushed game(s) the poll would have rewound`);
      }
      this.season = season;
      this.week = week;

      /*
       * Normalised back out of the merged map, not out of the fetch.
       *
       * Composing from `events` undid the guard for a frame. The held document
       * was kept as the base the next push would build on, so the rewind no
       * longer stuck, but the board still published the stale REST view until
       * that push landed a second or two later. Reading back through the map
       * means the poll scores exactly the documents it decided to keep, and the
       * two paths into `compose` start from the same place.
       */
      const games = normalizeEvents([...this.rawEvents.values()], this.league);
      await this.enrich?.(games);

      // Capture every line we see while a game is still pregame; the scoreboard
      // stops carrying odds the moment it kicks off.
      for (const raw of games) this.lines.recordFromScoreboard(raw);
      for (const raw of this.scheduled) this.lines.recordFromScoreboard(raw);
      // Finished games need the line too, so the recap can answer "did that go as
      // expected". A game that started and ended between two polls was never seen
      // live, so it would otherwise have no line at all.
      await this.backfillLines(
        games.filter(
          (g) =>
            g.state === "in" ||
            (g.state === "post" && now - Date.parse(g.startDate) < RECENT_WINDOW_MS),
        ),
      );

      this.compose(games, now);
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
    } finally {
      this.polling = false;
    }
  }

  /**
   * Builds a snapshot from normalised games and publishes it.
   *
   * Shared by the REST poll and the push feed, so a pushed update is scored by
   * exactly the same code as a polled one rather than by a parallel path that
   * could drift. Deliberately does no network: the push path runs this on every
   * burst, and a line lookup or standings refresh in here would turn a websocket
   * message into an outbound request.
   */
  /**
   * Fills a missing situation from the last one seen, within limits.
   *
   * The score is what guards it, and it turns out to guard it precisely.
   *
   * Everything that legitimately ends a possession on a dead ball also changes the
   * score: a touchdown, the extra point after it, a field goal. So the held
   * situation is dropped exactly when it stops being true, and the diagram
   * correctly shows nothing through the kick and the kickoff that follow. What
   * survives the guard is the case the diagram should survive: a timeout, where
   * the ball is spotted and it is still second and seven, and the seconds between
   * snaps of a drive that is still going.
   *
   * A punt is the one thing that slips through, since it changes possession
   * without changing the score. It costs a second or two of a stale down before
   * the receiving team's situation arrives, which is a better trade than the
   * flicker: a board that blinks its field diagram out several times a drive
   * trains you to stop looking at it.
   */
  private carrySituation(games: RawGame[], now: number): void {
    for (const game of games) {
      if (game.state !== "in") continue;

      /*
       * A win probability the scoreboard says cannot be true is thrown away, along
       * with anything held for this game, because the reason it is wrong is that
       * the score moved underneath it.
       *
       * Seen live: Ohio State led Texas 20-3 with ten seconds of the half left and
       * ESPN published 0.4701 for Texas, having published 0.2062 a play earlier at
       * 13-3 and 0.0961 a moment later. The half then ended, nothing refreshed, and
       * the board showed that game at 53.8 for three minutes on the strength of one
       * bad frame. Dropping it rather than carrying anything lets the margin curve
       * answer, which is the one thing that is definitely current.
       */
      if (game.homeWinProb !== null) {
        const deficit = Math.abs(game.home.score - game.away.score);
        const trailing =
          game.home.score < game.away.score ? game.homeWinProb : 1 - game.homeWinProb;
        if (deficit >= IMPLAUSIBLE_DEFICIT && trailing > IMPLAUSIBLE_WIN_PROB) {
          console.log(
            `[${this.tag()}] dropped an impossible win probability for ${game.shortName}: ` +
              `trailing by ${deficit} at ${(trailing * 100).toFixed(1)}%`,
          );
          game.homeWinProb = null;
          this.lastWinProb.delete(game.id);
        }
      }

      /* Win probability first and separately: ESPN drops it on its own, with the
         rest of the situation still present, in about one live sample in eleven. */
      if (game.homeWinProb !== null) {
        this.lastWinProb.set(game.id, { at: now, value: game.homeWinProb });
      } else {
        const held = this.lastWinProb.get(game.id);
        if (held && now - held.at <= WIN_PROB_CARRY_MS) game.homeWinProb = held.value;
      }

      const score = `${game.away.score}-${game.home.score}`;
      /*
       * Whether the situation is here, asked of the situation itself.
       *
       * This used to ask whether a win probability or a last play had arrived, on
       * the reasoning that their presence proved the block was real and so a
       * missing down was real too. Measured against a live slate, that is simply
       * false: across 600 samples of fifteen games the field diagram was absent
       * 27% of the time, and in *every* one of those samples `down` and
       * `possession` were missing while `lastPlay` and the win probability were
       * both still there. The old test could therefore never fire on the case it
       * most needed to, and the diagram flickered out mid-drive, between snaps,
       * and through every timeout.
       */
      const present =
        game.down !== null && game.distance !== null && game.possessionTeamId !== null;

      if (present) {
        this.lastSituation.set(game.id, {
          at: now,
          score,
          homeWinProb: game.homeWinProb,
          possessionTeamId: game.possessionTeamId,
          downDistance: game.downDistance,
          isRedZone: game.isRedZone,
          lastPlay: game.lastPlay,
          yardLine: game.yardLine,
          down: game.down,
          distance: game.distance,
          driveStart: game.driveStart,
        });
        continue;
      }

      const held = this.lastSituation.get(game.id);
      if (!held || held.score !== score || now - held.at > SITUATION_CARRY_MS) continue;
      game.homeWinProb = held.homeWinProb;
      game.possessionTeamId = held.possessionTeamId;
      game.downDistance = held.downDistance;
      game.isRedZone = held.isRedZone;
      game.lastPlay = held.lastPlay;
      game.yardLine = held.yardLine;
      game.down = held.down;
      game.distance = held.distance;
      game.driveStart = held.driveStart;
    }
  }

  private compose(games: RawGame[], now: number, note = ""): void {
    this.carrySituation(games, now);
    for (const raw of games) {
      if (raw.state === "in") this.swings.record(raw.id, raw.homeWinProb, now);
    }
    this.swings.prune(now);

    /*
     * ESPN moves a game out of `pre` before a snap is played, for a weather delay
     * or a long pregame, and such a game reads as 0-0 in period 0. That is not
     * live, and left in the live list it does not merely appear, it *leads*: a
     * scoreless game is maximally close, so it scores tension 1.00 and takes the
     * hero slot. Observed doing exactly that, recommending a delayed game as the
     * best thing on. A period is the evidence that football has been played.
     */
    const started = (g: RawGame) => g.state === "in" && g.period >= 1;
    const live = games
      .filter(started)
      .map((g) => this.withScore(g, this.swings.movement(g.id)))
      .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));

    // Prefer the forward-looking fetch, falling back to whatever the current
    // week's board happens to carry. Games that have left `pre` without starting
    // are folded in here, since "has not kicked off yet" is exactly what they are
    // and dropping them would make a delayed game vanish from the board entirely.
    const notStarted = games.filter((g) => g.state === "in" && g.period < 1);
    const upcomingSource = [
      ...(this.scheduled.length > 0 ? this.scheduled : games.filter((g) => g.state === "pre")),
      ...notStarted,
    ];
    const seen = new Set([...live, ...games.filter((g) => g.state === "post")].map((g) => g.id));
    const upcoming = capPerDay(
      upcomingSource
        .filter((g) => !seen.has(g.id))
        .map((g) => this.withAnticipation(g))
        .sort((a, b) => (b.anticipation ?? 0) - (a.anticipation ?? 0)),
    );

    const recent = games
      .filter((g) => g.state === "post" && now - Date.parse(g.startDate) < RECENT_WINDOW_MS)
      .map((g) => this.withScore(g, this.swings.movement(g.id)))
      .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0))
      .slice(0, MAX_RECENT);

    this.snapshot = {
    league: this.league,
    updatedAt: new Date(now).toISOString(),
    season: this.season,
    week: this.week,
    live,
    upcoming,
    recent,
    market: null,
    build: null,
    error: null,
    };
    // After the snapshot is in place, so anything reading it sees the new one.
    try {
    this.onSnapshot?.(this.snapshot);
    } catch (err) {
    console.error(`[${this.tag()}] snapshot hook failed: ${err instanceof Error ? err.message : err}`);
    }
    console.log(
    `[${this.tag()}] ${new Date(now).toLocaleTimeString()}${note} live=${live.length} upcoming=${upcoming.length} recent=${recent.length}` +
      (live[0] ? ` top="${live[0].shortName}" ${live[0].score?.total}` : ""),
    );
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
