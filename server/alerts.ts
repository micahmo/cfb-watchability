import type { Game, League, Snapshot } from "../shared/types.js";
import { PROFILES, combine, DEFAULT_PROFILE } from "../shared/weights.js";
import type { Category, Subscription, SubscriptionStore } from "./subscriptions.js";

/** Live score a game must reach to be worth interrupting somebody for. */
const HERO = 75;
/** The point at which it stops being a good game and becomes a memorable one. */
const CLASSIC = 85;
/**
 * Game clock that must remain for a `hero` alert.
 *
 * Measured rather than guessed. Lateness weighting means scores only climb near
 * the end, so most crossings land inside the final two minutes and a
 * three-minute gate removes three quarters of them. Sixty seconds keeps the
 * genuinely early crossings, which are the exceptional games worth interrupting
 * someone for, and drops the ones that crossed with twenty seconds left and could
 * never have been reached in time.
 */
const HERO_MIN_SECONDS_LEFT = 60;
/**
 * Upset tension that counts as an upset worth announcing.
 *
 * Not a margin test. "Underdog ahead by one score" measures the wrong thing:
 * UMass led Rutgers by 16 as 29.5-point underdogs and would have failed it. The
 * tension term already peaks while the improbable is plausible but undecided,
 * which is the moment worth sending. On a full college Saturday this fires on
 * four games; the term itself tops out around 0.59.
 */
const UPSET_TENSION = 0.55;
/** Enough games in a window that choosing between them is actually a problem. */
const KICKOFF_MIN_SLATE = 4;
/**
 * A window with one game in it is the whole slate, which is its own reason to
 * say something: not "this is the best of several" but "football is on".
 *
 * Deliberately the exact inverse of the kickoff rule, so the two can never both
 * fire. No clock heuristic and no hardcoded slots: "the only game in its window"
 * finds Thursday, Sunday and Monday night on a normal week, and on a holiday week
 * it also finds the Thanksgiving afternoon games and Black Friday, which an
 * after-7pm rule would have missed and which are exactly the ones worth knowing
 * about. College has no equivalent, so this is NFL only.
 */
const PRIMETIME_MAX_SLATE = 1;
/** How long after kickoff a "starting now" alert is still true. */
const KICKOFF_GRACE_MS = 5 * 60 * 1000;

const DAILY_CAP = 3;
const COOLDOWN_MS = 10 * 60 * 1000;
const FAVOURITE_BONUS = [0, 8, 13];

export interface Alert {
  category: Category;
  game: Game;
  score: number;
  /** Other games live right now, which decides the wording but never the sending. */
  alternatives: number;
}

function secondsLeft(game: Game): number {
  return (4 - Math.min(game.period, 4)) * 900 + game.clockSeconds;
}

function favouriteBoost(game: Game, favourites: string[]): number {
  const matches =
    Number(favourites.includes(game.home.conferenceName ?? "")) +
    Number(favourites.includes(game.away.conferenceName ?? ""));
  return FAVOURITE_BONUS[matches];
}

/** The same number the viewer sees on their own board, favourites included. */
function boosted(game: Game, favourites: string[]): number {
  if (!game.score) return 0;
  const base = combine(game.score, PROFILES[DEFAULT_PROFILE], game.score.maxTotal);
  return Math.min(100, base + favouriteBoost(game, favourites));
}

