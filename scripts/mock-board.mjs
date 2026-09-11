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
 * Records, five games into a season.
 *
 * Not arbitrary, and this matters more than it looks. The first version handed
 * out records by position in the list, which produced a 4-1 Titans and pushed
 * Bills at Texans down the board. A reader does not know the records are props:
 * they see the app rating a bad matchup over a good one and conclude it cannot
 * judge football. Fabricated inputs have to be plausible ones or the screenshot
 * argues against the thing it is advertising.
 *
 * Full-season win totals are Conor Orr's 2026 predictions for SI, scaled to five
 * games. College is derived from the AP rank on the card instead, so a number one
 * seed does not appear at 3-2.
 */
const NFL_WINS_2026 = {
  BUF: 10, NE: 9, MIA: 5, NYJ: 4, BAL: 11, CIN: 9, PIT: 6, CLE: 5,
  HOU: 13, JAX: 9, TEN: 6, IND: 6, LAC: 11, DEN: 10, KC: 9, LV: 5,
  DAL: 12, PHI: 9, WSH: 9, WAS: 9, NYG: 6, DET: 14, GB: 10, CHI: 10,
  MIN: 9, CAR: 10, TB: 7, ATL: 6, NO: 6, LAR: 13, SEA: 11, SF: 10, ARI: 2,
};

const GAMES_IN = 5;

function recordFor(league, team) {
  let wins;
  if (league === "nfl") {
    const season = NFL_WINS_2026[team.abbrev];
    wins = season === undefined ? 2 : Math.round((season / 17) * GAMES_IN);
  } else if (team.rank !== null) {
    // Top of the poll is undefeated or close; the tail of it has a loss or two.
    wins = team.rank <= 5 ? GAMES_IN : team.rank <= 12 ? 4 : 4;
  } else {
    wins = 2;
  }
  wins = Math.max(0, Math.min(GAMES_IN, wins));
  return [`${wins}-${GAMES_IN - wins}`, wins / GAMES_IN];
}

const SITUATIONS = [
  { period: 4, clock: 96, home: 27, away: 24, wp: 0.52, down: "3rd & 4 at 38", red: false },
  { period: 4, clock: 214, home: 31, away: 28, wp: 0.44, down: "2nd & 7 at 45", red: false },
  { period: 4, clock: 42, home: 20, away: 17, wp: 0.61, down: "1st & 10 at 22", red: true },
  { period: 3, clock: 508, home: 21, away: 21, wp: 0.5, down: "2nd & 3 at 41", red: false },
  { period: 4, clock: 631, home: 17, away: 14, wp: 0.55, down: "3rd & 8 at 33", red: false },
  { period: 3, clock: 122, home: 24, away: 23, wp: 0.47, down: "1st & 10 at 50", red: false },
];

/**
 * Best matchup first, so the most dramatic situation lands on it.
 *
 * The situations are assigned in order, and the first is a one-score game inside
 * two minutes, which will top the board whatever it is attached to. Attached to
 * the tightest line on the slate it produced a hero card of 1-4 Jets at 2-3
 * Titans: correct by the model, and a poor advertisement for it. A reader
 * judging a screenshot is judging the app's taste, so the drama goes to a game
 * they would agree deserves it.
 */
function quality(league, game) {
  if (league === "nfl") {
    return (NFL_WINS_2026[game.home.abbrev] ?? 6) + (NFL_WINS_2026[game.away.abbrev] ?? 6);
  }
  const rank = (side) => (side.rank === null ? 0 : 26 - side.rank);
  return rank(game.home) + rank(game.away);
}

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
    .sort((a, b) => quality(league, b) - quality(league, a) || Math.abs(a.homeSpread) - Math.abs(b.homeSpread))
    .slice(0, SITUATIONS.length);

  return pool.map((raw, i) => {
    const s = SITUATIONS[i % SITUATIONS.length];
    const [homeRecord, homeWinPct] = recordFor(league, raw.home);
    const [awayRecord, awayWinPct] = recordFor(league, raw.away);
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
      // ESPN times out occasionally. Unhandled, that rejection kills the whole
      // script mid-capture, which is a poor way to find out.
      void snapshot(league)
        .then((s) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(s));
        })
        .catch((err) => {
          console.error(`[mock] ${league} failed: ${err instanceof Error ? err.message : err}`);
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "upstream failed, retry" }));
        });
      return;
    }
    const candidate = path.resolve(distDir, "." + decodeURIComponent(url));
    const target = candidate.startsWith(distDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(distDir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
  })
  .listen(PORT, () => console.log(`[mock] ${mode} board on http://localhost:${PORT}`));
