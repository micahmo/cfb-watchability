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

export interface Snapshot {
  league: League;
  updatedAt: string;
  season: number | null;
  week: number | null;
  live: Game[];
  upcoming: Game[];
  recent: Game[];
  error: string | null;
}
