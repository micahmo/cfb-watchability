<script lang="ts">
  import type { League } from "../../shared/types";
  import { isFavorite, prefs, toggleFavorite } from "./prefs.svelte";

  let {
    conferences,
    league,
    open = false,
    ontoggle,
  }: {
    conferences: string[];
    league: League;
    /** Owned by the parent so only one panel in the row can be open at a time. */
    open?: boolean;
    ontoggle?: () => void;
  } = $props();
  const chosen = $derived(prefs.favorites[league] ?? []);
</script>

{#if conferences.length}
  <button type="button" class="dd-toggle" onclick={() => ontoggle?.()}>
    {chosen.length ? `Favorites: ${chosen.join(", ")}` : "Favorites"}
    <span class="dd-caret" class:open>▾</span>
  </button>
{/if}

{#if open}
  <div class="dd-panel">
    <p class="dd-hint">Games involving these get a boost up the board.</p>
    <div class="grid">
      {#each conferences as conference (conference)}
        <label class="item" class:on={isFavorite(league, conference)}>
          <input
            type="checkbox"
            checked={isFavorite(league, conference)}
            onchange={() => toggleFavorite(league, conference)}
          />
          {conference}
        </label>
      {/each}
    </div>
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 6px 12px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .item.on {
    color: var(--text);
    font-weight: 600;
  }
</style>
