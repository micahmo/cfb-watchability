import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RateLimitError, fetchPregameLine, fetchScoreboard, type RawGame } from "./espn.js";
import { LineStore } from "./lines.js";
import { anticipationScore, buildTags, scoreGame } from "./scoring.js";
import { SwingStore } from "./store.js";
import type { Game, Snapshot } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 8787);
/** Bind all interfaces by default so other devices on the LAN can reach the board. */
const HOST = process.env.HOST ?? "0.0.0.0";
const POLL_MS = Number(process.env.POLL_MS ?? 30_000);
/** With nothing live there is nothing to refresh, so back right off. */
const IDLE_POLL_MS = Number(process.env.IDLE_POLL_MS ?? 5 * 60_000);
const MAX_BACKOFF_MS = 15 * 60_000;
const GROUPS = process.env.ESPN_GROUPS ?? "80";
/** YYYYMMDD, or a YYYYMMDD-YYYYMMDD range. Unset means ESPN's current week. */
const DATES = process.env.ESPN_DATES || undefined;
/** How far back the "just finished" recap reaches. Widen it to replay an old slate. */
const RECENT_WINDOW_MS = Number(process.env.RECENT_WINDOW_HOURS ?? 10) * 60 * 60 * 1000;
/** Generous cap: the client groups these by day, so slicing by score alone
 *  here would silently drop a whole day off the planning list. */
const MAX_UPCOMING = 60;
/** The schedule barely moves, so it is fetched far less often than the scores. */
const SCHEDULE_POLL_MS = Number(process.env.SCHEDULE_POLL_MS ?? 10 * 60 * 1000);
/** How many days ahead the planning list looks. */
const SCHEDULE_DAYS = Number(process.env.SCHEDULE_DAYS ?? 8);
const MAX_RECENT = 12;

const here = path.dirname(fileURLToPath(import.meta.url));
/** Built frontend location. Set explicitly in the container, where the compiled
 *  server lives at dist-server/server/ rather than beside dist/. */
const distDir = process.env.DIST_DIR
  ? path.resolve(process.env.DIST_DIR)
  : path.resolve(here, "..", "dist");

const swings = new SwingStore();
const lines = new LineStore();
/** Cap the one-off line lookups per poll so a full Saturday cannot burst. */
const MAX_LINE_LOOKUPS_PER_POLL = 4;

let consecutiveFailures = 0;
/** Non-zero only while honouring an actual HTTP 429 from ESPN. */
let rateLimitedUntil = 0;

let snapshot: Snapshot = {
  updatedAt: new Date(0).toISOString(),
  season: null,
  week: null,
  live: [],
  upcoming: [],
  recent: [],
  error: null,
};

