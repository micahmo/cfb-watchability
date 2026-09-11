export type League = "cfb" | "nfl";

export type GameState = "pre" | "in" | "post";

export interface TeamSide {
  id: string;
  abbrev: string;
  name: string;
  displayName: string;
  logo: string | null;
  color: string;
  altColor: string;
  score: number;
  rank: number | null;
  record: string;
  homeAway: "home" | "away";
  conferenceId: string | null;
  /** Win percentage from the overall record, 0..1. Null before any games. */
  winPct: number | null;
  /** Human conference name: "SEC", "Big Ten", "AFC". Null when unknown. */
  conferenceName: string | null;
  /** NFL only, from the standings feed. */
  divisionId: string | null;
  playoffSeed: number | null;
}

/** Every component is 0..1. These are combined into a 0..100 total by `shared/weights`. */
export interface ScoreComponents {
  tension: number;
  lateness: number;
  core: number;
  /** Endgame drama: one score, clock running out, trailing team with the ball. */
  clutch: number;
  /** 0..1 for an upset in progress, peaking while the result is still in doubt. */
  upsetTension: number;
  /** `max(core, clutch)`. The dominant term in every weight profile. */
  primary: number;
  /** How much of the country cares, independent of whether it is close. */
  prominence: number;
  swing: number;
  upset: number;
  stakes: number;
  pace: number;
}

export interface ScoreBreakdown extends ScoreComponents {
  total: number;
  /** Hard ceiling applied to decided games, or null when uncapped. */
  maxTotal: number | null;
  /** True when win probability came from ESPN rather than our margin fallback. */
  hasWinProb: boolean;
}

export interface Game {
  id: string;
  league: League;
  state: GameState;
  name: string;
  shortName: string;
  startDate: string;
  period: number;
  clock: string;
  clockSeconds: number;
  statusDetail: string;
  /** Raw ESPN status, e.g. STATUS_IN_PROGRESS, STATUS_HALFTIME, STATUS_END_PERIOD. */
  statusName: string;
  home: TeamSide;
  away: TeamSide;
  /** Live win probability for the home team, 0..1. Null when ESPN has not published one. */
  homeWinProb: number | null;
  margin: number;
  totalPoints: number;
  broadcast: string | null;
  /** 0..1 estimate of how widely available the broadcast is. */
  broadcastTier: number;
  /** False for home/away market feeds, which are not carried nationally. */
  nationalBroadcast: boolean;
  /**
   * NFL only: how many games share this network and kickoff window. Above one,
   * the network is splitting the slate by market and only one of those games
   * reaches any given city, so a high score here is not a promise you can watch
   * it. Null for college, where concurrent games under one "network" are usually
   * separate streams rather than a market split.
   */
  regionalPeers: number | null;
  /**
   * Call signs in the viewer's own market carrying this game, once a postal code
   * is set. An empty array is a real answer and the important one: the market is
   * showing something else in this window, so however good the game is, it is not
   * on. Null means no postal code, so availability is simply unknown.
   */
  marketStations: string[] | null;
  /** Team id currently with the ball, when ESPN publishes it. */
  possessionTeamId: string | null;
  /** e.g. "3rd & 6 at FSU 21". Null outside live play. */
  downDistance: string | null;
  isRedZone: boolean;
  conferenceGame: boolean;
  /** NFL: both teams in the same division. Meaningless for college. */
  divisionGame: boolean;
  neutralSite: boolean;
  venue: string | null;
  odds: string | null;
  /** Absolute point spread. Sign is meaningless here; `odds` carries the favourite. */
  spread: number | null;
  /** Signed spread relative to the home team. Negative means home was favoured. */
  homeSpread: number | null;
  overUnder: number | null;
  lastPlay: string | null;
  score: ScoreBreakdown | null;
  /** Pregame 0..100 rating. Set for games that have not kicked off. */
  anticipation: number | null;
  /** Pregame closing spread (home-relative), retained after kickoff. */
  pregameSpread: number | null;
  /** Human form of that line, e.g. "SMU -3". */
  pregameOdds: string | null;
  tags: string[];
}

/** A television lineup the viewer might be on, from the listings provider. */
export interface Provider {
  lineupId: string;
  name: string;
  location: string;
  type: string;
  device: string;
}

export interface Snapshot {
  league: League;
  updatedAt: string;
  season: number | null;
  week: number | null;
  live: Game[];
  upcoming: Game[];
  recent: Game[];
  error: string | null;
  /**
   * The frontend bundle this server is serving, so an open board notices a deploy
   * on its next poll rather than asking a separate question on a timer.
   */
  build: string | null;
  /**
   * The viewer's resolved market. `detected` means it came from the network
   * rather than from them typing it, which is worth saying out loud so a wrong
   * guess is obviously theirs to correct.
   */
  market: {
    zip: string;
    stations: string[];
    detected: boolean;
    city: string | null;
  } | null;
}
