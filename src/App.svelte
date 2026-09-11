<script lang="ts">
  import type { Game, League, Snapshot } from "../shared/types";
  import { DEFAULT_PROFILE, PROFILES, combine } from "../shared/weights";
  import { fetchSnapshot } from "./lib/api";
  import { dayDate, dayKey, dayLabel, relativeTime, scoreColor } from "./lib/format";
  import { isFavourite, prefs } from "./lib/prefs.svelte";
  import LeagueTabs from "./lib/LeagueTabs.svelte";
  import FavouriteConferences from "./lib/FavouriteConferences.svelte";
  import MarketPicker from "./lib/MarketPicker.svelte";
  import AlertsPicker from "./lib/AlertsPicker.svelte";
  import UpdatePrompt from "./lib/UpdatePrompt.svelte";

  import GameCard from "./lib/GameCard.svelte";
  import UpcomingRow from "./lib/UpcomingRow.svelte";

  const REFRESH_MS = 20_000;
  /** Planning horizon. Beyond a few days out, lines move and this stops being useful. */
  const MAX_DAYS = 3;
  const MAX_PER_DAY = 6;

  /** Day keys the user has expanded past MAX_PER_DAY. */
  let expanded = $state<Record<string, boolean>>({});

  /**
   * Which control has its panel down. Owned here rather than by each control,
   * because they share a row: two panels open at once would overlap, and a panel
   * that is a flex sibling of its own button wedges the row apart when it opens.
   */
  let openPanel = $state<"favourites" | "market" | "alerts" | null>(null);

  /**
   * The last market the board resolved, kept across tab switches.
   *
   * `snapshot.market` is null on the college tab, because splitting a slate by
   * market is an NFL-only problem. Reading it directly meant a subscription made
   * from the college tab registered no market at all, which silently disabled the
   * one gate that stops alerts for games you cannot watch.
   */
  let lastMarketZip = $state<string | null>(null);
  $effect(() => {
    const zip = snapshot?.market?.zip;
    if (zip) lastMarketZip = zip;
  });

  function togglePanel(which: "favourites" | "market" | "alerts"): void {
    openPanel = openPanel === which ? null : which;
  }

  let snapshot = $state<Snapshot | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(true);
  // Ticks once a second purely so the "updated Ns ago" label stays honest.
  let now = $state(Date.now());

  async function refresh(league: League) {
    try {
      const next = await fetchSnapshot(league, prefs.zip, prefs.marketOff);
      // Discard a response that arrived after the user switched tabs.
      if (next.league !== prefs.league) return;
      snapshot = next;
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      now = Date.now();
    }
  }

  $effect(() => {
    const league = prefs.league;
    // Read deliberately: changing either has to re-run the effect, since
    // availability is resolved server side.
    prefs.zip;
    prefs.marketOff;
    snapshot = null;
    loading = true;
    void refresh(league);
    const poll = setInterval(() => void refresh(league), REFRESH_MS);
    return () => clearInterval(poll);
  });

  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  /**
   * A nudge, not an override. A favoured conference should float a game up past
   * its neighbours without letting a dull one outrank a genuinely great game.
   */
  /**
   * Graded, not binary. An all-AFC game is more of an AFC game than a
   * cross-conference one, so it should outrank it, but the second team adds less
   * than the first did: one team you care about is already most of the reason to
   * watch. So the order is both teams, then one, then neither.
   */
  const FAVOURITE_BONUS = [0, 8, 13];

  function favouriteBoost(game: Game): number {
    const matches =
      Number(isFavourite(prefs.league, game.home.conferenceName)) +
      Number(isFavourite(prefs.league, game.away.conferenceName));
    return FAVOURITE_BONUS[matches];
  }

  // The server ships every score component and the browser recombines them, so
  // favourites reorder the board without a round trip.
  function scoreOf(game: Game): number {
    if (!game.score) return 0;
    // One fixed weighting. Three selectable profiles shipped for a while and
    // measurably did nothing: across a full Saturday the top game was identical
    // under all three, nothing moved more than two places, and what movement
    // there was landed at positions nine through twelve. Tune these numbers
    // instead of asking the reader to.
    const base = combine(game.score, PROFILES[DEFAULT_PROFILE], game.score.maxTotal);
    return Math.min(100, base + favouriteBoost(game));
  }

  function anticipationOf(game: Game): number {
    return Math.min(100, (game.anticipation ?? 0) + favouriteBoost(game));
  }

  /**
   * A game the viewer's own channels are not carrying still gets its real score,
   * because the score says how good the game is. It just stops being offered
   * first, since recommending something unwatchable is no recommendation at all.
   */
  function watchable(game: Game): boolean {
    return game.marketStations === null || game.marketStations.length > 0;
  }

  function byWatchableThen(
    rank: (game: Game) => number,
  ): (a: Game, b: Game) => number {
    return (a, b) =>
      Number(watchable(b)) - Number(watchable(a)) || rank(b) - rank(a);
  }

  /**
   * Whether the slate actually contains market-split games, so the nudge only
   * appears when it would change something. A Thursday night slate is one
   * national game with nothing to resolve.
   */
  const marketMatters = $derived(
    snapshot?.market == null &&
      !prefs.marketOff &&
      [...(snapshot?.live ?? []), ...(snapshot?.upcoming ?? [])].some(
        (g) => (g.regionalPeers ?? 0) > 1,
      ),
  );

  /** Conferences present in the current league's slate, for the preference list. */
  const conferences = $derived.by(() => {
    const all = [
      ...(snapshot?.live ?? []),
      ...(snapshot?.upcoming ?? []),
      ...(snapshot?.recent ?? []),
    ];
    const names = new Set<string>();
    for (const g of all) {
      if (g.home.conferenceName) names.add(g.home.conferenceName);
      if (g.away.conferenceName) names.add(g.away.conferenceName);
    }
    return [...names].sort();
  });

  const live = $derived.by(() =>
    [...(snapshot?.live ?? [])].sort(byWatchableThen(scoreOf)),
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
      .map(([key, games]) => {
        const ranked = [...games].sort(byWatchableThen(anticipationOf));
        const showAll = expanded[key] === true;
        const shown = showAll ? ranked : ranked.slice(0, MAX_PER_DAY);
        return {
          key,
          /* Split rather than marked with a divider. A label above a row reads as
             belonging to that row, so with one game below it there was no way to
             tell whether it covered one or all of them. */
          available: shown.filter((g) => watchable(g)),
          unavailable: shown.filter((g) => !watchable(g)),
          label: dayLabel(games[0].startDate),
          date: dayDate(games[0].startDate),
          total: ranked.length,
          hidden: Math.max(0, ranked.length - MAX_PER_DAY),
          showAll,
          games: shown,
        };
      });
  });

  const updatedLabel = $derived.by(() => {
    void now;
    return snapshot ? relativeTime(snapshot.updatedAt) : "never";
  });
