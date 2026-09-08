import type { RawGame } from "./espn.js";

/**
 * Caches each game's pregame closing line.
 *
 * Deliberately the *pregame* number, never a live one. A live line moves with the
 * game, so by the time an underdog has drawn level the line has already caught up
 * and the surprise has been priced away. The closing line is the frozen record of
 * what was expected before kickoff, which is exactly what "is this an upset"
 * needs. It never changes once a game starts, so one fetch per game is enough.
 */
export interface PregameLine {
  /** Spread relative to the home team. Negative means the home team was favoured. */
  homeSpread: number;
  overUnder: number | null;
  details: string | null;
}

export class LineStore {
  private lines = new Map<string, PregameLine>();
  /** Games we have already tried and failed to price, so we stop asking. */
  private unavailable = new Set<string>();

  get(gameId: string): PregameLine | null {
    return this.lines.get(gameId) ?? null;
  }

  has(gameId: string): boolean {
    return this.lines.has(gameId);
  }

  /** True once we have either a line or a settled answer that there is none. */
  isResolved(gameId: string): boolean {
    return this.lines.has(gameId) || this.unavailable.has(gameId);
  }

  markUnavailable(gameId: string): void {
    this.unavailable.add(gameId);
  }

  /** Records from the scoreboard, which carries odds for games yet to kick off. */
  recordFromScoreboard(game: RawGame): void {
    if (this.lines.has(game.id) || game.spread === null) return;
    this.lines.set(game.id, {
      homeSpread: game.homeSpread ?? game.spread,
      overUnder: game.overUnder,
      details: game.odds,
    });
  }

  record(gameId: string, line: PregameLine): void {
    this.lines.set(gameId, line);
    this.unavailable.delete(gameId);
  }

  get size(): number {
    return this.lines.size;
  }
}
