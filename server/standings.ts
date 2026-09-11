import type { RawGame } from "./espn.js";

/**
 * NFL divisions and playoff seeding.
 *
 * The scoreboard carries records but not division membership or seeding, and
 * there is no NFL equivalent of the college conference id. `?level=3` returns the
 * full conference/division tree with per-team stats, which is everything the
 * scoring model needs that the scoreboard cannot supply.
 *
 * College needs none of this: it has conference ids and AP ranks already.
 */
const STANDINGS = "https://site.api.espn.com/apis/v2/sports/football/nfl/standings?level=3";

/** Standings move once a week at most, so a long cache is plenty. */
const TTL_MS = 60 * 60 * 1000;

export interface TeamStanding {
  divisionId: string;
  divisionName: string;
  /** "AFC" or "NFC", the level a preference is worth expressing at. */
  conferenceName: string;
  /** 1..16 within the conference. 0 before any games have been played. */
  playoffSeed: number | null;
  winPct: number | null;
}

export class StandingsStore {
  private byTeamId = new Map<string, TeamStanding>();
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  get size(): number {
    return this.byTeamId.size;
  }

  get(teamId: string): TeamStanding | null {
    return this.byTeamId.get(teamId) ?? null;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(STANDINGS, {
      headers: {
        accept: "application/json",
        "user-agent": "football-watchability/0.1 (personal dashboard)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`NFL standings returned ${res.status}`);
    const body: any = await res.json();

    const next = new Map<string, TeamStanding>();
    // The tree is league -> conference -> division, and only divisions hold entries.
    const walk = (
      node: any,
      divisionId: string | null,
      divisionName: string | null,
      confName: string | null,
    ): void => {
      const entries = node?.standings?.entries ?? [];
      for (const entry of entries) {
        const teamId = entry?.team?.id != null ? String(entry.team.id) : null;
        if (teamId === null || divisionId === null) continue;
        const stats: Record<string, unknown> = {};
        for (const stat of entry?.stats ?? []) {
          if (stat?.name) stats[stat.name] = stat.value ?? stat.displayValue;
        }
        const seed = Number(stats.playoffSeed);
        const pct = Number(stats.winPercent);
        // The feed reports .000 for a team that has not played, which would read
        // as winless and punish every team in week one. Only trust it once there
        // are games behind it.
        const played =
          Number(stats.wins ?? 0) + Number(stats.losses ?? 0) + Number(stats.ties ?? 0);
        next.set(teamId, {
          divisionId,
          divisionName: divisionName ?? divisionId,
          conferenceName: confName ?? "",
          playoffSeed: Number.isFinite(seed) && seed > 0 ? seed : null,
          winPct: played > 0 && Number.isFinite(pct) ? pct : null,
        });
      }
      for (const child of node?.children ?? []) {
        const isDivision = (child?.children ?? []).length === 0;
        walk(
          child,
          isDivision ? String(child.id ?? child.name) : divisionId,
          isDivision ? (child.name ?? null) : divisionName,
          // The conference sits one level above the divisions, and its
          // abbreviation ("AFC") is what a preference should be expressed in.
          isDivision ? confName : (child.abbreviation ?? child.name ?? null),
        );
      }
    };
    walk(body, null, null, null);

    if (next.size > 0) {
      this.byTeamId = next;
      this.fetchedAt = Date.now();
    }
  }

  /** Refreshes at most once per TTL, and never twice concurrently. */
  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.fetchedAt < TTL_MS && this.byTeamId.size > 0) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh()
      .catch((err) => {
        // Stale standings are far better than a failed poll: the scoreboard data
        // is the important part and this only decorates it.
        console.error(`[NFL] standings failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Stamps division and seeding onto games in place. */
  async enrich(games: RawGame[]): Promise<void> {
    if (games.length === 0) return;
    await this.ensureFresh();
    if (this.byTeamId.size === 0) return;

    for (const game of games) {
      for (const side of [game.home, game.away]) {
        const standing = this.byTeamId.get(side.id);
        if (!standing) continue;
        side.divisionId = standing.divisionId;
        side.conferenceName = standing.conferenceName || side.conferenceName;
        side.playoffSeed = standing.playoffSeed;
        // The standings win percentage is authoritative; the scoreboard record is
        // a fallback for when a team is missing from the feed.
        side.winPct = standing.winPct ?? side.winPct;
      }
      game.divisionGame =
        game.home.divisionId !== null && game.home.divisionId === game.away.divisionId;
    }
  }
}