</script>

<header>
  <!-- One compact bar. The title and strapline used to cost ~110px of a phone
       screen to say something the user already knows, and an installed PWA
       already shows the app name in the task switcher. -->
  <div class="topbar">
    <LeagueTabs />
    <div class="status">
      {#if loadError}
        <span class="err">offline</span>
      {:else if snapshot?.error}
        <span class="err">ESPN error</span>
      {:else}
        <span class="ok"></span>
      {/if}
      <span class="mono updated">{updatedLabel}</span>
    </div>
  </div>
  <div class="controls-row">
    <FavouriteConferences
      {conferences}
      league={prefs.league}
      open={openPanel === "favourites"}
      ontoggle={() => togglePanel("favourites")}
    />
    {#if prefs.league === "nfl"}
      <MarketPicker
        stations={snapshot?.market?.stations ?? []}
        detected={snapshot?.market?.detected === true ? snapshot.market.zip : null}
        city={snapshot?.market?.city ?? null}
        nudge={marketMatters}
        open={openPanel === "market"}
        ontoggle={() => togglePanel("market")}
        onclose={() => (openPanel = null)}
      />
    {/if}
    <AlertsPicker
      league={prefs.league}
      marketZip={lastMarketZip}
      open={openPanel === "alerts"}
      ontoggle={() => togglePanel("alerts")}
    />
  </div>
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
            <!-- Wrapped so the last available row is a :last-child and drops its
                 bottom border. That border drew a line directly above the header
                 below, which together with the first unavailable row's own border
                 boxed the two into what looked like a single entry. A section
                 header should sit in whitespace, not inside a cell. -->
            <div class="tier">
              {#each day.available as game (game.id)}
                <UpcomingRow {game} score={anticipationOf(game)} />
              {/each}
            </div>
            {#if day.unavailable.length > 0}
              <div class="blocked">
                <p class="cutoff">
                  not on your channels
                  <svg class="down" viewBox="0 0 10 12" aria-hidden="true">
                    <path d="M5 1 V9 M1.5 6 L5 9.5 L8.5 6" />
                  </svg>
                </p>
                {#each day.unavailable as game (game.id)}
                  <UpcomingRow {game} score={anticipationOf(game)} />
                {/each}
              </div>
            {/if}
            {#if day.hidden > 0 || day.showAll}
              <button
                type="button"
                class="show-all"
                onclick={() => (expanded[day.key] = !day.showAll)}
              >
                {day.showAll ? "Show fewer" : `Show all ${day.total}`}
              </button>
            {/if}
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

<UpdatePrompt serverBuild={snapshot?.build ?? null} />

<style>
  header {
    margin-bottom: 16px;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  /* Scoped under .panel to outrank ".panel p", which sets the day cards' body
     text to 13px and was silently winning against a bare .cutoff.
     No rule of its own: the rows above and below already carry full-width
     borders, and a second half-width line butting into them read as a mistake. */
  /* Styled as a section header, because that is what it is. Earlier attempts
     dressed it as a caption and then as a banded block, and both read as
     belonging to the row directly beneath rather than to everything below.
     Matching the idiom this page already uses for "Worth planning around",
     smaller since this one sits inside a card, settles what it refers to. The
     space above does the work: it separates the label from the rows it is not
     about. Scoped under .panel to outrank ".panel p", which sets card body text
     to 13px and was silently winning against a bare .cutoff. */
  .panel .cutoff {
    /* Centred as a flex row rather than by vertical-align. The marker is a
       replaced element aligned on the baseline, which left it four pixels above
       the text's optical centre; these are uppercase with no descenders, so
       centring on the line box lands within half a pixel of the ink. */
    display: flex;
    align-items: center;
    /* Bounded top and bottom, so it is an entry in the list rather than the top
       of the entry below it. A single rule above was not enough: it left the
       header and the first unavailable row sharing one cell, which is the thing
       that kept reading wrong. Every other row here is delimited by lines, so a
       header has to be too. The available rows are wrapped so the last one drops
       its own bottom border, which keeps this to one line rather than two. */
    margin: 0;
    padding: 9px 4px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint);
  }
  /* Drawn rather than set in a glyph. The arrow characters render tall and thin
     at this size, and a solid triangle is the dropdown caret used everywhere else
     on this page. This is short, thick, and unambiguously an arrow, and it does
     not vary with whatever font happens to be resolved. */
  .panel .cutoff .down {
    width: 9px;
    height: 11px;
    margin-left: 5px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.7;
  }
  .controls-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }
  /* An open panel takes a whole row of its own and is ordered after both buttons,
     so it pushes the board down rather than covering it, and never wedges itself
     between the two controls the way a plain flex sibling did. */
  .controls-row :global(.dd-panel) {
    order: 1;
    flex-basis: 100%;
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
    /* So a full-bleed child cannot square off the card's rounded corners. */
    overflow: hidden;
  }
  .panel.tight {
    padding: 4px 14px;
  }
  .show-all {
    display: block;
    width: 100%;
    background: none;
    border: none;
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 9px 0;
    cursor: pointer;
  }
  @media (hover: hover) {
    .show-all:hover {
      color: var(--text);
    }
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
