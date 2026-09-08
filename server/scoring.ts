import type { Game, ScoreBreakdown, ScoreComponents, TeamSide } from "../shared/types.js";
import { DEFAULT_PROFILE, PROFILES, combine } from "../shared/weights.js";
import { prominenceScore } from "./prominence.js";

const PERIOD_SECONDS = 900;
const REGULATION_SECONDS = 3600;
/** Rank we assign to unranked teams so rank math stays continuous. */
const UNRANKED = 40;

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** 0 at kickoff, 1 at the end of regulation. Overtime pins to 1. */
export function gameProgress(period: number, clockSeconds: number): number {
  if (period <= 0) return 0;
  if (period > 4) return 1;
  const elapsed = (period - 1) * PERIOD_SECONDS + (PERIOD_SECONDS - clockSeconds);
  return clamp(elapsed / REGULATION_SECONDS);
}

export function secondsRemaining(period: number, clockSeconds: number): number {
  if (period > 4) return 0;
  return clamp(REGULATION_SECONDS * (1 - gameProgress(period, clockSeconds)), 0, REGULATION_SECONDS);
}

/** 1.0 at a coin flip, 0 when the result is decided. */
export function tensionFromWinProb(winProb: number): number {
  return clamp(1 - 2 * Math.abs(winProb - 0.5));
}

/**
 * Fallback for games ESPN has no win probability on (no play-by-play, halftime).
 * The margin that matters shrinks as the clock runs out: 10 points is nothing in
 * the first quarter and nearly over with two minutes left.
 */
export function tensionFromMargin(margin: number, secsLeft: number): number {
  const scale = 4 + 0.005 * secsLeft;
  return clamp(Math.exp(-Math.pow(Math.abs(margin) / scale, 2)));
}

/**
 * Closeness of a finished game. This asks "was that a good one" rather than
 * "can it still change", so it is far more forgiving than the live curve: at
 * 0:00 the live curve writes off any two-score game, but a seven-point final
 * is usually a game worth having watched.
 */
export function tensionFromFinalMargin(margin: number): number {
  return clamp(Math.exp(-Math.pow(Math.abs(margin) / 9, 2)));
}

/**
 * Being tied in the first quarter is not exciting. Being tied with two minutes
 * left is the whole point, so tension is weighted heavily toward the end.
 */
function latenessWeight(progress: number): number {
  return 0.2 + 0.8 * Math.pow(progress, 2);
}

/** Cumulative absolute win-probability movement, normalized. */
export function swingScore(totalMovement: number): number {
  return clamp(totalMovement / 0.5);
}

/** Endgame drama lives inside the final five minutes of regulation. */
const CLUTCH_WINDOW_SECONDS = 300;

export interface ClutchInputs {
  period: number;
  clockSeconds: number;
  margin: number;
  possessionTeamId: string | null;
  /** Team id currently ahead, or null if tied. */
  leaderTeamId: string | null;
}

/**
 * Win probability answers "who will win", which is not the same question as
 * "is something about to happen". A team down five with the ball and thirty
 * seconds left has a terrible win probability and is the most watchable thing
 * on television. This term exists to catch exactly that case.
 */
export function clutchScore(i: ClutchInputs): number {
  const inOvertime = i.period > 4;
  const secsLeft = secondsRemaining(i.period, i.clockSeconds);
  if (!inOvertime && (i.period < 4 || secsLeft > CLUTCH_WINDOW_SECONDS)) return 0;

  const marginFactor = i.margin <= 8 ? 1 : i.margin <= 16 ? 0.45 : 0;
  if (marginFactor === 0) return 0;

  // Every overtime snap is decisive, so urgency is already maxed.
  if (inOvertime) return marginFactor;

  const urgency = clamp(1 - secsLeft / CLUTCH_WINDOW_SECONDS);

  // Who has the ball is the difference between a comeback attempt and a team
  // kneeling out the clock. The leader holding it is still tense (the trailing
  // side needs a stop), so this discounts rather than erases, which also keeps
  // the board from lurching every time possession changes.
  let possessionFactor = 0.8;
  if (i.possessionTeamId !== null) {
    if (i.leaderTeamId === null) possessionFactor = 1;
    else possessionFactor = i.possessionTeamId === i.leaderTeamId ? 0.6 : 1;
  }

  return clamp(marginFactor * urgency * possessionFactor);
}

