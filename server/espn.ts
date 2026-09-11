import type { Game, GameState, League, TeamSide } from "../shared/types.js";
import { broadcastTier } from "./prominence.js";

const SITE_API = "https://site.api.espn.com/apis/site/v2/sports/football";

/** ESPN's path segment per league. */
const SPORT_PATH: Record<League, string> = {
  cfb: "college-football",
  nfl: "nfl",
};

/** Thrown on HTTP 429 so the poller can back off harder than for a generic failure. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfter: string | null) {
    super("ESPN rate limited the request (HTTP 429)");
    this.name = "RateLimitError";
    const parsed = retryAfter === null ? NaN : Number(retryAfter);
    this.retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  }
}

export interface FetchOptions {
  league: League;
  /** College only. ESPN group 80 is FBS, 81 is FCS. The NFL feed takes no groups. */
  groups?: string;
  limit?: number;
  /** YYYYMMDD, or a YYYYMMDD-YYYYMMDD range. Omit for the current week. */
  dates?: string;
}

export interface ScoreboardResult {
  season: number | null;
  week: number | null;
  games: RawGame[];
}

/** A game as ESPN describes it, before any scoring is applied. */
export type RawGame = Omit<
  Game,
  "score" | "tags" | "anticipation" | "pregameSpread" | "pregameOdds"
>;

function toRank(curated: unknown): number | null {
  const n = typeof curated === "number" ? curated : Number(curated);
  if (!Number.isFinite(n) || n <= 0 || n > 25) return null;
  return n;
}

/** "9-3" or "9-3-1" to a win percentage, counting a tie as half a win. */
function winPctFrom(summary: unknown): number | null {
  if (typeof summary !== "string") return null;
  const parts = summary.split("-").map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [wins, losses, ties = 0] = parts;
  const played = wins + losses + ties;
  if (played === 0) return null;
  return (wins + ties / 2) / played;
}

function toSide(competitor: any): TeamSide {
  const team = competitor?.team ?? {};
  const overall = (competitor?.records ?? []).find(
    (r: any) => r?.type === "total" || r?.name === "overall",
  );
  return {
    id: String(team.id ?? competitor?.id ?? ""),
    abbrev: team.abbreviation ?? team.shortDisplayName ?? "???",
    name: team.shortDisplayName ?? team.name ?? team.displayName ?? "Unknown",
    displayName: team.displayName ?? team.name ?? "Unknown",
    logo: team.logo ?? null,
    color: team.color ?? "888888",
    altColor: team.alternateColor ?? "444444",
    score: Number(competitor?.score ?? 0) || 0,
    rank: toRank(competitor?.curatedRank?.current),
    record: overall?.summary ?? "",
    winPct: winPctFrom(overall?.summary),
    divisionId: null,
    playoffSeed: null,
    homeAway: competitor?.homeAway === "home" ? "home" : "away",
    conferenceId: team.conferenceId != null ? String(team.conferenceId) : null,
  };
}

