import type { Game } from "../shared/types.js";

/**
 * Which regional NFL game your own television is actually going to show.
 *
 * ESPN cannot answer this: it labels every NFL game "National", including the
 * eight 1:00 games that are plainly split by market, and the published coverage
 * maps sit behind a bot wall. Gracenote's public listings grid can, because it
 * reports what each local affiliate is airing hour by hour, keyed on nothing
 * but a postal code. A 1:00 slate that looks identical on the scoreboard comes
 * back as "WBZ is showing Bills at Texans" in Boston and "WFRV is showing Bears
 * at Panthers" in Green Bay.
 *
 * This is the same endpoint the public tvlistings site calls, so it is polite to
 * touch it rarely: listings for a given kickoff do not change, and one fetch
 * covers every game in that window, so a market costs a handful of calls a week.
 */
const GRID = "https://tvlistings.gracenote.com/api/grid";

/** Listings are published days ahead and do not churn, so this can be long. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** After a refusal, wait rather than retrying on every single page load. */
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * The grid answers browsers and refuses everything else, so an honest tool name
 * here earns a flat 403. This is the same public guide the tvlistings site
 * serves to anyone who visits it, and we ask for a handful of windows per market
 * per week, cached hard on both sides of the call.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** A market only has so many affiliates; this bounds a pathological zip. */
const MAX_WINDOWS_PER_REFRESH = 8;

export interface GameAvailability {
  /** Stations in this market carrying the game, e.g. ["WBZ", "WPRI"]. */
  stations: string[];
}

export interface MarketListings {
  zip: string;
  /** Every station seen carrying football, for the "this is set" chip. */
  stations: string[];
  /** Key is `<awayDisplayName>|<homeDisplayName>` lowercased. */
  byMatchup: Map<string, GameAvailability>;
}

/**
 * "WBZDT", "KIROLD5" and "WBTSCD" are all just "WBZ", "KIRO" and "WBTS" to a
 * viewer. The suffixes are transmission-class markers, not part of the name.
 */
function tidyCallSign(raw: string): string {
  return String(raw ?? "")
    .replace(/(DT|HD|LD|CD|LP|CA|TV)\d*$/i, "")
    .replace(/\d+$/, "")
    .trim();
}

function matchupKey(away: string, home: string): string {
  return `${away}|${home}`.toLowerCase();
}

/** Kickoffs rounded to the hour, so eight 1:00 games cost one fetch, not eight. */
function windowsFor(games: Game[]): number[] {
  const hours = new Set<number>();
  for (const game of games) {
    const at = Date.parse(game.startDate);
    if (!Number.isFinite(at)) continue;
    hours.add(Math.floor(at / 3_600_000) * 3_600_000);
  }
  return [...hours].sort((a, b) => a - b).slice(0, MAX_WINDOWS_PER_REFRESH);
}

interface Entry {
  fetchedAt: number;
  listings: MarketListings;
}

export class ListingsStore {
  private byZip = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<MarketListings | null>>();
  private failedAt = new Map<string, number>();

  private async fetchWindow(zip: string, startMs: number, into: MarketListings): Promise<void> {
    const params = new URLSearchParams({
      postalCode: zip,
      country: "USA",
      time: String(Math.floor(startMs / 1000)),
      // Hours. Three covers a football game plus the pre-game slot it sits in.
      timespan: "3",
      isOverride: "true",
      aid: "orbebb",
      languagecode: "en-us",
      device: "-",
      pref: "-",
      userId: "-",
      // The grid insists on these, and the literal string is what selects the
      // default over-the-air lineup for the postal code.
      headendId: "lineupId",
      lineupId: "lineupId",
      timezone: "",
    });

    const res = await fetch(`${GRID}?${params}`, {
      headers: {
        accept: "application/json",
        "user-agent": BROWSER_UA,
        referer: "https://tvlistings.gracenote.com/",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`listings grid returned ${res.status}`);
    const body: any = await res.json();

    for (const channel of body?.channels ?? []) {
      const station = tidyCallSign(channel?.callSign);
      if (!station) continue;
      for (const event of channel?.events ?? []) {
        const title = String(event?.program?.title ?? "");
        // Specifically NFL: a loose "football" test also matches the college
        // games, which are on cable and never split by market, and those extra
        // stations then muddy the market chip.
        if (!/^NFL Football/i.test(title)) continue;
        // "Buffalo Bills at Houston Texans". Without it we know a game is on but
        // not which one, which is no better than the scoreboard.
        const episode = String(event?.program?.episodeTitle ?? "");
        const parts = episode.split(/\s+at\s+/i);
        if (parts.length !== 2) continue;
        const key = matchupKey(parts[0].trim(), parts[1].trim());
        const existing = into.byMatchup.get(key) ?? { stations: [] };
        if (!existing.stations.includes(station)) existing.stations.push(station);
        into.byMatchup.set(key, existing);
        if (!into.stations.includes(station)) into.stations.push(station);
      }
    }
  }

  private async refresh(zip: string, games: Game[]): Promise<MarketListings | null> {
    const listings: MarketListings = { zip, stations: [], byMatchup: new Map() };
    let anySucceeded = false;
    for (const start of windowsFor(games)) {
      try {
        await this.fetchWindow(zip, start, listings);
        anySucceeded = true;
      } catch (err) {
        // One bad window should not discard the windows that did come back.
        console.error(
          `[listings] ${zip} @ ${new Date(start).toISOString()}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (!anySucceeded) {
      this.failedAt.set(zip, Date.now());
      return null;
    }
    this.failedAt.delete(zip);
    listings.stations.sort();
    this.byZip.set(zip, { fetchedAt: Date.now(), listings });
    console.log(
      `[listings] ${zip}: ${listings.byMatchup.size} matchups across ${listings.stations.length} stations`,
    );
    return listings;
  }

  /** Cached per zip, one refresh at a time, and stale data beats no data. */
  async get(zip: string, games: Game[]): Promise<MarketListings | null> {
    const cached = this.byZip.get(zip);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.listings;

    const failed = this.failedAt.get(zip);
    if (failed !== undefined && Date.now() - failed < FAILURE_COOLDOWN_MS) {
      return cached?.listings ?? null;
    }

    const running = this.inFlight.get(zip);
    if (running) return running;

    const task = this.refresh(zip, games)
      .catch((err) => {
        console.error(`[listings] ${zip} failed: ${err instanceof Error ? err.message : err}`);
        return null;
      })
      .then((fresh) => fresh ?? cached?.listings ?? null)
      .finally(() => {
        this.inFlight.delete(zip);
      });
    this.inFlight.set(zip, task);
    return task;
  }

  lookup(listings: MarketListings, game: Game): GameAvailability | null {
    return listings.byMatchup.get(matchupKey(game.away.displayName, game.home.displayName)) ?? null;
  }
}