function rankOf(team: TeamSide): number {
  return team.rank ?? UNRANKED;
}

/** Rewards the lower-ranked team hanging with or beating the higher-ranked one. */
export function upsetScore(home: TeamSide, away: TeamSide, progress: number): number {
  const hr = rankOf(home);
  const ar = rankOf(away);
  if (hr === UNRANKED && ar === UNRANKED) return 0;

  const [underdog, favorite] = hr > ar ? [home, away] : [away, home];
  const gap = Math.abs(hr - ar);
  const lead = underdog.score - favorite.score;

  // Hanging around counts. An unranked team within a score of a top-15 team in
  // the fourth quarter is an upset in progress whether or not they lead yet,
  // and the game is worth watching either way.
  let position: number;
  if (lead > 0) position = 1;
  else if (lead === 0) position = 0.8;
  else if (lead >= -8) position = 0.55;
  else if (lead >= -16) position = 0.2;
  else return 0;

  const gapWeight = clamp(gap / 25);
  return clamp(gapWeight * (0.4 + 0.6 * progress) * position);
}

/** Ranking and conference implications, which no clock-based metric can see. */
export function stakesScore(home: TeamSide, away: TeamSide, conferenceGame: boolean): number {
  const hr = rankOf(home);
  const ar = rankOf(away);
  let s = 0;
  if (hr <= 25 && ar <= 25) s += 0.5;
  else if (hr <= 25 || ar <= 25) s += 0.2;
  if (hr <= 10 && ar <= 10) s += 0.3;
  if (conferenceGame) s += 0.2;
  return clamp(s);
}

/** A 45-38 track meet is worth watching even when it is not especially close. */
export function paceScore(totalPoints: number, progress: number): number {
  if (progress < 0.08) return 0;
  const projected = totalPoints / progress;
  return clamp((projected - 35) / 35);
}

/**
 * How far ahead of the closing line the underdog is running.
 *
 * This is the honest measure of surprise. Rank gap cannot distinguish a 27.5-point
 * mismatch from a 3-point coin flip, and both can read as "ranked versus unranked".
 */
export function marketUpsetScore(
  homeSpread: number,
  home: TeamSide,
  away: TeamSide,
  progress: number,
): number {
  const expectedDeficit = Math.abs(homeSpread);
  if (expectedDeficit === 0) return 0;

  const homeIsUnderdog = homeSpread > 0;
  const underdog = homeIsUnderdog ? home : away;
  const favorite = homeIsUnderdog ? away : home;

  const vsLine = expectedDeficit - (favorite.score - underdog.score);
  if (vsLine <= 0) return 0;
  return clamp(vsLine / MAX_VS_LINE) * (0.4 + 0.6 * progress);
}

export interface ScoreInputs {
  period: number;
  clockSeconds: number;
  home: TeamSide;
  away: TeamSide;
  homeWinProb: number | null;
  conferenceGame: boolean;
  swingMovement: number;
  possessionTeamId: string | null;
  network: string | null;
  /** Pregame closing spread, home-relative. Null when we have no line. */
  homeSpread: number | null;
  /** Scores a completed game retrospectively instead of as a live situation. */
  isFinal?: boolean;
}

function combinedUpset(input: ScoreInputs, progress: number): number {
  const rank = upsetScore(input.home, input.away, progress);
  if (input.homeSpread === null) return rank; // No line, so rank is all we have.
  const market = marketUpsetScore(input.homeSpread, input.home, input.away, progress);
  return Math.max(market, RANK_ONLY_CEILING * rank);
}

