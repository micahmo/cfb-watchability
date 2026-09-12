import type { ScoreComponents } from "./types.js";

export interface Weights {
  primary: number;
  prominence: number;
  swing: number;
  upset: number;
  stakes: number;
  pace: number;
}

/**
 * Sums to 1, so a total is always 0..100.
 *
 * One fixed weighting. Three selectable profiles shipped for a while, trading
 * closeness against prominence, and were removed: measured against a full
 * Saturday of finished games the top-ranked game was identical under all three,
 * nothing moved more than two positions, and a control that cannot change the
 * answer is not a control.
 */
export const WEIGHTS: Weights = {
  primary: 0.58,
  prominence: 0.18,
  swing: 0.08,
  upset: 0.07,
  stakes: 0.05,
  pace: 0.04,
};

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
