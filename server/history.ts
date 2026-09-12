import fs from "node:fs";
import path from "node:path";
import type { Game, Snapshot } from "../shared/types.js";

/**
 * How often a game that is doing nothing still gets a row.
 *
 * Scoring runs on every push rebuild, which on a live Saturday is a few times a
 * second across the slate, so recording every one would be noise measured in
 * hundreds of megabytes. A minute is fine for the question this file exists to
 * answer, which is "what did the board think an hour ago", and anything that
 * actually moves the score is written immediately regardless.
 */
const HEARTBEAT_MS = 60 * 1000;
/** Rows wait this long to be written, so a burst of rebuilds costs one append. */
const FLUSH_MS = 15 * 1000;
/** Dropped rather than grow without bound if the disk stops accepting writes. */
const MAX_BUFFERED = 5000;
/**
 * Files older than this are deleted on the first write of a new day.
 *
 * Measured on a live college slate: about 40 rows a minute at 337 bytes each,
 * so roughly 11 MB for a full Saturday and well under a hundred for the window,
 * which is three weeks of football and enough to answer a question about last
 * weekend.
 */
const KEEP_DAYS = 21;

/** What a game looked like, flattened so a row is one self-contained record. */
interface Row {
  t: string;
  league: string;
  id: string;
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  state: string;
  period: number;
  clock: string;
  spread: number | null;
  wp: number | null;
  total: number;
  core: number;
  clutch: number;
  upsetTension: number;
  primary: number;
  prominence: number;
  swing: number;
  upset: number;
  stakes: number;
  pace: number;
  tags: string[];
}

/** Enough of a game to tell whether anything worth recording has changed. */
interface Mark {
  at: number;
  state: string;
  period: number;
  score: string;
  total: number;
}

/**
 * Appends what the board thought of each game, so a question asked later has
 * something to read.
 *
 * Every diagnosis on this board so far has needed the past and had to reconstruct
 * it from ESPN, which only works while a game is recent and only fully for the
 * fifth of games that carry a closing line. A local record removes both limits
 * and builds the calibration corpus as a side effect of the season happening.
 *
 * Deliberately not on the request path and deliberately unable to fail loudly: a
 * disk problem here must cost the history and nothing else.
 */
export class History {
  private readonly dir: string | null;
  private buffer: Row[] = [];
  private marks = new Map<string, Mark>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private day: string | null = null;
  private dropped = 0;

  constructor(dir: string | undefined) {
    this.dir = typeof dir === "string" && dir.length > 0 ? dir : null;
    if (this.dir === null) {
      console.log("[history] disabled: no directory configured");
      return;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      console.log(`[history] recording to ${path.join(this.dir, "history-<date>.jsonl")}`);
    } catch (err) {
      console.error(`[history] disabled: ${err instanceof Error ? err.message : err}`);
      this.dir = null;
    }
  }

  /** Called once per composed snapshot, which is far more often than it writes. */
  record(snapshot: Snapshot): void {
    if (this.dir === null) return;
    const now = Date.now();
    for (const game of [...snapshot.live, ...snapshot.recent]) {
      if (game.score === null || game.score === undefined) continue;
      const key = `${snapshot.league}:${game.id}`;
      const mark: Mark = {
        at: now,
        state: game.state,
        period: game.period,
        score: `${game.away.score}-${game.home.score}`,
        total: game.score.total,
      };
      const last = this.marks.get(key);
      // A change in anything that matters, or the heartbeat, whichever comes first.
      const changed =
        last === undefined ||
        last.state !== mark.state ||
        last.period !== mark.period ||
        last.score !== mark.score ||
        now - last.at >= HEARTBEAT_MS;
      if (!changed) continue;
      this.marks.set(key, mark);
      this.push(this.rowFor(snapshot.league, game));
    }
    this.schedule();
  }

  private rowFor(league: string, game: Game): Row {
    const s = game.score!;
    return {
      t: new Date().toISOString(),
      league,
      id: game.id,
      away: game.away.abbrev,
      home: game.home.abbrev,
      awayScore: game.away.score,
      homeScore: game.home.score,
      state: game.state,
      period: game.period,
      clock: game.clock,
      spread: game.pregameSpread,
      wp: game.homeWinProb,
      total: s.total,
      core: round(s.core),
      clutch: round(s.clutch),
      upsetTension: round(s.upsetTension),
      primary: round(s.primary),
      prominence: round(s.prominence),
      swing: round(s.swing),
      upset: round(s.upset),
      stakes: round(s.stakes),
      pace: round(s.pace),
      tags: game.tags ?? [],
    };
  }

  private push(row: Row): void {
    if (this.buffer.length >= MAX_BUFFERED) {
      this.dropped += 1;
      return;
    }
    this.buffer.push(row);
  }

  private schedule(): void {
    if (this.timer !== null || this.buffer.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.dir === null || this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    if (this.dropped > 0) {
      console.error(`[history] dropped ${this.dropped} row(s), the buffer was full`);
      this.dropped = 0;
    }
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dir, `history-${day}.jsonl`);
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFile(file, body, (err) => {
      if (err) console.error(`[history] could not append: ${err.message}`);
    });
    if (this.day !== day) {
      this.day = day;
      this.sweep();
    }
  }

  /** Drops files past the retention window, on the first write of each new day. */
  private sweep(): void {
    if (this.dir === null) return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const match = /^history-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (match === null) continue;
        if (Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
        fs.unlinkSync(path.join(this.dir, name));
        console.log(`[history] removed ${name}, past the ${KEEP_DAYS}-day window`);
      }
    } catch (err) {
      console.error(`[history] sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
