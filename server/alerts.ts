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
 * How good the pick of a window has to be before the window is worth mentioning.
 *
 * The kickoff alert only ever asked whether there were enough games to choose
 * between, never whether any of them was worth choosing, so four FCS visitors
 * kicking off together met the bar: Mercer at New Mexico, Northern Colorado at
 * Wyoming, Alabama State at Troy and UC Davis at SMU, best of them rated 26.
 *
 * Fifty-five because that is exactly where `expectation()` stops being negative.
 * Below it the notification's own body reads "Not expected to be much", and
 * interrupting somebody to tell them a game is not worth watching is self-defeating.
 *
 * Primetime is deliberately exempt. Its premise is the opposite, that the only
 * game in its slot might not be good and is worth saying so about.
 */
const KICKOFF_MIN_SCORE = 55;
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
/**
 * How long after the scheduled time a kickoff alert may still fire.
 *
 * Generous, because the trigger is the game actually starting rather than the
 * clock reaching its scheduled time, and a weather delay can push that back an
 * hour or more. The bound exists only so a game postponed to another day does not
 * announce itself when it eventually kicks.
 */
const KICKOFF_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * How many alerts a league may send in a day before it has to earn more.
 *
 * Not a hard stop. A fixed cap spent by mid-afternoon means the best game of the
 * evening arrives in silence, which is the exact failure the whole feature exists
 * to prevent: a notification's job is to say you are watching the wrong game, and
 * "we already sent three" is not a reason that game stopped being worth switching
 * to.
 */
const DAILY_CAP = 3;
/**
 * Past the soft cap, an alert has to beat the best already sent today by this much.
 *
 * Clearly better, not marginally: without a margin a slate drifting upward would
 * trickle out an alert per point. Five is about the gap between "another good one"
 * and "better than anything you have been told about".
 */
const BETTER_BY = 5;
/** Even a day of escalating classics stops here. */
const HARD_CAP = 6;
const COOLDOWN_MS = 10 * 60 * 1000;
const FAVORITE_BONUS = [0, 8, 13];

export interface Alert {
  category: Category;
  game: Game;
  score: number;
  /** Other games live right now, which decides the wording but never the sending. */
  alternatives: number;
  /**
   * The kickoff window this came from, marked as announced only once it is sent.
   *
   * Carried rather than marked while deciding, because the cap is now judged on
   * the best candidate's score and so has to be checked *after* candidates exist.
   * Marking during selection would let a window be consumed by an alert the cap
   * then refused, and it would never be mentioned again.
   */
  slotKey?: string;
}

function secondsLeft(game: Game): number {
  /*
   * Overtime has all the time in the world.
   *
   * College overtime is untimed, so the clock reads zero, and computing from it
   * gives "no time left" on precisely the games most worth interrupting somebody
   * for. Purdue and Wake Forest went to double overtime, finished 38-36, rated
   * 77.9 and sent nothing, because the gate meant to drop alerts arriving twenty
   * seconds too late decided a second overtime was too late to switch to. A single
   * overtime possession takes minutes of real time.
   */
  if (game.period > 4) return Number.POSITIVE_INFINITY;
  return (4 - Math.min(game.period, 4)) * 900 + game.clockSeconds;
}

function favoriteBoost(game: Game, favorites: string[]): number {
  const matches =
    Number(favorites.includes(game.home.conferenceName ?? "")) +
    Number(favorites.includes(game.away.conferenceName ?? ""));
  return FAVORITE_BONUS[matches];
}

