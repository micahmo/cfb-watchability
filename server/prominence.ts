import type { League } from "../shared/types.js";

/**
 * How much of the country cares about this game, independent of whether it is close.
 *
 * Deliberately uses the *better* of the two programs rather than the worse: one
 * blue blood is enough to put a game in the national conversation, which is why
 * Michigan losing to a MAC team is a bigger story than a great Sun Belt game.
 */

/** ESPN conference group ids, resolved from their season groups endpoint. */
const CONFERENCE_TIER: Record<string, number> = {
  "8": 1.0, // SEC
  "5": 1.0, // Big Ten
  "4": 1.0, // Big 12
  "1": 1.0, // ACC
  "18": 0.85, // FBS Independents (Notre Dame lives here)
  "151": 0.5, // American
  "17": 0.5, // Mountain West
  "9": 0.5, // Pac-12
  "15": 0.45, // MAC
  "37": 0.45, // Sun Belt
  "12": 0.45, // Conference USA
};
/** Everything else on the board is FCS. */
const FCS_TIER = 0.1;

/** Display names for the conferences worth offering as a preference. */
const CONFERENCE_NAME: Record<string, string> = {
  "8": "SEC",
  "5": "Big Ten",
  "4": "Big 12",
  "1": "ACC",
  "18": "Independents",
  "151": "American",
  "17": "Mountain West",
  "9": "Pac-12",
  "15": "MAC",
  "37": "Sun Belt",
  "12": "Conference USA",
};

export function conferenceName(conferenceId: string | null): string | null {
  if (!conferenceId) return null;
  return CONFERENCE_NAME[conferenceId] ?? null;
}

/**
 * Networks allocate their best inventory to the games they expect to draw, so the
 * broadcast slot is a strong, free proxy for how big a game is.
 */
const BROADCAST_TIER: Record<string, number> = {
  ABC: 1.0, CBS: 1.0, FOX: 1.0, NBC: 1.0,
  ESPN: 0.8, TNT: 0.7, "USA Net": 0.6, USA: 0.6,
  ESPN2: 0.55, FS1: 0.55, CBSSN: 0.5, BTN: 0.55,
  "SEC Network": 0.55, "ACC Network": 0.5, ESPNU: 0.45, CW: 0.45, Peacock: 0.5,
  "ESPN+": 0.2, "SECN+": 0.2, ACCNX: 0.2, ESPNEWS: 0.25, "Disney+": 0.4, "MW+": 0.15,
};
const DEFAULT_BROADCAST_TIER = 0.3;

export function conferenceTier(conferenceId: string | null): number {
  if (!conferenceId) return FCS_TIER;
  return CONFERENCE_TIER[conferenceId] ?? FCS_TIER;
}

export function broadcastTier(network: string | null): number {
  if (!network) return DEFAULT_BROADCAST_TIER;
  return BROADCAST_TIER[network] ?? DEFAULT_BROADCAST_TIER;
}

/** True national broadcast TV, as opposed to a cable tier or a streaming add-on. */
export function isMajorNetwork(network: string | null): boolean {
  return network !== null && broadcastTier(network) >= 1.0;
}

function rankProminence(rank: number | null): number {
  if (rank === null) return 0.15;
  if (rank <= 5) return 1.0;
  if (rank <= 15) return 0.75;
  return 0.5;
}

/**
 * NFL kickoff slot, as a stand-in for the broadcast tier.
 *
 * Every NFL game is on a major network, so which network says almost nothing.
 * What does say something is the window: a Sunday or Monday night game is the
 * only football on, while a 1pm kickoff is one of eight. Hours are local, which
 * is why the container needs TZ set to US Eastern.
 */
export function slotTier(startDate: string): number {
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return 0.5;
  const hour = d.getHours();
  if (hour >= 19) return 1.0; // Thursday, Sunday and Monday night
  if (hour >= 16) return 0.7; // the late afternoon window, a handful of games
  if (hour >= 11) return 0.5; // the early window, most of the slate
  return 0.45; // international morning kickoffs
}

/** Seeding stands in for ranking: the NFL has standings rather than a poll. */
function seedProminence(seed: number | null): number {
  if (seed === null || seed <= 0) return 0.45; // preseason, or missing
  if (seed <= 4) return 1.0; // division leaders
  if (seed <= 7) return 0.75; // in the playoff field
  if (seed <= 12) return 0.4;
  return 0.2;
}

/** A neutral 0.5 before any games are played, rather than punishing week one. */
function recordProminence(winPct: number | null): number {
  if (winPct === null) return 0.5;
  return clamp01(0.2 + 0.8 * winPct);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export interface ProminenceInputs {
  league: League;
  homeConferenceId: string | null;
  awayConferenceId: string | null;
  homeRank: number | null;
  awayRank: number | null;
  homeWinPct: number | null;
  awayWinPct: number | null;
  homeSeed: number | null;
  awaySeed: number | null;
  network: string | null;
  startDate: string;
}

export function prominenceScore(i: ProminenceInputs): number {
  if (i.league === "nfl") {
    // No conference tiers to speak of: every NFL team is a major brand, so the
    // differentiation has to come from how good the teams are and when it is on.
    const quality = Math.max(recordProminence(i.homeWinPct), recordProminence(i.awayWinPct));
    const seeding = Math.max(seedProminence(i.homeSeed), seedProminence(i.awaySeed));
    return Math.min(1, 0.4 * quality + 0.3 * seeding + 0.3 * slotTier(i.startDate));
  }

  const brand = Math.max(conferenceTier(i.homeConferenceId), conferenceTier(i.awayConferenceId));
  const rank = Math.max(rankProminence(i.homeRank), rankProminence(i.awayRank));
  const tv = broadcastTier(i.network);
  return Math.min(1, 0.4 * brand + 0.3 * rank + 0.3 * tv);
}
