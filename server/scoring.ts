import type { Game, League, ScoreBreakdown, ScoreComponents, TeamSide } from "../shared/types.js";
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

/** A full .500 gap in win percentage is treated as a maximal mismatch. */
const MAX_RECORD_GAP = 0.5;

/**
 * The NFL has no poll, so record stands in for the rank gap.
 *
 * The closing line already prices records in, so this is not a second prediction.
 * It is the same narrative allowance the college model makes for rank: a winless
 * team beating an unbeaten one is a story even when the spread was close.
 */
export function recordUpsetScore(home: TeamSide, away: TeamSide, progress: number): number {
  if (home.winPct === null || away.winPct === null) return 0;
  const [underdog, favorite] =
    home.winPct < away.winPct ? [home, away] : [away, home];
  const gap = Math.abs(home.winPct - away.winPct);
  if (gap === 0) return 0;

  const lead = underdog.score - favorite.score;
  let position: number;
  if (lead > 0) position = 1;
  else if (lead === 0) position = 0.8;
  else if (lead >= -8) position = 0.55;
  else if (lead >= -16) position = 0.2;
  else return 0;

  return clamp((gap / MAX_RECORD_GAP) * (0.4 + 0.6 * progress) * position);
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

/** In the playoff field, as a seed. */
function inPlayoffField(seed: number | null): boolean {
  return seed !== null && seed > 0 && seed <= 7;
}

/**
 * What the game means beyond itself. College has polls and conference play; the
 * NFL has divisions and playoff seeding, which are the closer analogue of stakes
 * than any record comparison would be.
 */
export function stakesScore(
  league: League,
  home: TeamSide,
  away: TeamSide,
  conferenceGame: boolean,
  divisionGame: boolean,
): number {
  if (league === "nfl") {
    let s = 0;
    // Division games swing the tiebreakers that decide the division.
    if (divisionGame) s += 0.45;
    const contenders = [home, away].filter((t) => inPlayoffField(t.playoffSeed)).length;
    if (contenders === 2) s += 0.4;
    else if (contenders === 1) s += 0.15;
    const winning = [home, away].filter((t) => (t.winPct ?? 0) > 0.5).length;
    if (winning === 2) s += 0.15;
    return clamp(s);
  }

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
/**
 * Expected final points, as a 0..1 rating.
 *
 * Dividing points so far by elapsed fraction alone is wildly unstable early: two
 * touchdowns in the first seven minutes projects a 113-point game. So the observed
 * rate is shrunk toward a prior, which is the pregame over/under when we have one,
 * weighted by how much of the game has actually been played.
 */
/**
 * Scoring expectations differ by league, so the pace term has to be normalised
 * against each one. College totals run roughly 43 to 67; NFL totals run roughly
 * 38 to 52. Scoring both on the college scale means no NFL game can ever clear
 * 0.38 on pace, which is a penalty for being the NFL rather than a judgement
 * about the game.
 */
const PACE_SCALE: Record<League, { floor: number; span: number; typical: number }> = {
  cfb: { floor: 35, span: 35, typical: 55 },
  nfl: { floor: 28, span: 26, typical: 45 },
};

export function paceScore(
  league: League,
  totalPoints: number,
  progress: number,
  overUnder: number | null = null,
): number {
  const { floor, span, typical } = PACE_SCALE[league];
  const prior = overUnder ?? typical;
  if (progress < 0.08) return clamp((prior - floor) / span);
  const observed = totalPoints / progress;
  const projected = prior * (1 - progress) + observed * progress;
  return clamp((projected - floor) / span);
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
  league: League;
  period: number;
  clockSeconds: number;
  home: TeamSide;
  away: TeamSide;
  homeWinProb: number | null;
  conferenceGame: boolean;
  divisionGame: boolean;
  startDate: string;
  swingMovement: number;
  possessionTeamId: string | null;
  network: string | null;
  /** Pregame closing spread, home-relative. Null when we have no line. */
  homeSpread: number | null;
  /** Pregame closing over/under, used only to steady the early pace estimate. */
  overUnder: number | null;
  /** Scores a completed game retrospectively instead of as a live situation. */
  isFinal?: boolean;
}

function combinedUpset(input: ScoreInputs, progress: number): number {
  // College ranks by poll, the NFL by record. Either way this is the narrative
  // fallback, and the market drives the magnitude when a line exists.
  const narrative =
    input.league === "nfl"
      ? recordUpsetScore(input.home, input.away, progress)
      : upsetScore(input.home, input.away, progress);
  if (input.homeSpread === null) return narrative;
  const market = marketUpsetScore(input.homeSpread, input.home, input.away, progress);
  return Math.max(market, RANK_ONLY_CEILING * narrative);
}

/**
 * How compelling an upset-in-progress is, independent of how close the game is.
 *
 * The board otherwise conflates "watchable" with "close", and a blowout upset is
 * invisible to it. UMass, 29.5-point underdogs, led Rutgers 24-7 at the half and
 * won by 16: the biggest story of that weekend, and the model peaked it at 45.9
 * and would not have mentioned it, because it stopped being competitive early.
 *
 * The tension in an upset is not about the margin, it is about whether the
 * improbable thing is going to happen. So it rises as the underdog's win
 * probability climbs away from where the line put it, and falls again once the
 * result is no longer in doubt, which is exactly the arc a viewer feels. On that
 * game it peaks at the half, at 24-7 with the underdog at 67%, and decays to zero
 * by the fourth quarter even as the winning margin grows.
 */
export function upsetTensionScore(
  homeSpread: number | null,
  homeWinProb: number | null,
  isFinal: boolean,
): number {
  if (isFinal || homeSpread === null || homeWinProb === null) return 0;
  const spread = Math.abs(homeSpread);
  // Below a touchdown there is no upset to speak of, just a close game, which the
  // main term already handles.
  if (spread < 6) return 0;

  // Implied pregame win probability for the favourite. A logistic on the spread:
  // a field goal is a coin flip nudged, four touchdowns is a formality.
  const favPre = 1 / (1 + Math.exp(-spread / 6.5));
  const homeFavoured = homeSpread < 0;
  const dogLive = homeFavoured ? 1 - homeWinProb : homeWinProb;
  const dogPre = 1 - favPre;

  // How far the improbable has come, and how much doubt is left in it.
  const surprise = clamp((dogLive - dogPre) / (1 - dogPre));
  const doubt = 4 * dogLive * (1 - dogLive);
  return clamp(surprise * doubt);
}

/** Whether the side the closing line made the underdog finished level or ahead. */
function underdogWon(input: ScoreInputs): boolean {
  if (input.homeSpread === null || input.homeSpread === 0) return false;
  const homeFavoured = input.homeSpread < 0;
  const dog = homeFavoured ? input.away : input.home;
  const fav = homeFavoured ? input.home : input.away;
  return dog.score >= fav.score;
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

  const upsetTension = upsetTensionScore(input.homeSpread, input.homeWinProb, input.isFinal === true);
  const upset = combinedUpset(input, progress);

  /**
   * A finished game is judged on whether it mattered, not on whether it was tense.
   *
   * Those are different questions and the recap answers the second one by
   * default, because a final is scored on closeness. UMass beating Rutgers as
   * 29.5-point underdogs graded 23.1: the biggest result of the weekend, sorted
   * to the bottom of the list somebody reads to find out what they missed. A win
   * nobody expected is worth knowing about however comfortable it looked by the
   * end, so an upset can carry a finished game the way closeness carries a live
   * one. Deliberately below what a genuine classic scores, since the best finish
   * of the day should still lead the recap.
   */
  const decisiveness =
    input.isFinal === true && upset >= 0.35 && underdogWon(input) ? upset * 0.75 : 0;

  const components: ScoreComponents = {
    tension,
    lateness,
    core,
    clutch,
    upsetTension,
    // Three ways to earn the dominant term, and a game qualifies on any of them:
    // it is close and late, it has a decisive snap coming, or something is
    // happening that was not supposed to.
    primary: Math.max(core, clutch, upsetTension, decisiveness),
    prominence: prominenceScore({
      league: input.league,
      homeConferenceId: input.home.conferenceId,
      awayConferenceId: input.away.conferenceId,
      homeRank: input.home.rank,
      awayRank: input.away.rank,
      homeWinPct: input.home.winPct,
      awayWinPct: input.away.winPct,
      homeSeed: input.home.playoffSeed,
      awaySeed: input.away.playoffSeed,
      network: input.network,
      startDate: input.startDate,
    }),
    swing: swingScore(input.swingMovement),
    upset,
    stakes: stakesScore(input.league, input.home, input.away, input.conferenceGame, input.divisionGame),
    pace: paceScore(input.league, totalPoints, progress, input.overUnder),
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

/**
 * A shootout is an observation, not a prediction: the points have to already be on
 * the board, and the game has to be close. A blowout piles up points too, and
 * "on pace for" means nothing in the first quarter.
 */
const SHOOTOUT_MIN_POINTS: Record<League, number> = { cfb: 52, nfl: 48 };
const SHOOTOUT_MAX_MARGIN = 10;

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
    if (isFinal && underdog.levelOrAhead && breakdown.upset >= 0.35) {
      // Past tense for a finished game: "ALERT" tells you to go and watch
      // something that is already over. Sized so a glance at the recap separates
      // a mild surprise from the one people will still be talking about.
      tags.push(breakdown.upset >= 0.7 ? "BIG UPSET" : "UPSET");
    } else if (breakdown.upset >= 0.35 && underdog.levelOrAhead) {
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
  if (game.totalPoints >= SHOOTOUT_MIN_POINTS[game.league] && game.margin <= SHOOTOUT_MAX_MARGIN) {
    tags.push("SHOOTOUT");
  }
  if (hr <= 10 && ar <= 10) tags.push("TOP-10 CLASH");
  return tags;
}

// --- Pregame ---------------------------------------------------------------

/** The NFL analogue of rank quality, before the season has separated anyone. */
function recordQuality(winPct: number | null): number {
  if (winPct === null) return 0.55; // neutral in week one
  return clamp(0.15 + 0.85 * winPct);
}

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
  league: League;
  spread: number | null;
  overUnder: number | null;
  home: TeamSide;
  away: TeamSide;
  network: string | null;
  conferenceGame: boolean;
  divisionGame: boolean;
  startDate: string;
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
  // The worse of the two teams, so a mismatch is never worth planning around.
  const quality =
    i.league === "nfl"
      ? Math.min(recordQuality(i.home.winPct), recordQuality(i.away.winPct))
      : Math.min(rankQuality(i.home.rank), rankQuality(i.away.rank));
  const prominence = prominenceScore({
    league: i.league,
    homeConferenceId: i.home.conferenceId,
    awayConferenceId: i.away.conferenceId,
    homeRank: i.home.rank,
    awayRank: i.away.rank,
    homeWinPct: i.home.winPct,
    awayWinPct: i.away.winPct,
    homeSeed: i.home.playoffSeed,
    awaySeed: i.away.playoffSeed,
    network: i.network,
    startDate: i.startDate,
  });
  const pace = paceScore(i.league, 0, 0, i.overUnder);
  const conference = i.league === "nfl" ? (i.divisionGame ? 1 : 0) : i.conferenceGame ? 1 : 0;

  const total =
    100 *
    clamp(
      0.36 * closeness + 0.26 * prominence + 0.22 * quality + 0.11 * pace + 0.05 * conference,
    );
  return Math.round(total * 10) / 10;
}
