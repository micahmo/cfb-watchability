/**
 * Tracks recent win-probability movement per game.
 *
 * A game that has swung hard in the last few minutes is worth flipping to even
 * if it looks settled at this instant, so we keep a short rolling history and
 * sum the absolute movement across it.
 */

interface Sample {
  t: number;
  wp: number;
}

const WINDOW_MS = 15 * 60 * 1000;
/** Ignore sub-noise jitter so a stalled drive does not read as volatility. */
const MIN_DELTA = 0.005;
const STALE_MS = 6 * 60 * 60 * 1000;

export class SwingStore {
  private history = new Map<string, Sample[]>();
  private lastSeen = new Map<string, number>();

  record(gameId: string, winProb: number | null, now = Date.now()): void {
    this.lastSeen.set(gameId, now);
    if (winProb === null) return;

    const samples = this.history.get(gameId) ?? [];
    const previous = samples[samples.length - 1];
    if (!previous || Math.abs(previous.wp - winProb) >= MIN_DELTA) {
      samples.push({ t: now, wp: winProb });
    }

    const cutoff = now - WINDOW_MS;
    while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
    this.history.set(gameId, samples);
  }

  /** Cumulative absolute win-probability change inside the rolling window. */
  movement(gameId: string): number {
    const samples = this.history.get(gameId);
    if (!samples || samples.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < samples.length; i += 1) {
      total += Math.abs(samples[i].wp - samples[i - 1].wp);
    }
    return total;
  }

  prune(now = Date.now()): void {
    for (const [id, seen] of this.lastSeen) {
      if (now - seen > STALE_MS) {
        this.lastSeen.delete(id);
        this.history.delete(id);
      }
    }
  }
}