function normalize(event: any, league: League): RawGame | null {
  const comp = event?.competitions?.[0];
  if (!comp) return null;

  const competitors = comp.competitors ?? [];
  const homeRaw = competitors.find((c: any) => c?.homeAway === "home");
  const awayRaw = competitors.find((c: any) => c?.homeAway === "away");
  if (!homeRaw || !awayRaw) return null;

  const home = toSide(homeRaw);
  const away = toSide(awayRaw);

  const status = event.status ?? comp.status ?? {};
  const rawState = status?.type?.state;
  const state: GameState = rawState === "in" ? "in" : rawState === "post" ? "post" : "pre";

  const probability = comp?.situation?.lastPlay?.probability;
  const homeWinProbRaw = probability?.homeWinPercentage;
  const homeWinProb =
    typeof homeWinProbRaw === "number" && Number.isFinite(homeWinProbRaw)
      ? Math.min(1, Math.max(0, homeWinProbRaw))
      : null;

  const broadcast =
    comp?.broadcasts?.[0]?.names?.[0] ??
    comp?.geoBroadcasts?.[0]?.media?.shortName ??
    comp?.broadcast ??
    null;

  const odds = comp?.odds?.[0] ?? null;
  const spreadRaw = odds?.spread;

  // Almost every college game is carried nationally, so a home/away market feed
  // is worth calling out precisely because it is the rare case.
  const geo = comp?.geoBroadcasts ?? [];
  const nationalBroadcast =
    geo.length === 0 || geo.some((g: any) => g?.market?.type === "National");

  return {
    id: String(event.id),
    league,
    state,
    name: event.name ?? `${away.displayName} at ${home.displayName}`,
    shortName: event.shortName ?? `${away.abbrev} @ ${home.abbrev}`,
    startDate: event.date ?? comp.date ?? "",
    period: Number(status.period ?? 0) || 0,
    clock: status.displayClock ?? "",
    clockSeconds: Number(status.clock ?? 0) || 0,
    statusDetail: status?.type?.shortDetail ?? status?.type?.description ?? "",
    statusName: status?.type?.name ?? "",
    home,
    away,
    homeWinProb,
    margin: Math.abs(home.score - away.score),
    totalPoints: home.score + away.score,
    broadcast: broadcast || null,
    broadcastTier: broadcastTier(broadcast || null),
    nationalBroadcast,
    possessionTeamId: comp?.situation?.possession != null ? String(comp.situation.possession) : null,
    downDistance: comp?.situation?.downDistanceText ?? null,
    isRedZone: Boolean(comp?.situation?.isRedZone),
    conferenceGame: Boolean(comp.conferenceCompetition),
    // Filled in later from the standings feed; the scoreboard does not carry it.
    divisionGame: false,
    neutralSite: Boolean(comp.neutralSite),
    venue: comp?.venue?.fullName ?? null,
    odds: odds?.details ?? null,
    spread: typeof spreadRaw === "number" && Number.isFinite(spreadRaw) ? Math.abs(spreadRaw) : null,
    homeSpread: typeof spreadRaw === "number" && Number.isFinite(spreadRaw) ? spreadRaw : null,
    overUnder: typeof odds?.overUnder === "number" ? odds.overUnder : null,
    lastPlay: comp?.situation?.lastPlay?.text ?? null,
  };
}

export async function fetchScoreboard(opts: FetchOptions): Promise<ScoreboardResult> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 200) });
  // Sending groups to the NFL endpoint returns an empty slate.
  if (opts.league === "cfb") params.set("groups", opts.groups ?? "80");
  if (opts.dates) params.set("dates", opts.dates);

  const res = await fetch(`${SITE_API}/${SPORT_PATH[opts.league]}/scoreboard?${params}`, {
    headers: {
      accept: "application/json",
      // Identify ourselves rather than showing up as an anonymous bot.
      "user-agent": "football-watchability/0.1 (personal dashboard)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    throw new RateLimitError(res.headers.get("retry-after"));
  }
  if (!res.ok) throw new Error(`ESPN scoreboard returned ${res.status} ${res.statusText}`);

  const body: any = await res.json();
  const games = (body?.events ?? [])
    .map((e: unknown) => normalize(e, opts.league))
    .filter((g: RawGame | null): g is RawGame => g !== null);

  return {
    season: body?.season?.year ?? null,
    week: body?.week?.number ?? null,
    games,
  };
}




/**
 * Fetches one game's pregame closing line from ESPN's summary endpoint.
 *
 * The scoreboard drops `odds` the moment a game kicks off, but `pickcenter` on the
 * summary keeps the closing line through the game and after it is final. Verified
 * against 12 games: the spread is home-relative, negative meaning home favoured.
 */
export async function fetchPregameLine(
  league: League,
  eventId: string,
): Promise<{ homeSpread: number; overUnder: number | null; details: string | null } | null> {
  const url = `${SITE_API}/${SPORT_PATH[league]}/summary?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "football-watchability/0.1 (personal dashboard)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new RateLimitError(res.headers.get("retry-after"));
  if (!res.ok) throw new Error(`ESPN summary returned ${res.status} for ${eventId}`);

  const body: any = await res.json();
  const pick = body?.pickcenter?.[0] ?? body?.odds?.[0] ?? null;
  const spread = pick?.spread;
  if (typeof spread !== "number" || !Number.isFinite(spread)) return null;

  return {
    homeSpread: spread,
    overUnder: typeof pick?.overUnder === "number" ? pick.overUnder : null,
    details: pick?.details ?? null,
  };
}
