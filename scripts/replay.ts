/**
 * Replays a finished game play-by-play through the live scoring model.
 *
 * Feed it an ESPN summary payload and it prints what the board would have shown
 * at every snap. This is how the missing clutch term was found: the model scored
 * the 2026 Western Michigan at Michigan finish a 10 out of 100 while a last-second
 * touchdown was in the air, because ESPN win probability had Michigan at 1%.
 *
 * Usage:
 *   curl -s "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401858428" -o game.json
 *   HOME_CONF=5 AWAY_CONF=15 HOME_RANK=16 npx tsx scripts/replay.ts game.json
 *
 * The summary endpoint omits conferenceId and curatedRank, which the scoreboard
 * endpoint does carry, so pass them via env to get true production numbers.
 */
import fs from "node:fs";
import { scoreGame, gameProgress } from "../server/scoring.js";
import type { TeamSide } from "../shared/types.js";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

interface Play { id: string; period: number; clockSeconds: number; away: number; home: number; text: string; possession: string | null; }
const plays = new Map<string, Play>();
for (const drive of raw.drives?.previous ?? []) {
  for (const p of drive.plays ?? []) {
    const [m, s] = String(p.clock?.displayValue ?? "0:00").split(":").map(Number);
    plays.set(String(p.id), {
      id: String(p.id), period: p.period?.number ?? 0, clockSeconds: (m || 0) * 60 + (s || 0),
      away: p.awayScore ?? 0, home: p.homeScore ?? 0, text: p.text ?? "",
      possession: p.start?.team?.id != null ? String(p.start.team.id) : null,
    });
  }
}

const comps = raw.header?.competitions?.[0]?.competitors ?? [];
const meta = (side: "home" | "away") => comps.find((c: any) => c.homeAway === side);
const side = (s: "home" | "away", score: number): TeamSide => {
  const m = meta(s);
  return {
    id: String(m?.team?.id ?? s), abbrev: m?.team?.abbreviation ?? s, name: m?.team?.name ?? s,
    displayName: m?.team?.displayName ?? s, logo: null, color: "888888", altColor: "444444",
    score,
    rank:
      Number(s === "home" ? process.env.HOME_RANK : process.env.AWAY_RANK) ||
      (m?.curatedRank?.current && m.curatedRank.current <= 25 ? m.curatedRank.current : null),
    record: "", homeAway: s,
    conferenceId:
      (s === "home" ? process.env.HOME_CONF : process.env.AWAY_CONF) ??
      (m?.team?.conferenceId != null ? String(m.team.conferenceId) : null),
  };
};

const wp: Array<{ playId: string; homeWinPercentage: number }> = raw.winprobability ?? [];
// Swing in production is a 15-minute wall-clock window. Here we approximate it
// with the trailing 15 plays, which is the same idea on the only axis we have.
const SWING_PLAYS = 15;
const NETWORK: string | null = raw.header?.competitions?.[0]?.broadcasts?.[0]?.media?.shortName
  ?? raw.broadcasts?.[0]?.media?.shortName ?? null;

const rows: Array<{ t: string; score: number; clutch: number; prom: number; wpHome: number; away: number; home: number; text: string; tension: number; upset: number }> = [];
for (let i = 0; i < wp.length; i++) {
  const play = plays.get(String(wp[i].playId));
  if (!play || play.period === 0) continue;
  let movement = 0;
  for (let j = Math.max(1, i - SWING_PLAYS + 1); j <= i; j++) {
    movement += Math.abs(wp[j].homeWinPercentage - wp[j - 1].homeWinPercentage);
  }
  const b = scoreGame({
    period: play.period, clockSeconds: play.clockSeconds,
    home: side("home", play.home), away: side("away", play.away),
    homeWinProb: wp[i].homeWinPercentage, conferenceGame: false, swingMovement: movement,
    possessionTeamId: play.possession, network: NETWORK,
  });
  rows.push({
    t: `Q${play.period} ${Math.floor(play.clockSeconds / 60)}:${String(play.clockSeconds % 60).padStart(2, "0")}`,
    score: b.total, clutch: b.clutch, prom: b.prominence, wpHome: wp[i].homeWinPercentage, away: play.away, home: play.home,
    text: play.text, tension: b.tension, upset: b.upset,
  });
}

const peak = rows.reduce((a, b) => (b.score > a.score ? b : a), rows[0]);
console.log(`plays scored: ${rows.length}`);
console.log(`PEAK: ${peak.score} at ${peak.t}  (${peak.away}-${peak.home}, homeWP ${(peak.wpHome * 100).toFixed(0)}%)`);
console.log(`  play: ${peak.text.slice(0, 100)}`);
console.log(`\n--- fourth quarter, every play ---`);
console.log(`network: ${NETWORK} | prominence: ${rows[0]?.prom.toFixed(2)}`);
console.log("time      score  homeWP  away-home  tension clutch upset  play");
for (const r of rows.filter((r) => r.t.startsWith("Q4"))) {
  console.log(
    `${r.t.padEnd(9)} ${String(r.score).padStart(5)}  ${(r.wpHome * 100).toFixed(0).padStart(5)}%  ${String(r.away + "-" + r.home).padStart(7)}   ${r.tension.toFixed(2)}   ${r.clutch.toFixed(2)}   ${r.upset.toFixed(2)}   ${r.text.slice(0, 62)}`,
  );
}
