import { fetchScoreboard, fetchPregameLine } from "./dist-server/server/espn.js";
import { scoreGame } from "./dist-server/server/scoring.js";
import { PROFILES, combine, DEFAULT_PROFILE } from "./dist-server/shared/weights.js";

const DIV = { BUF:"AE",MIA:"AE",NE:"AE",NYJ:"AE", BAL:"AN",CIN:"AN",CLE:"AN",PIT:"AN",
  HOU:"AS",IND:"AS",JAX:"AS",TEN:"AS", DEN:"AW",KC:"AW",LV:"AW",LAC:"AW",
  DAL:"NE",NYG:"NE",PHI:"NE",WSH:"NE", CHI:"NN",DET:"NN",GB:"NN",MIN:"NN",
  ATL:"NS",CAR:"NS",NO:"NS",TB:"NS", ARI:"NW",LAR:"NW",SF:"NW",SEA:"NW" };
const secs = (c) => { const [m, s] = String(c ?? "0:00").split(":").map(Number); return (m||0)*60 + (s||0); };

const SUNDAYS = ["20250928", "20251019", "20251116", "20251207"];
const curves = [];

for (const d of SUNDAYS) {
  const { games } = await fetchScoreboard({ league: "nfl", dates: d, limit: 100 });
  for (const g of games.filter((x) => x.state === "post")) {
    let line = null;
    try { line = await fetchPregameLine("nfl", g.id); } catch {}
    let s; try { s = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${g.id}`, { signal: AbortSignal.timeout(20000) })).json(); } catch { continue; }
    const wp = s.winprobability; const plays = s.drives?.previous?.flatMap((dr) => (dr.plays ?? []).map((p) => ({ ...p, team: dr.team }))) ?? [];
    if (!Array.isArray(wp) || !wp.length || !plays.length) continue;
    const byId = new Map(wp.map((w) => [String(w.playId), w.homeWinPercentage]));
    const divisionGame = DIV[g.home.abbrev] !== undefined && DIV[g.home.abbrev] === DIV[g.away.abbrev];
    const kick = Date.parse(g.startDate);
    const hist = []; const points = [];
    for (const p of plays) {
      const period = p.period?.number ?? 0; if (period < 1) continue;
      const cs = secs(p.clock?.displayValue); const prob = byId.get(String(p.id)); if (prob === undefined) continue;
      const elapsed = (period - 1) * 900 + (900 - cs);
      hist.push({ elapsed, prob }); while (hist.length && elapsed - hist[0].elapsed > 900) hist.shift();
      let mv = 0; for (let i = 1; i < hist.length; i++) mv += Math.abs(hist[i].prob - hist[i-1].prob);
      const b = scoreGame({ league: "nfl", period, clockSeconds: cs,
        home: { ...g.home, score: p.homeScore ?? 0 }, away: { ...g.away, score: p.awayScore ?? 0 },
        homeWinProb: prob, conferenceGame: false, divisionGame, startDate: g.startDate,
        swingMovement: mv, possessionTeamId: p.team?.id ? String(p.team.id) : null,
        network: g.broadcast, homeSpread: line?.homeSpread ?? null, overUnder: line?.overUnder ?? null });
      points.push({ period, cs, wall: kick + elapsed * 3.3 * 1000, total: combine(b, PROFILES[DEFAULT_PROFILE], b.maxTotal) });
    }
    if (points.length) curves.push({ date: d, name: g.shortName, points, kick, end: points[points.length-1].wall, hadLine: line !== null });
  }
  console.log(`${d}: ${curves.filter((c) => c.date === d).length} curves`);
}

console.log(`\ntotal ${curves.length} games, ${curves.filter((c)=>c.hadLine).length} with a closing line`);
const liveAt = (t, ex, d) => curves.filter((c) => c !== ex && c.date === d && t >= c.kick && t <= c.end).length;

for (const [T, gate] of [[70,60],[75,60],[80,60],[75,180]]) {
  const per = new Map();
  for (const c of curves) {
    const i = c.points.findIndex((p) => p.total >= T && ((4 - Math.min(p.period,4))*900 + p.cs) >= gate);
    if (i === -1) continue;
    const p = c.points[i];
    if (!per.has(c.date)) per.set(c.date, []);
    per.get(c.date).push(`${c.name} Q${p.period} ${Math.floor(p.cs/60)}:${String(p.cs%60).padStart(2,"0")} (${p.total.toFixed(0)}, ${liveAt(p.wall, c, c.date)} others live)`);
  }
  const counts = SUNDAYS.map((d) => (per.get(d) ?? []).length);
  console.log(`\nT=${T}, ${gate}s gate -> per Sunday: ${counts.join(", ")}  (avg ${(counts.reduce((a,b)=>a+b,0)/SUNDAYS.length).toFixed(1)})`);
  for (const d of SUNDAYS) for (const line of (per.get(d) ?? []).slice(0,4)) console.log(`    ${d}  ${line}`);
}
console.log("\npeak score distribution:");
const peaks = curves.map((c) => Math.max(...c.points.map((p) => p.total))).sort((a,b)=>b-a);
console.log("  top 10:", peaks.slice(0,10).map((p)=>p.toFixed(0)).join(", "));
console.log("  median:", peaks[Math.floor(peaks.length/2)].toFixed(1));
