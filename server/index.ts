import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LeaguePoller } from "./poller.js";
import { StandingsStore } from "./standings.js";
import { History } from "./history.js";
import { ListingsStore } from "./listings.js";
import { SubscriptionStore, CATEGORIES, type Category } from "./subscriptions.js";
import { AlertEngine } from "./alerts.js";
import type { Game, League, Snapshot } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 8787);
/** Bind all interfaces by default so other devices on the LAN can reach the board. */
const HOST = process.env.HOST ?? "0.0.0.0";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Built frontend location. Set explicitly in the container, where the compiled
 *  server lives at dist-server/server/ rather than beside dist/. */
const distDir = process.env.DIST_DIR
  ? path.resolve(process.env.DIST_DIR)
  : path.resolve(here, "..", "dist");

/**
 * The bundle this process serves, read once at startup.
 *
 * Handed to the client on every poll so an open board notices a deploy without
 * asking a separate question. Detecting it by re-fetching index.html on a timer
 * worked but was slow, and hanging it off "a request failed, so the container
 * must have restarted" was worse: a quick restart between two polls produces no
 * error at all, so the check never ran and the deploy went unnoticed.
 */
function currentBuild(): string | null {
  try {
    const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    return /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
  } catch {
    return null; // No built frontend; the dev server handles its own reloading.
  }
}

const BUILD = currentBuild();

const standings = new StandingsStore();
const listings = new ListingsStore();
/**
 * Notifications are the one feature that needs somewhere durable to live, and the
 * only one that can fail at startup. Everything else on this board is a cache of
 * ESPN, so a notification problem must degrade to "alerts unavailable" rather
 * than taking the scoreboard down with it. It has done exactly that twice.
 */
function startSubscriptions(): SubscriptionStore {
  try {
    return new SubscriptionStore(process.env.NOTIFY_DIR);
  } catch (err) {
    console.error(
      `[notify] disabled after a startup failure: ${err instanceof Error ? err.message : err}`,
    );
    return new SubscriptionStore(undefined);
  }
}

const subscriptions = startSubscriptions();
/**
 * Shares the notification directory, which is the one path guaranteed to be a
 * real mount rather than container-local scratch.
 */
const history = new History(process.env.NOTIFY_DIR);
const alerts = new AlertEngine(subscriptions);

/** Each league polls independently, so a quiet NFL week cannot slow a busy Saturday. */
/**
 * Everything about a request that changes what the board looks like.
 *
 * Captured once so a streaming connection can keep answering as that viewer
 * without holding on to the request itself, and so the stream and the polled
 * endpoint cannot drift into showing different boards.
 */
interface Viewer {
  league: League;
  zip: string | null;
  /** True when the postal code was detected rather than typed. */
  detected: boolean;
  city: string | null;
}

function viewerFor(raw: string, req: http.IncomingMessage): Viewer {
  const league = leagueFrom(raw);
  const chosen = zipFrom(raw);
  const optedOut = new URL(raw, "http://localhost").searchParams.get("market") === "off";
  const detected = optedOut ? null : detectedZip(req);
  return {
    league,
    zip: optedOut ? null : (chosen ?? detected),
    detected: chosen === null,
    city: chosen === null && !optedOut ? detectedCity(req) : null,
  };
}

/** The board as one viewer sees it, market annotations included. */
function resolveView(viewer: Viewer, base: Snapshot): Promise<Snapshot> {
  // Only the NFL splits a slate by market; college games are on cable.
  if (viewer.zip === null || viewer.league !== "nfl") return Promise.resolve(base);
  return Promise.race([
    withMarket(base, viewer.zip, viewer.detected, viewer.city),
    new Promise<Snapshot>((resolve) => setTimeout(() => resolve(base), MARKET_BUDGET_MS)),
  ]).catch((err) => {
    console.error(`[http] market lookup failed: ${err instanceof Error ? err.message : err}`);
    return base;
  });
}

/**
 * Boards currently held open by a streaming connection.
 *
 * Each one remembers the viewer it belongs to rather than a request, because the
 * market a snapshot is annotated for is per person and the connection outlives
 * any single exchange.
 */
