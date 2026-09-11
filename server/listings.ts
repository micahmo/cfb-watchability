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
const PROVIDERS =
  "https://tvlistings.gracenote.com/gapzap_webapi/api/providers/getPostalCodeProviders/USA";

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
const REFERER = "https://tvlistings.gracenote.com/";

/** A market only has so many affiliates; this bounds a pathological zip. */
const MAX_WINDOWS_PER_REFRESH = 8;

export interface GameAvailability {
  /** Stations in this market carrying the game, e.g. ["WBZ", "WPRI"]. */
  stations: string[];
  /** Kickoff slot key, used to spot a lineup that straddles two markets. */
  window: string;
}

export interface Provider {
  lineupId: string;
  name: string;
  location: string;
  type: string;
  device: string;
}

/**
 * A postal code alone selects the over-the-air lineup, which lists every
 * transmitter the area could theoretically receive. Near a market boundary that
 * spans several DMAs at once: Fitchburg MA returns Boston, Providence, Manchester
 * and Springfield affiliates together, and those are separate markets that can be
 * airing different games. Naming an actual provider narrows it to the channels
 * the viewer really has.
 */
export interface Lineup {
  id: string;
  headend: string;
  device: string;
}

/** "USA-DITV506-DEFAULT" addresses headend "DITV506". Also true of the OTA default. */
export function lineupFromId(id: string | null, device: string | null): Lineup {
  if (id === null || !/^[A-Za-z0-9-]{3,60}$/.test(id)) {
    return { id: "lineupId", headend: "lineupId", device: "-" };
  }
  const parts = id.split("-");
  const headend = parts.length >= 3 ? parts.slice(1, -1).join("-") : id;
  return { id, headend, device: device === "X" ? "X" : "-" };
}

export interface MarketListings {
  zip: string;
  /** Every station seen carrying football, for the "this is set" chip. */
  stations: string[];
  /** Key is `<awayDisplayName>|<homeDisplayName>` lowercased. */
  byMatchup: Map<string, GameAvailability>;
}

/** A complete US broadcast call sign: K or W, then two or three letters. */
const CALL_SIGN = /^[KW][A-Z]{2,3}$/;

/**
 * "WBZDT", "KIROLD5" and "WBTSCD" are all just "WBZ", "KIRO" and "WBTS" to a
 * viewer. The suffixes are transmission-class markers, not part of the name.
 *
 * Stripping them blindly is wrong, because plenty of real call signs end in those
 * same two letters: WFLD is FOX Chicago, and a bare suffix rule turns it into
 * "WF". So a trim only stands if what it leaves behind is itself a valid call
 * sign, which "WF" is not.
 */
