import type { League } from "../../shared/types";
import type { Category } from "./push";

const KEY = "football-watchability-prefs";

export interface Prefs {
  league: League;
  /** Conferences to favour, per league. Empty means no preference. */
  favorites: Record<League, string[]>;
  /**
   * Postal code, used to work out which regional NFL game this viewer's own
   * channels are carrying. Kept per browser rather than on the server, so the
   * same board serves someone in Boston and someone in Dallas correctly.
   */
  zip: string | null;
  /**
   * Explicitly opted out of market filtering. Distinct from `zip: null`, which
   * means "work it out for me": this one means "do not, even if you can".
   */
  marketOff: boolean;
  /** Alert categories per league. Empty everywhere means notifications are off. */
  alerts: Record<League, Category[]>;
  /**
   * How the planning list is ordered within a day. Ranked answers "what is worth
   * my evening", chronological answers "what is on next and is it any good".
   */
  upcomingOrder: "rank" | "time";
  /**
   * How far behind live to hold the board, in seconds.
   *
   * The push feed puts a play on screen about two seconds after it happens and a
   * television broadcast runs anywhere from ten seconds to a minute behind, so
   * the board spoils the game it is meant to help you watch. Per browser rather
   * than on the server, because the right number is a property of the viewer's
   * own feed: cable and a streaming app on the same sofa differ by half a minute.
   */
  delaySeconds: number;
}

const DEFAULTS: Prefs = {
  league: "nfl",
  favorites: { nfl: [], cfb: [] },
  zip: null,
  marketOff: false,
  alerts: { nfl: [], cfb: [] },
  upcomingOrder: "rank",
  delaySeconds: 0,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULTS,
      ...saved,
      favorites: { ...DEFAULTS.favorites, ...(saved.favorites ?? {}) },
      alerts: { ...DEFAULTS.alerts, ...(saved.alerts ?? {}) },
    };
  } catch {
    // Private windows and blocked site data both throw here.
    return { ...DEFAULTS };
  }
}

export const prefs = $state<Prefs>(load());

export function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Losing preferences is survivable; breaking the board is not.
  }
}

export function setZip(zip: string): void {
  prefs.zip = /^\d{5}$/.test(zip) ? zip : null;
  prefs.marketOff = false;
  persist();
}

/** Clamped, because a delay long enough to be confusing is worse than none. */
export const MAX_DELAY_SECONDS = 120;

export function setDelaySeconds(seconds: number): void {
  const whole = Math.round(Number(seconds));
  prefs.delaySeconds = Number.isFinite(whole)
    ? Math.min(MAX_DELAY_SECONDS, Math.max(0, whole))
    : 0;
  persist();
}

export function setUpcomingOrder(order: Prefs["upcomingOrder"]): void {
  prefs.upcomingOrder = order;
  persist();
}

export function setAlerts(league: League, categories: Category[]): void {
  prefs.alerts[league] = categories;
  persist();
}

/** No market at all, not even a detected one. */
export function clearMarket(): void {
  prefs.zip = null;
  prefs.marketOff = true;
  persist();
}

/** Back to whatever the network says, without retyping anything. */
export function redetectMarket(): void {
  prefs.zip = null;
  prefs.marketOff = false;
  persist();
}

export function isFavorite(league: League, conference: string | null): boolean {
  if (!conference) return false;
  return prefs.favorites[league]?.includes(conference) ?? false;
}

export function toggleFavorite(league: League, conference: string): void {
  const current = prefs.favorites[league] ?? [];
  prefs.favorites[league] = current.includes(conference)
    ? current.filter((c) => c !== conference)
    : [...current, conference];
  persist();
}