/** Their own market says this is not on, so there is nothing to switch to. */
function unavailable(game: Game): boolean {
  return game.marketStations !== null && game.marketStations.length === 0;
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Decides what is worth telling somebody about.
 *
 * A notification's job is to say you are watching the wrong game, so one you
 * cannot act on is worse than none: it only tells you what you missed. Everything
 * fires on a transition rather than a state, because a game sitting at 82 for
 * twenty minutes is one event and not forty polls.
 */
export class AlertEngine {
  private seeded = new Set<League>();
  /** `${subscriptionId}:${gameId}:${category}` for everything already sent. */
  private sent = new Set<string>();
  private lastSentAt = new Map<string, number>();
  private dailyCount = new Map<string, number>();
  /** Kickoff windows already announced, keyed by league and slot. */
  private announced = new Set<string>();

  constructor(private readonly store: SubscriptionStore) {}

  private allowed(sub: Subscription, league: League, now: number): boolean {
    if (now - (this.lastSentAt.get(sub.id) ?? 0) < COOLDOWN_MS) return false;
    return (this.dailyCount.get(`${sub.id}:${league}:${dayKey(now)}`) ?? 0) < DAILY_CAP;
  }

  private record(sub: Subscription, league: League, now: number, keys: string[]): void {
    for (const key of keys) this.sent.add(key);
    this.lastSentAt.set(sub.id, now);
    const key = `${sub.id}:${league}:${dayKey(now)}`;
    this.dailyCount.set(key, (this.dailyCount.get(key) ?? 0) + 1);
  }

  private liveCandidates(sub: Subscription, snapshot: Snapshot): Alert[] {
    const league = snapshot.league;
    const wants = sub.wants[league] ?? [];
    if (wants.length === 0) return [];

    const favourites = sub.favourites[league] ?? [];
    const live = snapshot.live.filter((g) => !unavailable(g));
    const out: Alert[] = [];

    for (const game of live) {
      const score = boosted(game, favourites);
      const alternatives = live.length - 1;
      const already = (c: Category) => this.sent.has(`${sub.id}:${game.id}:${c}`);

      // Checked first, so a game that vaults straight past both thresholds
      // announces the bigger thing rather than the smaller one.
      if (wants.includes("classic") && score >= CLASSIC && !already("classic")) {
        // No time gate. This is not asking anyone to switch; it tells somebody
        // already watching that they picked the right game.
        out.push({ category: "classic", game, score, alternatives });
        continue;
      }
      if (
        wants.includes("hero") &&
        score >= HERO &&
        !already("hero") &&
        secondsLeft(game) >= HERO_MIN_SECONDS_LEFT
      ) {
        out.push({ category: "hero", game, score, alternatives });
        continue;
      }
      if (
        wants.includes("upset") &&
        !already("upset") &&
        (game.score?.upsetTension ?? 0) >= UPSET_TENSION
      ) {
        out.push({ category: "upset", game, score, alternatives });
      }
    }
    return out;
  }

  /** Kickoff alerts, and their inverse: a window with only one game in it. */
  private kickoffCandidates(sub: Subscription, snapshot: Snapshot, now: number): Alert[] {
    const league = snapshot.league;
    const wants = sub.wants[league] ?? [];
    const wantsKickoff = wants.includes("kickoff");
    const wantsPrimetime = wants.includes("primetime") && league === "nfl";
    if (!wantsKickoff && !wantsPrimetime) return [];

    const slots = new Map<string, Game[]>();
    for (const game of snapshot.upcoming) {
      const bucket = slots.get(game.startDate);
      if (bucket) bucket.push(game);
      else slots.set(game.startDate, [game]);
    }

    const favourites = sub.favourites[league] ?? [];
    const out: Alert[] = [];
    for (const [startDate, games] of slots) {
      const solo = games.length <= PRIMETIME_MAX_SLATE;
      const category: Category = solo ? "primetime" : "kickoff";
      if (solo ? !wantsPrimetime : !(wantsKickoff && games.length >= KICKOFF_MIN_SLATE)) continue;
      const kick = Date.parse(startDate);
      // At kickoff, not before. A heads-up half an hour early is the planning
      // list again; the point of this one is that it is starting now.
      if (!(now >= kick && now - kick < KICKOFF_GRACE_MS)) continue;
      const key = `${league}:${startDate}`;
      if (this.announced.has(key)) continue;

      const rank = (g: Game) => (g.anticipation ?? 0) + favouriteBoost(g, favourites);
      const best = games.filter((g) => !unavailable(g)).sort((a, b) => rank(b) - rank(a))[0];
      if (!best) continue;

      this.announced.add(key);
      out.push({
        category,
        game: best,
        score: rank(best),
        alternatives: games.length - 1,
      });
    }
    return out;
  }

  /**
   * Evaluates a fresh snapshot and sends whatever it earns.
   *
   * `viewFor` returns the snapshot as that subscriber would see it, market
   * annotations included, so availability is resolved per person rather than
   * globally. Returns how many notifications went out.
   */
  async evaluate(
    snapshot: Snapshot,
    viewFor: (sub: Subscription) => Promise<Snapshot>,
  ): Promise<number> {
    if (!this.store.available) return 0;
    const now = Date.now();

    // Whatever is already true when the process starts is not news. Without this
    // a Force Update mid-Saturday re-announces the entire afternoon.
    if (!this.seeded.has(snapshot.league)) {
      this.seeded.add(snapshot.league);
      for (const sub of this.store.all) {
        for (const game of snapshot.live) {
          for (const category of ["hero", "classic", "upset"] as Category[]) {
            this.sent.add(`${sub.id}:${game.id}:${category}`);
          }
        }
      }
      console.log(`[notify] seeded ${snapshot.league} from ${snapshot.live.length} live game(s)`);
      return 0;
    }

    let sent = 0;
    for (const sub of this.store.all) {
      if (!this.allowed(sub, snapshot.league, now)) continue;

      let view: Snapshot;
      try {
        view = await viewFor(sub);
      } catch {
        view = snapshot; // Market lookup failed; better a generic alert than none.
      }

      const candidates = [
        ...this.liveCandidates(sub, view),
        ...this.kickoffCandidates(sub, view, now),
      ];
      if (candidates.length === 0) continue;

      // One buzz, not three. A chaotic finish should not machine-gun a phone.
      candidates.sort((a, b) => b.score - a.score);
      await this.store.send(sub, buildPayload(candidates));
      this.record(
        sub,
        snapshot.league,
        now,
        candidates.map((c) => `${sub.id}:${c.game.id}:${c.category}`),
      );
      sent += 1;
    }
    return sent;
  }
}

/** The pregame bands the board itself uses, in words rather than a bare number. */
function expectation(score: number): string {
  if (score >= 80) return "One of the best on the board";
  if (score >= 70) return "Worth clearing the evening";
  if (score >= 55) return "Worth having on";
  return "Not expected to be much";
}

/** "in the 2nd", or "in OT". Only the third quarter was special-cased, so every
 *  other one read as "1th", "2th", "4th". */
function quarter(period: number): string {
  if (period > 4) return "in OT";
  const suffix = period === 1 ? "st" : period === 2 ? "nd" : period === 3 ? "rd" : "th";
  return `in the ${period}${suffix}`;
}

function detail(alert: Alert): string {
  const game = alert.game;
  const network = game.broadcast ? ` · ${game.broadcast}` : "";
  if (alert.category === "kickoff" || alert.category === "primetime") {
    // "Kicking off now" only repeats the title. What is actually useful before a
    // game is how good it is expected to be, and that matters most for the
    // primetime alert, whose whole premise is that the only game on might be a
    // bad one. Saying so is the point.
    return `${expectation(alert.score)} · rated ${Math.round(alert.score)}${network}`;
  }
  return `${game.away.abbrev} ${game.away.score}, ${game.home.abbrev} ${game.home.score} · ${game.clock} ${quarter(game.period)}${network}`;
}

export function buildPayload(alerts: Alert[]): unknown {
  const lead = alerts[0];
  const game = lead.game;
  const matchup = `${game.away.name} at ${game.home.name}`;

  /*
   * How many other games are on picks the wording, never whether to send. Making
   * it a gate was tempting and wrong: two of the measured NFL alerts fired with
   * nothing else live, one of them a game that peaked at 86, and suppressing
   * those assumes the viewer is already watching something rather than simply
   * having forgotten it was on.
   */
  const title =
    lead.category === "classic"
      ? `${matchup} is turning into something`
      : lead.category === "primetime"
        ? // Not a claim that it is good. The point is that it is the only one on.
          `Football is on: ${matchup}`
        : lead.category === "kickoff"
          ? `${matchup} kicks off now`
          : lead.category === "upset"
            ? `Upset alert: ${matchup}`
            : lead.alternatives > 0
              ? `Switch to ${matchup}`
              : `${matchup} is worth putting on`;

  const also = alerts
    .slice(1)
    .map((a) => `${a.game.away.abbrev} at ${a.game.home.abbrev}`)
    .join(", ");

  return {
    title,
    body: also ? `${detail(lead)}\nAlso worth a look: ${also}` : detail(lead),
    league: game.league,
    gameId: game.id,
    category: lead.category,
  };
}