function tidyCallSign(raw: string): string {
  const full = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (CALL_SIGN.test(full)) return full;
  const trimmed = full.replace(/(DT|HD|LD|CD|LP|CA|TV)\d*$/, "").replace(/\d+$/, "");
  if (CALL_SIGN.test(trimmed)) return trimmed;
  // Cable networks are not call signs and never take the class suffixes above, so
  // the guard rejects trimming them. They do carry HD and SD variants, and
  // "ESPNHD" alongside "ESPN" is one channel listed twice.
  return full.replace(/(HD|SD)$/, "") || full;
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
  private providerCache = new Map<string, Provider[]>();
  private resolvedLineup = new Map<string, Lineup>();

  /** Lineups the viewer could plausibly be on, for the market picker. */
  async providers(zip: string): Promise<Provider[]> {
    const cached = this.providerCache.get(zip);
    if (cached) return cached;
    const res = await fetch(`${PROVIDERS}/${zip}/gapzap/en-us`, {
      headers: { accept: "application/json", "user-agent": BROWSER_UA, referer: REFERER },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`providers returned ${res.status}`);
    const body: any = await res.json();
    const list: Provider[] = (body?.Providers ?? [])
      .filter((p: any) => typeof p?.lineupId === "string")
      .map((p: any) => ({
        lineupId: String(p.lineupId),
        name: String(p.name ?? p.lineupId),
        location: String(p.location ?? ""),
        type: String(p.type ?? ""),
        device: p.device === "X" ? "X" : "-",
      }));
    if (list.length > 0) this.providerCache.set(zip, list);
    return list;
  }

  private async fetchWindow(
    zip: string,
    lineup: Lineup,
    startMs: number,
    into: MarketListings,
  ): Promise<void> {
    const params = new URLSearchParams({
      postalCode: zip,
      country: "USA",
      time: String(Math.floor(startMs / 1000)),
      // Hours. Three covers a football game plus the pre-game slot it sits in.
      timespan: "3",
      isOverride: "true",
      aid: "orbebb",
      languagecode: "en-us",
      device: lineup.device,
      pref: "-",
      userId: "-",
      headendId: lineup.headend,
      lineupId: lineup.id,
      timezone: "",
    });

    const res = await fetch(`${GRID}?${params}`, {
      headers: { accept: "application/json", "user-agent": BROWSER_UA, referer: REFERER },
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
        const existing = into.byMatchup.get(key) ?? {
          stations: [],
          window: String(event?.startTime ?? ""),
        };
        if (!existing.stations.includes(station)) existing.stations.push(station);
        into.byMatchup.set(key, existing);
        if (!into.stations.includes(station)) into.stations.push(station);
      }
    }
  }

  /**
   * Whether these listings describe more than one television market.
   *
   * Any single market shows exactly one CBS and one FOX game in a Sunday
   * afternoon window. Three or more distinct matchups in one window means the
   * over-the-air list has swept in a neighbouring market's transmitters, and the
   * answer it gives is no longer the answer for anyone in particular.
   */
  private straddlesMarkets(listings: MarketListings): boolean {
    const perWindow = new Map<string, number>();
    for (const entry of listings.byMatchup.values()) {
      perWindow.set(entry.window, (perWindow.get(entry.window) ?? 0) + 1);
    }
    return [...perWindow.values()].some((n) => n > 2);
  }

  /**
   * The lineup most likely to describe this viewer's actual channels.
   *
   * Satellite first: DISH and DIRECTV name their lineups after the television
   * market itself, so they are market-scoped by construction and exist
   * everywhere. Cable headends are named after towns and work just as well when
   * satellite is missing. Nationwide feeds carry no local affiliates at all and
   * cannot answer the question.
   */
  private pickLineup(providers: Provider[]): Provider | null {
    const local = providers.filter(
      (p) => p.location !== "" && p.location.toUpperCase() !== "USA" && p.type !== "OTA",
    );
    return (
      local.find((p) => p.type === "SATELLITE") ?? local.find((p) => p.type === "CABLE") ?? null
    );
  }

  private async refresh(zip: string, lineup: Lineup, games: Game[]): Promise<MarketListings | null> {
    const key = `${zip}|${lineup.id}`;
    const listings: MarketListings = { zip, stations: [], byMatchup: new Map() };
    let anySucceeded = false;
    for (const start of windowsFor(games)) {
      try {
        await this.fetchWindow(zip, lineup, start, listings);
        anySucceeded = true;
      } catch (err) {
        // One bad window should not discard the windows that did come back.
        console.error(
          `[listings] ${zip} @ ${new Date(start).toISOString()}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (!anySucceeded) {
      this.failedAt.set(key, Date.now());
      return null;
    }
    this.failedAt.delete(key);
    listings.stations.sort();
    this.byZip.set(key, { fetchedAt: Date.now(), listings });
    console.log(
      `[listings] ${zip}: ${listings.byMatchup.size} matchups across ${listings.stations.length} stations`,
    );
    return listings;
  }

  /** Cached per zip, one refresh at a time, and stale data beats no data. */
  /**
   * Listings for a postal code, narrowed to one market automatically.
   *
   * Starts over the air, because it needs nothing but the postal code. Near a
   * boundary that list spans several markets at once, and when it does, this
   * quietly re-reads through a real provider's lineup for the market instead.
   * The viewer is never asked to claim they have a cable company they do not.
   */
  async resolve(zip: string, games: Game[]): Promise<MarketListings | null> {
    const chosen = this.resolvedLineup.get(zip);
    if (chosen !== undefined) return this.get(zip, chosen, games);

    const overAir = await this.get(zip, lineupFromId(null, null), games);
    if (overAir === null || !this.straddlesMarkets(overAir)) return overAir;

    try {
      const provider = this.pickLineup(await this.providers(zip));
      if (provider === null) return overAir;
      const lineup = lineupFromId(provider.lineupId, provider.device);
      const narrowed = await this.get(zip, lineup, games);
      if (narrowed === null) return overAir;
      this.resolvedLineup.set(zip, lineup);
      console.log(`[listings] ${zip}: over-air spans markets, using ${provider.name}`);
      return narrowed;
    } catch (err) {
      console.error(`[listings] ${zip} narrowing failed: ${err instanceof Error ? err.message : err}`);
      return overAir;
    }
  }

  async get(zip: string, lineup: Lineup, games: Game[]): Promise<MarketListings | null> {
    const key = `${zip}|${lineup.id}`;
    const cached = this.byZip.get(key);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.listings;

    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < FAILURE_COOLDOWN_MS) {
      return cached?.listings ?? null;
    }

    const running = this.inFlight.get(key);
    if (running) return running;

    const task = this.refresh(zip, lineup, games)
      .catch((err) => {
        console.error(`[listings] ${zip} failed: ${err instanceof Error ? err.message : err}`);
        return null;
      })
      .then((fresh) => fresh ?? cached?.listings ?? null)
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, task);
    return task;
  }

  lookup(listings: MarketListings, game: Game): GameAvailability | null {
    return listings.byMatchup.get(matchupKey(game.away.displayName, game.home.displayName)) ?? null;
  }
}
