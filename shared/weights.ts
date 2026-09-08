import type { ScoreComponents } from "./types.js";

export type ProfileName = "balanced" | "bestGame" | "biggestGame";

export interface Weights {
  primary: number;
  prominence: number;
  swing: number;
  upset: number;
  stakes: number;
  pace: number;
}

/**
 * Each profile sums to 1, so a total is always 0..100 and profiles stay
 * comparable. "How close is it" versus "how much does it matter" is a taste
 * question, so it is a dial rather than a fixed answer.
 */
export const PROFILES: Record<ProfileName, Weights> = {
  bestGame: { primary: 0.74, prominence: 0.04, swing: 0.09, upset: 0.06, stakes: 0.03, pace: 0.04 },
  balanced: { primary: 0.58, prominence: 0.18, swing: 0.08, upset: 0.07, stakes: 0.05, pace: 0.04 },
  biggestGame: { primary: 0.42, prominence: 0.36, swing: 0.06, upset: 0.06, stakes: 0.06, pace: 0.04 },
};

export const PROFILE_LABELS: Record<ProfileName, string> = {
  bestGame: "Best game",
  balanced: "Balanced",
  biggestGame: "Biggest game",
};

export const DEFAULT_PROFILE: ProfileName = "balanced";

export function combine(c: ScoreComponents, w: Weights, maxTotal: number | null = null): number {
  const raw =
    100 *
    (w.primary * c.primary +
      w.prominence * c.prominence +
      w.swing * c.swing +
      w.upset * c.upset +
      w.stakes * c.stakes +
      w.pace * c.pace);
  const capped = maxTotal === null ? raw : Math.min(raw, maxTotal);
  return Math.round(Math.max(0, Math.min(100, capped)) * 10) / 10;
}
