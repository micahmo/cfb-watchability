import type { TeamSide } from "../../shared/types";

/** Perceived brightness, used to keep near-black team colors readable on a dark card. */
function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return 0.5;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function teamColor(team: TeamSide): string {
  const primary = `#${team.color.replace("#", "")}`;
  if (luminance(primary) > 0.12) return primary;
  const alt = `#${team.altColor.replace("#", "")}`;
  return luminance(alt) > 0.12 ? alt : "#7c8aa5";
}

export function scoreColor(total: number): string {
  if (total >= 78) return "var(--hot)";
  if (total >= 58) return "var(--warm)";
  if (total >= 35) return "var(--cool)";
  return "var(--calm)";
}

export function kickoffTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function kickoffDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? "Today" : d.toLocaleDateString([], { weekday: "short" });
}

/**
 * When a game was played, for the recap.
 *
 * ESPN publishes no end time, only a start and a `Final` status, so a finished
 * card says when the game kicked off rather than when it ended. The day is only
 * shown when it is not today, since the recap reaches back eighteen hours and
 * most of what it holds is from this afternoon.
 */
export function kickoffWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? kickoffTime(iso) : `${kickoffDay(iso)} ${kickoffTime(iso)}`;
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "never";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function ordinalPeriod(period: number): string {
  if (period > 4) return period === 5 ? "OT" : `${period - 4}OT`;
  return ["", "1st", "2nd", "3rd", "4th"][period] ?? "";
}

/**
 * Perceptual-ish distance between two hex colors, 0..1.
 *
 * Plenty of matchups are dark red against dark red (SMU at Florida State being
 * the one that prompted this), and a two-tone bar is useless when the two tones
 * are the same tone.
 */
export function colorDistance(a: string, b: string): number {
  const parse = (hex: string) => {
    const c = hex.replace("#", "");
    return [
      parseInt(c.slice(0, 2), 16) || 0,
      parseInt(c.slice(2, 4), 16) || 0,
      parseInt(c.slice(4, 6), 16) || 0,
    ];
  };
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const rMean = (r1 + r2) / 2;
  // Low-cost approximation of CIE94 that weights channels by eye sensitivity.
  const weighted =
    (2 + rMean / 256) * (r1 - r2) ** 2 +
    4 * (g1 - g2) ** 2 +
    (2 + (255 - rMean) / 256) * (b1 - b2) ** 2;
  return Math.min(1, Math.sqrt(weighted) / 764);
}

const SIMILAR_THRESHOLD = 0.22;

export function colorsTooSimilar(a: string, b: string): boolean {
  return colorDistance(a, b) < SIMILAR_THRESHOLD;
}

/** Local calendar day key, so grouping matches the viewer's timezone. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long" });
}

export function dayDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Human clock label for a live game.
 *
 * "0:00 2nd" is technically accurate and reads as a stopped clock rather than as
 * halftime, so the break states get named explicitly. ESPN's status name is the
 * reliable signal; the clock check is a fallback for feeds that do not set it.
 */
export function clockLabel(game: {
  period: number;
  clock: string;
  clockSeconds: number;
  statusName: string;
}): string {
  const atBreak = game.clockSeconds === 0;

  if (game.statusName === "STATUS_HALFTIME" || (atBreak && game.period === 2)) {
    return "Halftime";
  }
  if (game.statusName === "STATUS_DELAYED") return "Delayed";
  if (atBreak && game.period > 0 && game.period <= 4) {
    return `End of ${ordinalPeriod(game.period)}`;
  }
  // College overtime has no game clock, so ESPN reports 0:00 throughout it.
  if (game.period > 4) return ordinalPeriod(game.period);
  return `${game.clock} ${ordinalPeriod(game.period)}`;
}
