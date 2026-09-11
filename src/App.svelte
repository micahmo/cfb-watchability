<script lang="ts">
  import type { Game, Snapshot } from "../shared/types";
  import { PROFILES, combine } from "../shared/weights";
  import { fetchSnapshot } from "./lib/api";
  import { dayDate, dayKey, dayLabel, relativeTime, scoreColor } from "./lib/format";
  import { prefs } from "./lib/prefs.svelte";
  import Controls from "./lib/Controls.svelte";
  import GameCard from "./lib/GameCard.svelte";
  import UpcomingRow from "./lib/UpcomingRow.svelte";

  const REFRESH_MS = 20_000;
  /** Planning horizon. Beyond a few days out, lines move and this stops being useful. */
  const MAX_DAYS = 3;
  const MAX_PER_DAY = 6;

  let snapshot = $state<Snapshot | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(true);
  // Ticks once a second purely so the "updated Ns ago" label stays honest.
  let now = $state(Date.now());

  async function refresh() {
    try {
      snapshot = await fetchSnapshot();
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      now = Date.now();
    }
  }

  $effect(() => {
    void refresh();
    const poll = setInterval(refresh, REFRESH_MS);
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  });

  // The server ships every score component, so switching profiles is instant
  // and needs no round trip.
  function scoreOf(game: Game): number {
    if (!game.score) return 0;
    return combine(game.score, PROFILES[prefs.profile], game.score.maxTotal);
  }

  const live = $derived.by(() =>
    [...(snapshot?.live ?? [])].sort((a, b) => scoreOf(b) - scoreOf(a)),
  );

  const top = $derived(live[0] ?? null);
  const topScore = $derived(top ? scoreOf(top) : 0);
  /* The label has to match what is actually on. Shouting "turn this on" at a
     mediocre 30 on a quiet weeknight is the same overpromise as calling a
     15-minute window a trend. */
  const heroLabel = $derived(
    topScore >= 75 ? "TURN THIS ON" : topScore >= 55 ? "BEST GAME ON" : "BEST OF WHAT IS ON",
  );
  const rest = $derived(live.slice(1));
  const recent = $derived(
    [...(snapshot?.recent ?? [])].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 5),
  );
  // Grouped by day, days in chronological order, ranked within each day. You plan
  // Friday before you plan Saturday, so a better Saturday game must not outrank
  // an earlier day's games in the list.
  const upcomingByDay = $derived.by(() => {
    const groups = new Map<string, Game[]>();
    for (const game of snapshot?.upcoming ?? []) {
      const key = dayKey(game.startDate);
      const bucket = groups.get(key);
      if (bucket) bucket.push(game);
      else groups.set(key, [game]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, MAX_DAYS)
      .map(([key, games]) => ({
        key,
        label: dayLabel(games[0].startDate),
        date: dayDate(games[0].startDate),
        games: [...games]
          .sort((a, b) => (b.anticipation ?? 0) - (a.anticipation ?? 0))
          .slice(0, MAX_PER_DAY),
      }));
  });

  const updatedLabel = $derived.by(() => {
    void now;
    return snapshot ? relativeTime(snapshot.updatedAt) : "never";
  });
</script>

<header>
  <div class="title-row">
    <h1>What should I be watching</h1>
    <div class="status">
      {#if loadError}
        <span class="err">offline</span>
      {:else if snapshot?.error}
        <span class="err">ESPN error</span>
      {:else}
        <span class="ok"></span>
      {/if}
      <span class="mono updated">updated {updatedLabel}</span>
    </div>
  </div>
  <p class="sub">
    Live football, ranked by how good the game is <em>right now</em>.
    {#if snapshot?.season}
      <span class="week">{snapshot.season} · week {snapshot.week}</span>
    {/if}
  </p>
  <Controls />
</header>

{#if loading}
  <p class="empty">Loading the slate...</p>
{/if}

{#if top}
  <section class="hero">
    <div class="hero-label">
      <span class="pill" class:hot={topScore >= 75} style="--pill: {scoreColor(topScore)}">
        {heroLabel}
      </span>
    </div>
    <GameCard game={top} score={scoreOf(top)} />
  </section>
{/if}

{#if rest.length}
  <section>
    <h2 class="section-head">Also live <span class="count">{rest.length}</span></h2>
    <div class="stack">
      {#each rest as game (game.id)}
        <GameCard {game} score={scoreOf(game)} />
      {/each}
    </div>
  </section>
{:else if !loading && !loadError && live.length === 0}
  <div class="panel">
    <strong>Nothing is live right now.</strong>
    <p class="hint">The board fills in once games kick off. What is coming up is below.</p>
  </div>
{/if}

<div class="two-col">
  {#if upcomingByDay.length}
    <section>
      <h2 class="section-head">Worth planning around</h2>
      {#each upcomingByDay as day (day.key)}
        <div class="day-group">
          <h3 class="day-head">
            {day.label}
            <span class="day-date">{day.date}</span>
          </h3>
          <div class="panel tight">
            {#each day.games as game (game.id)}
              <UpcomingRow {game} />
            {/each}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  {#if recent.length}
    <section>
      <h2 class="section-head">Just finished, best first</h2>
      <div class="stack">
        {#each recent as game (game.id)}
          <GameCard {game} score={scoreOf(game)} variant="final" />
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  header {
    margin-bottom: 26px;
  }
  .title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  h1 {
    font-size: 26px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-faint);
  }
  .ok {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--good);
  }
  .err {
    color: var(--hot);
    font-weight: 600;
  }
  .sub {
    margin: 8px 0 0;
    max-width: 74ch;
    color: var(--text-dim);
    line-height: 1.55;
  }
  .week {
    color: var(--text-faint);
    white-space: nowrap;
  }
  .hero {
    margin-bottom: 28px;
  }
  .hero-label {
    margin-bottom: 8px;
  }
  .pill {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.14em;
    color: var(--pill);
    border: 1px solid var(--pill);
    padding: 3px 9px;
    border-radius: 999px;
    opacity: 0.9;
  }
  .pill.hot {
    background: rgba(255, 77, 79, 0.1);
    opacity: 1;
  }
  .section-head {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint);
    margin: 26px 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .count {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 7px;
    font-size: 11px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .panel {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
  }
  .panel.tight {
    padding: 4px 14px;
  }
  .day-group + .day-group {
    margin-top: 14px;
  }
  .day-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
    font-weight: 650;
    margin: 0 0 6px 2px;
  }
  .day-date {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-faint);
  }
  .panel p {
    margin: 6px 0 0;
    color: var(--text-dim);
    font-size: 13px;
  }
  .hint {
    color: var(--text-faint) !important;
  }
  .empty {
    color: var(--text-faint);
  }
  /* Full width, stacked. Side by side starved the matchup column and truncated
     team names on anything but a very wide window. */
  .two-col {
    display: block;
  }
</style>
