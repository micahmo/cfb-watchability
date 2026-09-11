import { DEFAULT_PROFILE, type ProfileName } from "../../shared/weights";
import type { League } from "../../shared/types";

const KEY = "football-watchability-prefs";

export interface Prefs {
  profile: ProfileName;
  league: League;
}

const DEFAULTS: Prefs = { profile: DEFAULT_PROFILE, league: "nfl" };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
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