interface Stream {
  viewer: Viewer;
  res: http.ServerResponse;
  /**
   * The planning list this connection was last sent, serialised.
   *
   * Kept so an unchanged list can be left out of a push. It is most of the board
   * by size and changes only when the schedule poll runs or a game changes state,
   * so sending it on every clock tick meant a 223KB frame to move 8KB of scores.
   * Compared rather than assumed: when a game does leave the list the comparison
   * fails and the new list goes out, which is what stops a game that just kicked
   * off appearing as both live and upcoming until the next poll.
   */
  sentUpcoming: string | null;
}
const streams = new Set<Stream>();

/** How often to send a comment so proxies do not reap an idle connection. */
const STREAM_KEEPALIVE_MS = 25_000;

function sendSnapshot(stream: Stream, base: Snapshot): void {
  void resolveView(stream.viewer, base).then((snapshot) => {
    if (stream.res.writableEnded) return;
    // The build id rides the stream exactly as it rides a poll, so a deploy is
    // noticed from what is being served rather than from a connection dropping.
    // A reconnect is evidence of a restart, not proof of one: a sleeping phone or
    // a tunnel blip reconnects with nothing deployed.
    const upcoming = JSON.stringify(snapshot.upcoming);
    const unchanged = upcoming === stream.sentUpcoming;
    stream.sentUpcoming = upcoming;

    const payload = JSON.stringify({
      ...snapshot,
      // Omitted, not emptied: the client keeps the list it already has, and an
      // empty array would read as "every upcoming game is gone".
      upcoming: unchanged ? undefined : snapshot.upcoming,
      build: BUILD,
    });
    stream.res.write(`event: snapshot\ndata: ${payload}\n\n`);
  });
}

/** Pushes a new board to everyone watching that league. */
function fanOut(snapshot: Snapshot): void {
  for (const stream of streams) {
    if (stream.viewer.league === snapshot.league) sendSnapshot(stream, snapshot);
  }
}

/**
 * Evaluates a fresh snapshot for alerts, giving each subscriber the board as they
 * would see it so availability and favorites are resolved per person.
 */
function onSnapshot(snapshot: Snapshot): void {
  fanOut(snapshot);
  history.record(snapshot);
  if (!subscriptions.available) return;
  void alerts
    .evaluate(snapshot, async (sub) =>
      sub.zip !== null && snapshot.league === "nfl"
        ? await withMarket(snapshot, sub.zip, false, null)
        : snapshot,
    )
    .then((sent) => {
      if (sent > 0) console.log(`[notify] sent ${sent} notification(s) for ${snapshot.league}`);
    })
    .catch((err) => console.error(`[notify] failed: ${err instanceof Error ? err.message : err}`));
}

const pollers: Record<League, LeaguePoller> = {
  cfb: new LeaguePoller("cfb", null, onSnapshot),
  // Divisions and playoff seeds are not on the scoreboard, so NFL games get
  // decorated from the standings feed before scoring.
  nfl: new LeaguePoller("nfl", (games) => standings.enrich(games), onSnapshot),
};

const DEFAULT_LEAGUE: League = "nfl";

/** Five digits, or nothing. Anything else is not worth a call upstream. */
function validZip(value: string | null | undefined): string | null {
  return typeof value === "string" && /^\d{5}$/.test(value) ? value : null;
}

function zipFrom(url: string): string | null {
  return validZip(new URL(url, "http://localhost").searchParams.get("zip"));
}

/**
 * The viewer's postal code as Cloudflare sees it, when the board is reached
 * through the tunnel and the zone has visitor location headers switched on.
 *
 * Saves asking for something the network already knows. Only ever used as a
 * default: an explicit `zip` always wins, because IP geolocation lands in the
 * right metro but not necessarily the right one of two nearby markets.
 *
 * Trusting a request header is safe here precisely because it is per request. A
 * client that forges one only changes the listings in its own response, which it
 * could do by typing a different postal code anyway.
 */
function detectedCity(req: http.IncomingMessage): string | null {
  const raw = req.headers["cf-ipcity"];
  const city = typeof raw === "string" ? decodeURIComponent(raw).trim() : "";
  return city.length > 0 && city.length < 64 ? city : null;
}