export function scoreGame(input: ScoreInputs): ScoreBreakdown {
  const progress = gameProgress(input.period, input.clockSeconds);
  const margin = Math.abs(input.home.score - input.away.score);
  const totalPoints = input.home.score + input.away.score;

  const hasWinProb = input.homeWinProb !== null;
  let tension: number;
  if (input.isFinal) {
    tension = tensionFromFinalMargin(margin);
  } else if (hasWinProb) {
    tension = tensionFromWinProb(input.homeWinProb as number);
  } else {
    tension = tensionFromMargin(margin, secondsRemaining(input.period, input.clockSeconds));
  }

  const lateness = latenessWeight(progress);
  const core = tension * lateness;

  const leaderTeamId =
    input.home.score === input.away.score
      ? null
      : input.home.score > input.away.score
        ? input.home.id
        : input.away.id;

  // A finished game has no endgame left to be dramatic about.
  const clutch = input.isFinal
    ? 0
    : clutchScore({
        period: input.period,
        clockSeconds: input.clockSeconds,
        margin,
        possessionTeamId: input.possessionTeamId,
        leaderTeamId,
      });

  const components: ScoreComponents = {
    tension,
    lateness,
    core,
    clutch,
    primary: Math.max(core, clutch),
    prominence: prominenceScore({
      homeConferenceId: input.home.conferenceId,
      awayConferenceId: input.away.conferenceId,
      homeRank: input.home.rank,
      awayRank: input.away.rank,
      network: input.network,
    }),
    swing: swingScore(input.swingMovement),
    upset: combinedUpset(input, progress),
    stakes: stakesScore(input.home, input.away, input.conferenceGame),
    pace: paceScore(totalPoints, progress),
  };

  // A four-score game in the fourth quarter is over regardless of what the
  // prominence and pace terms think of it.
  const maxTotal = progress > 0.8 && margin >= 25 ? 8 : null;

  return {
    ...components,
    maxTotal,
    hasWinProb,
    total: combine(components, PROFILES[DEFAULT_PROFILE], maxTotal),
  };
}

/** Blowouts pile up points too, so a shootout has to also have been contested. */
const SHOOTOUT_MAX_MARGIN = 17;

/** Beating the closing line by three touchdowns is a maximal upset. */
const MAX_VS_LINE = 21;
/**
 * Rank alone can only carry the term this far. An unranked team beating a ranked
 * one is a genuine story even when the market called it a coin flip, but it is not
 * the same event as a 27-point underdog hanging around, and only the closing line
 * can tell those apart.
 */
const RANK_ONLY_CEILING = 0.6;
/** Roughly the start of the fourth quarter. */
const LATE_GAME_PROGRESS = 0.75;

interface UnderdogView {
  gap: number;
  /** Positive when the underdog is behind. */
  deficit: number;
  levelOrAhead: boolean;
}

function underdogView(game: Game): UnderdogView | null {
  // The market knows who the underdog is better than the polls do.
  if (game.pregameSpread !== null && game.pregameSpread !== 0) {
    const homeIsUnderdog = game.pregameSpread > 0;
    const underdog = homeIsUnderdog ? game.home : game.away;
    const favorite = homeIsUnderdog ? game.away : game.home;
    const deficit = favorite.score - underdog.score;
    return { gap: Math.abs(game.pregameSpread), deficit, levelOrAhead: deficit <= 0 };
  }

  const hr = game.home.rank ?? UNRANKED;
  const ar = game.away.rank ?? UNRANKED;
  if (hr === UNRANKED && ar === UNRANKED) return null;
  const [underdog, favorite] = hr > ar ? [game.home, game.away] : [game.away, game.home];
  const deficit = favorite.score - underdog.score;
  return { gap: Math.abs(hr - ar), deficit, levelOrAhead: deficit <= 0 };
}