async function backfillLines(live: RawGame[]): Promise<void> {
  // Games that kicked off before this process started have no cached line, since
  // the scoreboard drops odds at kickoff. One summary call each, then never again.
  const missing = live.filter((g) => !lines.isResolved(g.id)).slice(0, MAX_LINE_LOOKUPS_PER_POLL);
  for (const game of missing) {
    try {
      const line = await fetchPregameLine(game.id);
      if (line === null) {
        lines.markUnavailable(game.id);
        continue;
      }
      lines.record(game.id, line);
      console.log(`[lines] ${game.shortName}: ${line.details ?? line.homeSpread}`);
    } catch (err) {
      lines.markUnavailable(game.id);
      console.error(`[lines] ${game.shortName} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function withScore(raw: RawGame, swingMovement: number): Game {
  // Finished games are scored as if the clock hit zero, which gives a fair
  // retrospective "how good was that one" number for the recap list.
  const period = raw.state === "post" ? Math.max(raw.period, 4) : raw.period;
  const clockSeconds = raw.state === "post" ? 0 : raw.clockSeconds;

  const line = lines.get(raw.id);
  const breakdown = scoreGame({
    homeSpread: line?.homeSpread ?? raw.homeSpread,
    period,
    clockSeconds,
    home: raw.home,
    away: raw.away,
    homeWinProb: raw.state === "post" ? null : raw.homeWinProb,
    conferenceGame: raw.conferenceGame,
    swingMovement,
    possessionTeamId: raw.possessionTeamId,
    network: raw.broadcast,
    isFinal: raw.state === "post",
  });

  const game: Game = {
    ...raw,
    score: breakdown,
    anticipation: null,
    pregameSpread: line?.homeSpread ?? raw.homeSpread,
    pregameOdds: line?.details ?? raw.odds,
    tags: [],
  };
  game.tags = buildTags(game, breakdown);
  return game;
}

function withAnticipation(raw: RawGame): Game {
  return {
    ...raw,
    score: null,
    tags: [],
    pregameSpread: raw.homeSpread,
    pregameOdds: raw.odds,
    anticipation: anticipationScore({
      spread: raw.spread,
      overUnder: raw.overUnder,
      home: raw.home,
      away: raw.away,
      network: raw.broadcast,
      conferenceGame: raw.conferenceGame,
    }),
  };
}

/**
 * Yesterday through today, rather than ESPN's "current week".
 *
 * ESPN rolls the current week over at midnight ET, which drops a still-running
 * late game out of the default scoreboard entirely: the board reported nothing
 * live while a game was actually being played. Asking by date keeps a game that
 * runs past midnight visible, and keeps it in the recap afterwards.
 */
function liveDateRange(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return `${yyyymmdd(yesterday)}-${yyyymmdd(now)}`;
}

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * ESPN's default scoreboard only covers the current week, which on a Sunday or
 * Monday means the upcoming list is empty. This looks forward explicitly so the
 * board is useful for planning, not just for right now.
 */
let scheduled: RawGame[] = [];

async function pollSchedule(): Promise<void> {
  if (DATES) return; // A pinned date is a replay; do not fetch a live schedule over it.
  try {
    const from = new Date();
    const to = new Date(Date.now() + SCHEDULE_DAYS * 24 * 60 * 60 * 1000);
    const { games } = await fetchScoreboard({
      groups: GROUPS,
      dates: `${yyyymmdd(from)}-${yyyymmdd(to)}`,
    });
    scheduled = games.filter((g) => g.state === "pre");
    console.log(`[schedule] ${scheduled.length} upcoming games over the next ${SCHEDULE_DAYS} days`);
  } catch (err) {
    console.error(`[schedule] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function poll(): Promise<void> {
  if (Date.now() < rateLimitedUntil) {
    console.log("[poll] skipped, still inside the rate-limit hold");
    return;
  }
  try {
    const { games, season, week } = await fetchScoreboard({
      groups: GROUPS,
      dates: DATES ?? liveDateRange(),
    });
    const now = Date.now();

    // Capture every line we see while a game is still pregame; the scoreboard
    // stops carrying odds the moment it kicks off.
    for (const raw of games) lines.recordFromScoreboard(raw);
    for (const raw of scheduled) lines.recordFromScoreboard(raw);
    await backfillLines(games.filter((g) => g.state === "in"));

    for (const raw of games) {
      if (raw.state === "in") swings.record(raw.id, raw.homeWinProb, now);
    }
    swings.prune(now);

    const live = games
      .filter((g) => g.state === "in")
      .map((g) => withScore(g, swings.movement(g.id)))
      .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));

    // Prefer the forward-looking fetch, falling back to whatever the current
    // week's board happens to carry.
    const upcomingSource = scheduled.length > 0 ? scheduled : games.filter((g) => g.state === "pre");
    const seen = new Set([...live, ...games.filter((g) => g.state === "post")].map((g) => g.id));
    const upcoming = upcomingSource
      .filter((g) => !seen.has(g.id))
      .map(withAnticipation)
      .sort((a, b) => (b.anticipation ?? 0) - (a.anticipation ?? 0))
      .slice(0, MAX_UPCOMING);

    const recent = games
      .filter((g) => g.state === "post" && now - Date.parse(g.startDate) < RECENT_WINDOW_MS)
      .map((g) => withScore(g, swings.movement(g.id)))
      .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0))
      .slice(0, MAX_RECENT);

    snapshot = {
      updatedAt: new Date(now).toISOString(),
      season,
      week,
      live,
      upcoming,
      recent,
      error: null,
    };
    console.log(
      `[poll] ${new Date(now).toLocaleTimeString()} live=${live.length} upcoming=${upcoming.length} recent=${recent.length}` +
        (live[0] ? ` top="${live[0].shortName}" ${live[0].score?.total}` : ""),
    );
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures += 1;
    if (err instanceof RateLimitError) {
      const wait = (err.retryAfterSeconds ?? 300) * 1000;
      rateLimitedUntil = Date.now() + Math.min(wait, MAX_BACKOFF_MS);
      console.error(`[poll] rate limited, holding off ${Math.round(wait / 1000)}s`);
    }
    const message = err instanceof Error ? err.message : String(err);
    snapshot = { ...snapshot, error: message };
    console.error(`[poll] failed (${consecutiveFailures} in a row): ${message}`);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!fs.existsSync(distDir)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("No built frontend. Run `npm run dev` for the Vite dev server, or `npm run build`.");
    return;
  }

  // decodeURIComponent throws URIError on malformed input such as "/%ZZ", which
  // took the whole process down when it was reachable from the internet.
  let requested: string;
  try {
    requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    requested = "/";
  }

  const candidate = path.resolve(distDir, "." + requested);
  // Never let a crafted path escape the dist directory. The separator matters:
  // a bare startsWith would also accept a sibling directory like "dist-secret".
  const insideDist = candidate === distDir || candidate.startsWith(distDir + path.sep);
  const target =
    insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(distDir, "index.html");

  const headers: Record<string, string> = {
    "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
  };
  // A stale service worker would pin an old app shell indefinitely.
  if (path.basename(target) === "sw.js") headers["cache-control"] = "no-cache";
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    // A malformed request must never be able to take the board down.
    console.error(`[http] request failed: ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
});

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0];

  // Read-only service: nothing here should ever accept a write.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  if (url === "/api/snapshot") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(snapshot));
    return;
  }

  if (url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: snapshot.error === null,
        updatedAt: snapshot.updatedAt,
        liveGames: snapshot.live.length,
        consecutiveFailures,
        rateLimited: Date.now() < rateLimitedUntil,
        nextPollSeconds: Math.round(nextPollDelay() / 1000),
        error: snapshot.error,
      }),
    );
    return;
  }

  serveStatic(req, res);
}

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT} (polling every ${POLL_MS / 1000}s)`);
});