function detectedZip(req: http.IncomingMessage): string | null {
  const headers = req.headers;
  return (
    validZip(headers["cf-postal-code"] as string) ??
    validZip(headers["cf-ippostalcode"] as string) ??
    null
  );
}

/**
 * Marks up a snapshot with what the viewer's own market is actually carrying.
 *
 * Done per request rather than per poll because the answer depends on who is
 * asking: two people on the same board in different cities get different games
 * out of the same slate.
 */
/**
 * How long the board will wait for the market lookup before serving without it.
 *
 * The listings fetch has its own generous timeout and may cover several kickoff
 * windows, so a slow upstream could hold the snapshot request open for a minute
 * or more. That turns a cosmetic annotation into an outage: the board stops
 * answering at all. It is cached, so giving up here costs nothing but a plain
 * board on the first request while the lookup finishes in the background.
 */
const MARKET_BUDGET_MS = 5000;

async function withMarket(
  snapshot: Snapshot,
  zip: string,
  detected: boolean,
  city: string | null,
): Promise<Snapshot> {
  const games = [...snapshot.live, ...snapshot.upcoming, ...snapshot.recent];
  const market = await listings.resolve(zip, games);
  if (market === null) return snapshot;

  const annotate = (game: Game): Game => ({
    ...game,
    // Only the market-split games need an answer. A national broadcast is on
    // everywhere, and saying "not on your channels" because the grid happens not
    // to list ESPN would be worse than saying nothing.
    marketStations:
      (game.regionalPeers ?? 0) > 1 ? (listings.lookup(market, game)?.stations ?? []) : null,
  });

  return {
    ...snapshot,
    live: snapshot.live.map(annotate),
    upcoming: snapshot.upcoming.map(annotate),
    recent: snapshot.recent.map(annotate),
    market: {
      zip,
      // Local call signs only. ESPN and NFL Network appear in every lineup and
      // say nothing about which market this is, which is the whole point of
      // showing the list back to the viewer.
      stations: market.stations.filter((s) => /^[KW][A-Z]{2,3}$/.test(s)),
      detected,
      city,
    },
  };
}

/**
 * Reads a JSON body, refusing anything oversized.
 *
 * This is the only write path in an otherwise read-only service, so it gets a
 * hard cap rather than trusting content-length, which a client controls.
 */
const MAX_BODY_BYTES = 8 * 1024;

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading but leave the socket alive, so the caller still gets a
        // reply. Destroying it here means an oversized request looks to the
        // client like the server simply hung up.
        req.pause();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

/** Nothing from a browser is trusted; every field is checked and rebuilt. */
function parseSubscription(body: unknown): Parameters<SubscriptionStore["upsert"]>[0] | null {
  const b = body as Record<string, any> | null;
  const endpoint = b?.endpoint;
  const p256dh = b?.keys?.p256dh;
  const auth = b?.keys?.auth;
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 1024) {
    return null;
  }
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (p256dh.length > 256 || auth.length > 256) return null;

  const wants: Record<League, Category[]> = { nfl: [], cfb: [] };
  for (const league of ["nfl", "cfb"] as League[]) {
    const raw = Array.isArray(b?.wants?.[league]) ? b.wants[league] : [];
    wants[league] = CATEGORIES.filter((c) => raw.includes(c));
  }
  if (wants.nfl.length === 0 && wants.cfb.length === 0) return null;

  const favorites: Record<League, string[]> = { nfl: [], cfb: [] };
  for (const league of ["nfl", "cfb"] as League[]) {
    const raw = Array.isArray(b?.favorites?.[league]) ? b.favorites[league] : [];
    favorites[league] = raw
      .filter((x: unknown) => typeof x === "string" && x.length <= 40)
      .slice(0, 20);
  }

  const zip = typeof b?.zip === "string" && /^\d{5}$/.test(b.zip) ? b.zip : null;
  // Same ceiling the board applies, re-checked here because nothing from a
  // browser is trusted and this one schedules a timer.
  const raw = Number(b?.delaySeconds);
  const delaySeconds = Number.isFinite(raw) ? Math.min(120, Math.max(0, Math.round(raw))) : 0;
  return { endpoint, keys: { p256dh, auth }, wants, zip, favorites, delaySeconds };
}