export function buildTags(game: Game, breakdown: ScoreBreakdown): string[] {
  const tags: string[] = [];
  const isFinal = game.state === "post";
  const progress = gameProgress(game.period, game.clockSeconds);
  const hr = game.home.rank ?? UNRANKED;
  const ar = game.away.rank ?? UNRANKED;

  // The endgame label, named for the situation rather than for a comeback: it is
  // equally true of a tied game and of a lead being defended, and "comeback"
  // claimed a specific story the condition does not actually require.
  const onTheLine = !isFinal && breakdown.clutch >= 0.6;

  if (game.period > 4) tags.push("OVERTIME");
  if (breakdown.total >= 80) tags.push("INSTANT CLASSIC");
  if (onTheLine) tags.push("GAME ON THE LINE");

  if (isFinal) {
    if (game.margin <= 8) tags.push("ONE SCORE FINISH");
  } else if (!onTheLine && progress > 0.85 && game.margin <= 8 && game.period <= 4) {
    // Suppressed once the stronger label applies, so the two do not stack and
    // say nearly the same thing twice.
    tags.push("ONE SCORE, LATE");
  }
  const underdog = underdogView(game);
  // Magnitude is carried by `breakdown.upset` itself, which already blends the
  // closing line with the rank gap, so no separate gap gate is needed here.
  if (underdog !== null) {
    if (breakdown.upset >= 0.35 && underdog.levelOrAhead) {
      tags.push("UPSET ALERT");
    } else if (
      // Behind but one score away with the clock running out. The upset has not
      // happened, but it is live, and that is worth switching over for.
      !isFinal &&
      !underdog.levelOrAhead &&
      underdog.deficit <= 8 &&
      progress >= LATE_GAME_PROGRESS &&
      breakdown.upset >= 0.2
    ) {
      tags.push("UPSET POTENTIAL");
    }
  }
  // Named "recent" on purpose: `swing` is a rolling 15-minute window, so this tag
  // is expected to appear and fade as a game settles. A permanent "wild game"
  // badge would point you at games that have since stopped being close.
  if (breakdown.swing >= 0.6) tags.push("RECENT SWINGS");
  if (breakdown.pace >= 0.7 && game.margin <= SHOOTOUT_MAX_MARGIN) tags.push("SHOOTOUT");
  if (hr <= 10 && ar <= 10) tags.push("TOP-10 CLASH");
  return tags;
}

// --- Pregame ---------------------------------------------------------------

/** Rank prominence reused for pregame quality, where both teams must be good. */
function rankQuality(rank: number | null): number {
  if (rank === null) return 0.12;
  if (rank <= 5) return 1.0;
  if (rank <= 15) return 0.78;
  return 0.55;
}

/**
 * Closeness expected before kickoff. The betting market prices in injuries,
 * weather, travel and motivation, so nothing we compute ourselves beats it.
 */
export function spreadCloseness(spread: number | null): number {
  if (spread === null) return 0.4;
  return clamp(Math.exp(-Math.pow(Math.abs(spread) / 10, 2)));
}

export interface AnticipationInputs {
  spread: number | null;
  overUnder: number | null;
  home: TeamSide;
  away: TeamSide;
  network: string | null;
  conferenceGame: boolean;
}

/**
 * How much a game is worth planning around, before it kicks off.
 *
 * Unlike the live score, `quality` here takes the *worse* of the two teams:
 * planning your evening around a mismatch is a bad idea no matter how good the
 * favourite is. Prominence still takes the better of the two, since that is what
 * drives the conversation.
 */
export function anticipationScore(i: AnticipationInputs): number {
  const closeness = spreadCloseness(i.spread);
  const quality = Math.min(rankQuality(i.home.rank), rankQuality(i.away.rank));
  const prominence = prominenceScore({
    homeConferenceId: i.home.conferenceId,
    awayConferenceId: i.away.conferenceId,
    homeRank: i.home.rank,
    awayRank: i.away.rank,
    network: i.network,
  });
  const pace = i.overUnder === null ? 0.3 : clamp((i.overUnder - 40) / 30);
  const conference = i.conferenceGame ? 1 : 0;

  const total =
    100 *
    clamp(
      0.36 * closeness + 0.26 * prominence + 0.22 * quality + 0.11 * pace + 0.05 * conference,
    );
  return Math.round(total * 10) / 10;
}
