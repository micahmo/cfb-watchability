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

export interface ProminenceInputs {
  homeConferenceId: string | null;
  awayConferenceId: string | null;
  homeRank: number | null;
  awayRank: number | null;
  network: string | null;
}

export function prominenceScore(i: ProminenceInputs): number {
  const brand = Math.max(conferenceTier(i.homeConferenceId), conferenceTier(i.awayConferenceId));
  const rank = Math.max(rankProminence(i.homeRank), rankProminence(i.awayRank));
  const tv = broadcastTier(i.network);
  return Math.min(1, 0.4 * brand + 0.3 * rank + 0.3 * tv);
}
