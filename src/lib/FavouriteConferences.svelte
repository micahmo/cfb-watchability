<script lang="ts">
  import type { League } from "../../shared/types";
  import { isFavourite, prefs, toggleFavourite } from "./prefs.svelte";

  let { conferences, league }: { conferences: string[]; league: League } = $props();

  let open = $state(false);
  const chosen = $derived(prefs.favourites[league] ?? []);
</script>

{#if conferences.length}
  <button type="button" class="toggle" onclick={() => (open = !open)}>
    {chosen.length ? `Favourites: ${chosen.join(", ")}` : "Favourites"}
    <span class="caret" class:open>▾</span>
  </button>
{/if}

{#if open}
  <div class="panel">
    <p class="hint">Games involving these get a boost up the board.</p>
    <div class="grid">
      {#each conferences as conference (conference)}
        <label class="item" class:on={isFavourite(league, conference)}>
          <input
            type="checkbox"
            checked={isFavourite(league, conference)}
            onchange={() => toggleFavourite(league, conference)}
          />
          {conference}
        </label>
      {/each}
    </div>
  </div>
{/if}

<style>
  .toggle {
    background: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    /* Matches the height of the segmented control beside it. */
    height: 32px;
    padding: 0 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  @media (hover: hover) {
    .toggle:hover {
      color: var(--text);
      border-color: var(--border-hi);
    }
  }
  .caret {
    font-size: 10px;
    transition: transform 0.15s ease;
  }
  .caret.open {
    transform: rotate(180deg);
  }
  .panel {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    margin-top: 8px;
  }
  .hint {
    margin: 0 0 8px;
    font-size: 11px;
    color: var(--text-faint);
  }
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