function leagueFrom(url: string): League {
  const value = new URL(url, "http://localhost").searchParams.get("league");
  return value === "nfl" || value === "cfb" ? value : DEFAULT_LEAGUE;
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

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function handleNotificationWrite(
  url: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!subscriptions.available) {
    json(res, { error: "notifications are not configured" }, 503);
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "bad request";
    json(res, { error: message }, message === "body too large" ? 413 : 400);
    req.destroy();
    return;
  }

  // Posted by the service worker every time it shows a push, which happens even for
  // somebody who never opens the board. It is the only signal that a subscription is
  // still attached to a living install, since the push service keeps accepting
  // messages for an endpoint whose app was reinstalled. Keyed on the endpoint, which
  // is already the subscription's secret, because the worker has no session to offer.
  if (url === "/api/notifications/ack") {
    const endpoint = (body as { endpoint?: unknown })?.endpoint;
    if (typeof endpoint !== "string") {
      json(res, { error: "endpoint required" }, 400);
      return;
    }
    subscriptions.acknowledge(endpoint);
    json(res, { ok: true });
    return;
  }

  if (url === "/api/notifications/unsubscribe") {
    const endpoint = (body as { endpoint?: unknown })?.endpoint;
    if (typeof endpoint !== "string") {
      json(res, { error: "endpoint required" }, 400);
      return;
    }
    subscriptions.remove(endpoint);
    json(res, { ok: true });
    return;
  }

  const parsed = parseSubscription(body);
  if (parsed === null) {
    json(res, { error: "invalid subscription" }, 400);
    return;
  }
  // Null means the store refused it, which at this point only happens when it is
  // full. Saying so beats reporting a success the viewer will never hear from.
  if (subscriptions.upsert(parsed) === null) {
    json(res, { error: "too many subscriptions" }, 503);
    return;
  }
  json(res, { ok: true });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const raw = req.url ?? "/";
  const url = raw.split("?")[0];

  // Read-only service: nothing here should ever accept a write.
  // Subscribing is the single exception to an otherwise read-only service.
  const writable =
    url === "/api/notifications/subscribe" ||
    url === "/api/notifications/unsubscribe" ||
    url === "/api/notifications/ack";
  if (req.method === "POST" && writable) {
    void handleNotificationWrite(url, req, res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  if (url === "/api/notifications/config") {
    json(res, {
      available: subscriptions.available,
      publicKey: subscriptions.publicKey,
      categories: CATEGORIES,
    });
    return;
  }

  if (url === "/api/snapshot") {
    const view = viewerFor(raw, req);
    // resolveView already falls back to the unannotated board on failure.
    void resolveView(view, pollers[view.league].snapshot)
      .then((snapshot) => {
        snapshot = { ...snapshot, build: BUILD };
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify(snapshot));
      });
    return;
  }

  if (url === "/api/stream") {
    const viewer = viewerFor(raw, req);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Tells a buffering proxy to pass events through as they are written,
      // which is the difference between a live stream and a long silence.
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });

    const stream: Stream = { viewer, res, sentUpcoming: null };
    streams.add(stream);
    // The current board immediately, so a fresh connection is never blank while
    // it waits for whatever happens next.
    sendSnapshot(stream, pollers[viewer.league].snapshot);

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, STREAM_KEEPALIVE_MS);
    keepalive.unref?.();

    const close = () => {
      clearInterval(keepalive);
      streams.delete(stream);
    };
    req.on("close", close);
    res.on("close", close);
    return;
  }

  if (url === "/api/providers") {
    const zip = zipFrom(raw);
    if (zip === null) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "zip required" }));
      return;
    }
    void listings
      .providers(zip)
      .catch((err) => {
        console.error(`[listings] providers ${zip}: ${err instanceof Error ? err.message : err}`);
        return [];
      })
      .then((providers) => {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ providers }));
      });
    return;
  }

  if (url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    const leagues = Object.fromEntries(
      (Object.keys(pollers) as League[]).map((l) => [l, pollers[l].health()]),
    );
    res.end(
      JSON.stringify({
        ok: Object.values(leagues).every((l) => l.ok),
        leagues,
      }),
    );
    return;
  }

  serveStatic(req, res);
}

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});

for (const poller of Object.values(pollers)) poller.start();