/**
 * Adaptive cadence. Polling every 30 seconds around the clock is ~3k requests a
 * day against an undocumented endpoint for no benefit, since outside game windows
 * nothing changes. Fast while games are live, slow when they are not, and it wakes
 * up just after the next kickoff so a game is never missed by more than a poll.
 */
function nextPollDelay(): number {
  const now = Date.now();
  if (now < rateLimitedUntil) return rateLimitedUntil - now;
  if (consecutiveFailures > 0) {
    return Math.min(POLL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
  }
  if (snapshot.live.length > 0) return POLL_MS;

  const nextKickoff = scheduled
    .map((g) => Date.parse(g.startDate))
    .filter((t) => Number.isFinite(t) && t > now)
    .sort((a, b) => a - b)[0];
  if (nextKickoff !== undefined) {
    // Land just after kickoff rather than up to a full idle period late.
    const untilKickoff = nextKickoff - now + 15_000;
    return Math.max(POLL_MS, Math.min(IDLE_POLL_MS, untilKickoff));
  }
  return IDLE_POLL_MS;
}

async function pollLoop(): Promise<void> {
  await poll();
  const delay = nextPollDelay();
  console.log(`[poll] next in ${Math.round(delay / 1000)}s`);
  setTimeout(() => void pollLoop(), delay);
}

void pollSchedule().then(() => pollLoop());
setInterval(() => void pollSchedule(), SCHEDULE_POLL_MS);