/** The same number the viewer sees on their own board, favorites included. */
function boosted(game: Game, favorites: string[]): number {
  if (!game.score) return 0;
  const base = combine(game.score, PROFILES[DEFAULT_PROFILE], game.score.maxTotal);
  return Math.min(100, base + favoriteBoost(game, favorites));
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
  /** The best score sent today, per subscription and league, for the soft cap. */
  private bestSent = new Map<string, number>();
  /** Pregame anticipation by game id, which the game itself drops once it starts. */
  private anticipation = new Map<string, number>();

  constructor(private readonly store: SubscriptionStore) {}

  /**
   * Whether anything may be sent at all, before deciding what.
   *
   * The cooldown is absolute; the daily cap is not. Beyond it a game still gets
   * through by being clearly better than the best already sent, so an evening
   * classic is not silenced by three ordinary afternoon alerts.
   */
  private allowed(sub: Subscription, league: League, now: number, score: number): boolean {
    const key = `${sub.id}:${league}:${dayKey(now)}`;
    const count = this.dailyCount.get(key) ?? 0;
    if (count >= HARD_CAP) return false;
    if (count < DAILY_CAP) return true;
    return score >= (this.bestSent.get(key) ?? 0) + BETTER_BY;
  }

  private record(
    sub: Subscription,
    league: League,
    now: number,
    alerts: Alert[],
    score: number,
  ): void {
    for (const alert of alerts) {
      this.sent.add(`${sub.id}:${alert.game.id}:${alert.category}`);
      if (alert.slotKey !== undefined) this.announced.add(alert.slotKey);
    }
    this.lastSentAt.set(sub.id, now);
    const key = `${sub.id}:${league}:${dayKey(now)}`;
    this.dailyCount.set(key, (this.dailyCount.get(key) ?? 0) + 1);
    this.bestSent.set(key, Math.max(this.bestSent.get(key) ?? 0, score));
  }

  private liveCandidates(sub: Subscription, snapshot: Snapshot): Alert[] {
    const league = snapshot.league;
    const wants = sub.wants[league] ?? [];
    if (wants.length === 0) return [];

    const favorites = sub.favorites[league] ?? [];
    const live = snapshot.live.filter((g) => !unavailable(g));
    const out: Alert[] = [];

    for (const game of live) {
      const score = boosted(game, favorites);
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

    /*
     * Built from live and upcoming together, because a window empties as its games
     * kick off. Grouping only what is still pregame shrinks a twelve-game noon
     * window down as it starts, and the last straggler would read as a window with
     * one game in it, which is the exact condition the primetime alert fires on.
     */
    const slots = new Map<string, Game[]>();
    for (const game of [...snapshot.upcoming, ...snapshot.live]) {
      const bucket = slots.get(game.startDate);
      if (bucket) bucket.push(game);
      else slots.set(game.startDate, [game]);
    }

    const favorites = sub.favorites[league] ?? [];
    const out: Alert[] = [];
    for (const [startDate, games] of slots) {
      const solo = games.length <= PRIMETIME_MAX_SLATE;
      const category: Category = solo ? "primetime" : "kickoff";
      if (solo ? !wantsPrimetime : !(wantsKickoff && games.length >= KICKOFF_MIN_SLATE)) continue;
      const kick = Date.parse(startDate);
      if (!(now >= kick && now - kick < KICKOFF_GRACE_MS)) continue;
      const key = `${league}:${startDate}`;
      if (this.announced.has(key)) continue;

      /*
       * Anticipation is only carried while a game is pregame, so it is remembered
       * as each snapshot goes by and read back here. Without it, the moment a game
       * kicks off it would rank last in its own window.
       *
       * Deliberately unclamped. The board clamps the number it *shows* at 100, and
       * clamping here instead made two marquee games tie at the ceiling: the stable
       * sort then handed the window to whichever came first, which was a game that
       * had not kicked off, and the whole window went unannounced. Ranking and
       * display are different jobs and the ceiling belongs only to the second.
       */
      const rank = (g: Game) =>
        (g.anticipation ?? this.anticipation.get(g.id) ?? 0) + favoriteBoost(g, favorites);
      const best = games.filter((g) => !unavailable(g)).sort((a, b) => rank(b) - rank(a))[0];
      if (!best) continue;

      /*
       * Nothing is said about a game this process never saw pregame.
       *
       * Anticipation only exists while a game is upcoming, so a window that was
       * already under way at startup has none, and the rating collapses to whatever
       * the favourite bonus adds. That is how a marquee game went out as "rated 13,
       * not expected to be much": zero anticipation plus thirteen for two favoured
       * conferences. Seeding above should mean this never comes up; it stays as the
       * guarantee that a number nobody can vouch for is never sent.
       */
      if (best.anticipation === null && !this.anticipation.has(best.id)) continue;

      /*
       * The ball has to be in the air, not merely due.
       *
       * A scheduled time is when the television window opens; the kick lands five
       * to ten minutes later, so firing on the clock told somebody a game had
       * started while the board still showed nothing live and every game in the
       * window still read as upcoming. Waiting for the pick to actually be in
       * progress makes the notification true and the board agree with it.
       *
       * The period check matters as much as the state: ESPN moves a delayed game
       * out of `pre` without it having started, which is how a 0-0 game showing
       * "Delayed" ends up looking live.
       */
      if (best.state !== "in" || best.period < 1) continue;

      // "The pick of a busy window" has to actually be a pick worth making.
      if (category === "kickoff" && rank(best) < KICKOFF_MIN_SCORE) continue;

      out.push({
        category,
        game: best,
        // Clamped here, where it is read by a person, exactly as the board clamps it.
        score: Math.min(100, rank(best)),
        alternatives: games.length - 1,
        slotKey: key,
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

    for (const game of snapshot.upcoming) {
      if (game.anticipation !== null) this.anticipation.set(game.id, game.anticipation);
    }

    // Pushes are about to go out, which is exactly when a dead subscription would
    // take another one into the void, so it is also when to drop it.
    this.store.pruneUnacknowledged();

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
      /*
       * Kickoff windows need seeding too, and used not to.
       *
       * While the trigger was the clock, a restart could not re-announce anything:
       * the five-minute window had long passed. Firing on the game actually being
       * in progress widened that to two hours, so an update mid-afternoon
       * announced a window whose games had kicked off before the process started.
       * Seen live: a kickoff alert nine minutes into the first quarter.
       */
      for (const game of snapshot.live) {
        this.announced.add(`${snapshot.league}:${game.startDate}`);
      }
      console.log(`[notify] seeded ${snapshot.league} from ${snapshot.live.length} live game(s)`);
      return 0;
    }

    let sent = 0;
    for (const sub of this.store.all) {
      // Cooldown first, since it needs nothing and costs nothing.
      if (now - (this.lastSentAt.get(sub.id) ?? 0) < COOLDOWN_MS) continue;

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
      // Judged on the best of them, and only now that there is a score to judge.
      if (!this.allowed(sub, snapshot.league, now, candidates[0].score)) continue;

      await this.store.send(sub, buildPayload(candidates));
      this.record(sub, snapshot.league, now, candidates, candidates[0].score);
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

/** `#5 Oregon at Oklahoma State`, with ranks only where a poll exists. */
function matchupWithRanks(game: Game): string {
  const side = (team: Game["home"]) => (team.rank ? `#${team.rank} ${team.name}` : team.name);
  return `${side(game.away)} at ${side(game.home)}`;
}

/** The closing line as the board shows it, e.g. `MICH -3.5`. */
function lineLabel(game: Game): string {
  if (game.pregameOdds) return game.pregameOdds;
  if (game.pregameSpread === null || game.pregameSpread === 0) return "";
  const favorite = game.pregameSpread < 0 ? game.home : game.away;
  return `${favorite.abbrev} -${Math.abs(game.pregameSpread)}`;
}

function detail(alert: Alert): string {
  const game = alert.game;
  const network = game.broadcast ? ` · ${game.broadcast}` : "";
  if (alert.category === "kickoff" || alert.category === "primetime") {
    // "Kicking off now" only repeats the title. What is useful before a game is
    // how good it is expected to be, which matters most for the primetime alert,
    // whose whole premise is that the only game on might be a bad one. The line
    // earns its place for the same reason: the board shows it on every row, so a
    // notification without it asks someone to open the app to learn what it knew.
    const line = lineLabel(game);
    return `${expectation(alert.score)} · expected ${Math.round(alert.score)}${line ? ` · ${line}` : ""}${network}`;
  }
  return `${game.away.abbrev} ${game.away.score}, ${game.home.abbrev} ${game.home.score} · ${game.clock} ${quarter(game.period)}${network}`;
}

export function buildPayload(alerts: Alert[]): unknown {
  const lead = alerts[0];
  const game = lead.game;
  // Ranks belong in the title, where the matchup is named. College is the only
  // league with a poll, so `team.rank` is simply absent for the NFL.
  const matchup = matchupWithRanks(game);

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
