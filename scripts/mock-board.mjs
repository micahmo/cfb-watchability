/**
 * Serves the built board against a fabricated slate, for capturing the README
 * screenshots.
 *
 * Screenshots need a busy live board, and a live board only exists while games
 * are being played. Waiting for a Sunday to photograph a UI change is not a
 * workflow, and the alternative of shipping stale images is worse: the pair in
 * docs/ went three features out of date before anyone noticed.
 *
 * The scores here are invented but everything around them is real. Teams,
 * records, lines and networks come from the live ESPN slate, and the ratings are
 * produced by importing the actual scoring model rather than being typed in, so
 * a screenshot cannot show a number the board would never produce.
 *
 *   npm run build
 *   node scripts/mock-board.mjs --mode live      # or: --mode upcoming
 *
 * Then open http://localhost:8799 and capture at a phone width.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchScoreboard } from "../dist-server/server/espn.js";
import { scoreGame, buildTags } from "../dist-server/server/scoring.js";
import { StandingsStore } from "../dist-server/server/standings.js";

const PORT = 8799;
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "dist");
const mode = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "live";

/**
 * Fixed so a re-run produces the same pictures, rather than a new slate each time.
 * Records are invented too: the real slate is week one, where every team is 0-0,
 * and a board full of "0-0" photographs as broken rather than as representative.
 */
const RECORDS = [
  ["4-1", 0.8],
  ["3-2", 0.6],
  ["2-3", 0.4],
  ["4-1", 0.8],
  ["3-2", 0.6],
  ["1-4", 0.2],
  ["5-0", 1.0],
  ["2-3", 0.4],
  ["3-2", 0.6],
  ["4-1", 0.8],
  ["2-3", 0.4],
  ["3-2", 0.6],
];
const SITUATIONS = [
  { period: 4, clock: 96, home: 27, away: 24, wp: 0.52, down: "3rd & 4 at 38", red: false },
  { period: 4, clock: 214, home: 31, away: 28, wp: 0.44, down: "2nd & 7 at 45", red: false },
  { period: 4, clock: 42, home: 20, away: 17, wp: 0.61, down: "1st & 10 at 22", red: true },
  { period: 3, clock: 508, home: 21, away: 21, wp: 0.5, down: "2nd & 3 at 41", red: false },
  { period: 4, clock: 631, home: 17, away: 14, wp: 0.55, down: "3rd & 8 at 33", red: false },
  { period: 3, clock: 122, home: 24, away: 23, wp: 0.47, down: "1st & 10 at 50", red: false },
];

function clockLabel(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function liveSlate(league) {
  const { games, season, week } = await fetchScoreboard({ league, limit: 200 });
  if (league === "nfl") await new StandingsStore().enrich(games);
  /*
   * Only games the fabricated scores could plausibly belong to. Week one is full
   * of FCS visitors at 45-point underdogs, and a 24-23 fourth quarter in one of
   * those reads as nonsense: the model correctly screams UPSET ALERT at every
   * card, and the picture stops describing a normal Saturday. Close lines first,
   * ranked teams ahead of unranked, so the slate looks like one worth watching.
   */
  const pool = games
    .filter((g) => g.state === "pre" && g.homeSpread !== null && Math.abs(g.homeSpread) <= 10)
    .sort((a, b) => {
      const ranked = (g) => Number(g.home.rank !== null) + Number(g.away.rank !== null);
      return ranked(b) - ranked(a) || Math.abs(a.homeSpread) - Math.abs(b.homeSpread);
    })
    .slice(0, SITUATIONS.length);

  return pool.map((raw, i) => {
    const s = SITUATIONS[i % SITUATIONS.length];
    const [homeRecord, homeWinPct] = RECORDS[(i * 2) % RECORDS.length];
    const [awayRecord, awayWinPct] = RECORDS[(i * 2 + 1) % RECORDS.length];
    const game = {
      ...raw,
      state: "in",
      period: s.period,
      clock: clockLabel(s.clock),
      clockSeconds: s.clock,
      statusDetail: `${clockLabel(s.clock)} - ${s.period}${s.period === 3 ? "rd" : "th"}`,
      statusName: "STATUS_IN_PROGRESS",
      home: { ...raw.home, score: s.home, record: homeRecord, winPct: homeWinPct },
      away: { ...raw.away, score: s.away, record: awayRecord, winPct: awayWinPct },
      homeWinProb: s.wp,
      margin: Math.abs(s.home - s.away),
      totalPoints: s.home + s.away,
      possessionTeamId: i % 2 === 0 ? raw.home.id : raw.away.id,
      downDistance: s.down,
      isRedZone: s.red,
      lastPlay: null,
    };
    // The real model, so the ratings are ones the board could actually produce.
    const score = scoreGame({
      league,
      period: game.period,
      clockSeconds: game.clockSeconds,
      home: game.home,
      away: game.away,
      homeWinProb: game.homeWinProb,
      conferenceGame: game.conferenceGame,
      divisionGame: game.divisionGame,
      startDate: game.startDate,
      swingMovement: 0.18,
      possessionTeamId: game.possessionTeamId,
      network: game.broadcast,
      homeSpread: game.homeSpread,
      overUnder: game.overUnder,
    });
    const full = { ...game, score, anticipation: null, pregameSpread: game.homeSpread, pregameOdds: game.odds, tags: [] };
    full.tags = buildTags(full, score);
    return { full, season, week };
  });
}

const cache = new Map();

async function snapshot(league) {
  const hit = cache.get(league);
  if (hit) return { ...hit, updatedAt: new Date().toISOString() };
  const live = mode === "live" ? await liveSlate(league) : [];
  const { games, season, week } = await fetchScoreboard({ league, limit: 200 });
  if (league === "nfl") await new StandingsStore().enrich(games);
  const snap = {
    league,
    updatedAt: new Date().toISOString(),
    season: live[0]?.season ?? season,
    week: live[0]?.week ?? week,
    live: live.map((g) => g.full).sort((a, b) => b.score.total - a.score.total),
    upcoming: [],
    recent: [],
    market: null,
    error: null,
  };
  if (mode === "upcoming") {
    const real = await fetch(
      `http://127.0.0.1:8790/api/snapshot?league=${league}&zip=10001`,
    ).then((r) => r.json());
    snap.upcoming = real.upcoming;
    snap.market = real.market;
  }
  cache.set(league, snap);
  return { ...snap, updatedAt: new Date().toISOString() };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

http
  .createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/api/snapshot") {
      const league = new URL(req.url, "http://x").searchParams.get("league") === "cfb" ? "cfb" : "nfl";
      void snapshot(league).then((s) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(s));
      });
      return;
    }
    const candidate = path.resolve(distDir, "." + decodeURIComponent(url));
    const target = candidate.startsWith(distDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(distDir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
  })
  .listen(PORT, () => console.log(`[mock] ${mode} board on http://localhost:${PORT}`));
