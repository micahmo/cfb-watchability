import { DEFAULT_PROFILE, type ProfileName } from "../../shared/weights";
import type { League } from "../../shared/types";

const KEY = "football-watchability-prefs";

export interface Prefs {
  profile: ProfileName;
  league: League;
  /** Conferences to favour, per league. Empty means no preference. */
  favourites: Record<League, string[]>;
}

const DEFAULTS: Prefs = {
  profile: DEFAULT_PROFILE,
  league: "nfl",
  favourites: { nfl: [], cfb: [] },
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULTS,
      ...saved,
      favourites: { ...DEFAULTS.favourites, ...(saved.favourites ?? {}) },
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

export function isFavourite(league: League, conference: string | null): boolean {
  if (!conference) return false;
  return prefs.favourites[league]?.includes(conference) ?? false;
}

export function toggleFavourite(league: League, conference: string): void {
  const current = prefs.favourites[league] ?? [];
  prefs.favourites[league] = current.includes(conference)
    ? current.filter((c) => c !== conference)
    : [...current, conference];
  persist();
}
