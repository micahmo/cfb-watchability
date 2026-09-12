/**
 * Sweeps the upset-drama parameterisation across every finished game that has
 * both play-by-play win probability and a closing line.
 *
 *   SCRATCH=<dir with finals-lines.json and pbp/> npx tsx scripts/calibrate-upset.ts
 */
import fs from "node:fs";
import path from "node:path";
import { scoreGame, gameProgress } from "../server/scoring.js";
import { WEIGHTS } from "../shared/weights.js";
import type { TeamSide } from "../shared/types.js";

const DIR = process.env.SCRATCH!;
const lines: any[] = JSON.parse(fs.readFileSync(path.join(DIR, "finals-lines.json"), "utf-8"));

interface Frame {
  progress: number;
  core: number; clutch: number; upsetTension: number; upset: number;
  prominence: number; swing: number; stakes: number; pace: number;
  maxTotal: number | null; decisiveness: number;
  homeScore: number; awayScore: number;
}
interface GameRun {
  id: string; name: string; homeSpread: number;
  dogWon: boolean; dogClose: boolean; bigDog: boolean; finalMargin: number;
  frames: Frame[];
}

function loadGame(meta: any): GameRun | null {
  const file = path.join(DIR, "pbp", `${meta.id}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));

  const plays = new Map<string, any>();
  for (const drive of raw.drives?.previous ?? []) {
    for (const p of drive.plays ?? []) {
      const [m, s] = String(p.clock?.displayValue ?? "0:00").split(":").map(Number);
      plays.set(String(p.id), {
        period: p.period?.number ?? 0, clockSeconds: (m || 0) * 60 + (s || 0),
        away: p.awayScore ?? 0, home: p.homeScore ?? 0,
        possession: p.start?.team?.id != null ? String(p.start.team.id) : null,
      });
    }
  }
  const comps = raw.header?.competitions?.[0]?.competitors ?? [];
  const metaOf = (s: "home" | "away") => comps.find((c: any) => c.homeAway === s);
  const side = (s: "home" | "away", score: number): TeamSide =>
    ({
      id: String(metaOf(s)?.team?.id ?? s), abbrev: metaOf(s)?.team?.abbreviation ?? s,
      name: metaOf(s)?.team?.name ?? s, displayName: metaOf(s)?.team?.displayName ?? s,
      logo: null, color: "888888", altColor: "444444", score,
      rank: metaOf(s)?.curatedRank?.current && metaOf(s).curatedRank.current <= 25
        ? metaOf(s).curatedRank.current : null,
      record: "", homeAway: s,
      conferenceId: metaOf(s)?.team?.conferenceId != null ? String(metaOf(s).team.conferenceId) : null,
    }) as TeamSide;

  const wp: Array<{ playId: string; homeWinPercentage: number }> = raw.winprobability ?? [];
  const frames: Frame[] = [];
  for (let i = 0; i < wp.length; i++) {
    const play = plays.get(String(wp[i].playId));
    if (!play || play.period === 0) continue;
    let movement = 0;
    for (let j = Math.max(1, i - 14); j <= i; j++) {
      movement += Math.abs(wp[j].homeWinPercentage - wp[j - 1].homeWinPercentage);
    }
    const b = scoreGame({
      league: "cfb", period: play.period, clockSeconds: play.clockSeconds,
      home: side("home", play.home), away: side("away", play.away),
      homeWinProb: wp[i].homeWinPercentage, conferenceGame: false, divisionGame: false,
      startDate: raw.header?.competitions?.[0]?.date ?? new Date().toISOString(),
      swingMovement: movement, possessionTeamId: play.possession, network: null,
      homeSpread: meta.homeSpread, overUnder: null, isFinal: false,
    } as any);
    frames.push({
      progress: gameProgress(play.period, play.clockSeconds),
      core: b.core, clutch: b.clutch, upsetTension: b.upsetTension, upset: b.upset,
      prominence: b.prominence, swing: b.swing, stakes: b.stakes, pace: b.pace,
      maxTotal: b.maxTotal, decisiveness: 0,
      homeScore: play.home, awayScore: play.away,
    });
  }
  if (frames.length === 0) return null;

  const homeIsDog = meta.homeSpread > 0;
  const dog = homeIsDog ? meta.home : meta.away;
  const fav = homeIsDog ? meta.away : meta.home;
  return {
    id: meta.id, name: meta.name, homeSpread: meta.homeSpread,
    dogWon: dog > fav, dogClose: fav - dog <= 3, bigDog: Math.abs(meta.homeSpread) >= 10,
    finalMargin: Math.abs(meta.home - meta.away), frames,
  };
}

const RUNS = lines.map(loadGame).filter((g): g is GameRun => g !== null);

// --- the candidate ---------------------------------------------------------

interface Params { mode: "current" | "drama" | "both"; share: number; minSpread: number; gate: boolean }

/**
 * Points the underdog is behind by, negative when it leads.
 *
 * The gate this feeds is the whole difference between an upset and a cover: a
 * 45.5-point dog losing by 28 is maximal on `upset`, because that is seventeen
 * points better than the line's pace, and is not a game anybody wants sent to
 * them. Being level, ahead, or within one score is what makes the surprise
 * something that can still turn into a result.
 */
function dogDeficit(g: GameRun, f: Frame): number {
  const homeIsDog = g.homeSpread > 0;
  return homeIsDog ? f.awayScore - f.homeScore : f.homeScore - f.awayScore;
}

function totalFor(g: GameRun, f: Frame, p: Params): number {
  const spread = Math.abs(g.homeSpread);
  const inReach = !p.gate || dogDeficit(g, f) <= 8;
  const drama = spread >= p.minSpread && inReach ? f.upset * p.share : 0;
  const primary =
    p.mode === "current" ? Math.max(f.core, f.clutch, f.upsetTension)
    : p.mode === "drama" ? Math.max(f.core, f.clutch, drama)
    : Math.max(f.core, f.clutch, f.upsetTension, drama);
  const w = WEIGHTS;
  const raw = 100 * (w.primary * primary + w.prominence * f.prominence + w.swing * f.swing
    + w.upset * f.upset + w.stakes * f.stakes + w.pace * f.pace);
  const capped = f.maxTotal === null ? raw : Math.min(raw, f.maxTotal);
  return Math.round(Math.max(0, Math.min(100, capped)) * 10) / 10;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);


// --- what actually matters -------------------------------------------------
//
// Peak rating measures the moment a game was closest, which `core` already
// handles. The failure being tested is the *late* stretch of a game whose
// underdog is beating the line, so the metric is the rating over the part of the
// game a viewer would still have time to switch to.

const LATE = 0.75;
const lateFrames = (g: GameRun) => g.frames.filter((f) => f.progress >= LATE);

/** Underdog clearly ahead of the line's pace late: the case under test. */
const liveUpsets = RUNS.filter((g) => {
  if (Math.abs(g.homeSpread) < 10) return false;
  const late = lateFrames(g);
  return late.length > 0 && late.some((f) => f.upset >= 0.5);
});
/** Real underdog, comfortably beaten: must stay down. */
const duds = RUNS.filter((g) => Math.abs(g.homeSpread) >= 10 && g.finalMargin >= 25 && !g.dogWon);

const meanLate = (g: GameRun, p: Params) => {
  const late = lateFrames(g);
  return late.length ? late.reduce((a, f) => a + totalFor(g, f, p), 0) / late.length : 0;
};

console.log(`corpus: ${RUNS.length} games with line + play-by-play`);
console.log(`  big dog beating the line late: ${liveUpsets.length}`);
console.log(`  big dog run off the field:     ${duds.length}`);
console.log();

/**
 * Internal consistency, which needs no ground truth at all: how far the rating
 * jumps across the final whistle. `decisiveness` already scores a finished upset
 * at `upset * 0.75`, so any gap between the last live frame and that is the model
 * contradicting itself.
 */
function whistleGap(g: GameRun, p: Params): number | null {
  const last = g.frames[g.frames.length - 1];
  if (!g.dogWon || last.upset < 0.35) return null;
  const asFinal = (() => {
    const w = WEIGHTS;
    const primary = last.upset * 0.75;
    return 100 * (w.primary * primary + w.prominence * last.prominence + w.swing * last.swing
      + w.upset * last.upset + w.stakes * last.stakes + w.pace * last.pace);
  })();
  return asFinal - totalFor(g, last, p);
}

const header = "mode      share  floor | upsets late   duds late | whistle gap";
console.log(header);
console.log("-".repeat(header.length));
const sweeps: Params[] = [{ mode: "current", share: 0, minSpread: 0, gate: true }];
for (const share of [0.5, 0.6, 0.7, 0.75, 0.85, 1.0])
  sweeps.push({ mode: "both", share, minSpread: 10, gate: true });
sweeps.push({ mode: "both", share: 0.75, minSpread: 10, gate: false });
for (const p of sweeps) {
  const u = mean(liveUpsets.map((g) => meanLate(g, p)));
  const d = mean(duds.map((g) => meanLate(g, p)));
  const gaps = RUNS.map((g) => whistleGap(g, p)).filter((x): x is number => x !== null);
  console.log(
    `${p.mode.padEnd(9)} ${String(p.share).padStart(5)}  ${String(p.minSpread).padStart(5)} |` +
      ` ${u.toFixed(1).padStart(11)} ${d.toFixed(1).padStart(10)} |` +
      ` ${mean(gaps).toFixed(1).padStart(11)}`,
  );
}

console.log("\nper game, mean rating over the last quarter (>=10pt dog beating the line late)");
console.log("  game               spread  dog   current -> share .75");
for (const g of liveUpsets.sort((a, b) => Math.abs(b.homeSpread) - Math.abs(a.homeSpread))) {
  const cur = meanLate(g, { mode: "current", share: 0, minSpread: 0, gate: true });
  const cand = meanLate(g, { mode: "both", share: 0.75, minSpread: 10, gate: true });
  console.log(
    `  ${g.name.padEnd(18)} ${String(Math.abs(g.homeSpread)).padStart(5)}  ` +
      `${(g.dogWon ? "won " : g.dogClose ? "close" : "lost").padEnd(5)} ` +
      `${cur.toFixed(1).padStart(7)} -> ${cand.toFixed(1).padStart(5)}`,
  );
}
