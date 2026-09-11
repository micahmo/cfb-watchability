import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LeaguePoller } from "./poller.js";
import { StandingsStore } from "./standings.js";
import { ListingsStore } from "./listings.js";
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

const standings = new StandingsStore();
const listings = new ListingsStore();

/** Each league polls independently, so a quiet NFL week cannot slow a busy Saturday. */
const pollers: Record<League, LeaguePoller> = {
  cfb: new LeaguePoller("cfb"),
  // Divisions and playoff seeds are not on the scoreboard, so NFL games get
  // decorated from the standings feed before scoring.
  nfl: new LeaguePoller("nfl", (games) => standings.enrich(games)),
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

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const raw = req.url ?? "/";
  const url = raw.split("?")[0];

  // Read-only service: nothing here should ever accept a write.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  if (url === "/api/snapshot") {
    const league = leagueFrom(raw);
    const chosen = zipFrom(raw);
    const params = new URL(raw, "http://localhost").searchParams;
    const optedOut = params.get("market") === "off";
    const detected = optedOut ? null : detectedZip(req);
    const zip = optedOut ? null : (chosen ?? detected);
    const base = pollers[league].snapshot;
    // Only the NFL splits a slate by market; college games are on cable.
    const ready =
      zip !== null && league === "nfl"
        ? withMarket(
            base,
            zip,
            chosen === null,
            chosen === null ? detectedCity(req) : null,
          )
        : Promise.resolve(base);
    void ready
      .catch((err) => {
        console.error(`[http] market lookup failed: ${err instanceof Error ? err.message : err}`);
        return base;
      })
      .then((snapshot) => {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify(snapshot));
      });
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
