<script lang="ts">
  import type { League } from "../../shared/types";
  import { persist, prefs } from "./prefs.svelte";

  const LABELS: Record<League, string> = { cfb: "College", nfl: "NFL" };

  function choose(league: League) {
    if (prefs.league === league) return;
    prefs.league = league;
    persist();
  }
</script>

<nav class="tabs" aria-label="League">
  {#each Object.keys(LABELS) as league (league)}
    <button
      type="button"
      class:active={prefs.league === league}
      aria-current={prefs.league === league ? "page" : undefined}
      onclick={() => choose(league as League)}
    >
      {LABELS[league as League]}
    </button>
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 14px;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-faint);
    font: inherit;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.01em;
    padding: 4px 12px 7px;
    cursor: pointer;
  }
  @media (hover: hover) {
    .tabs button:hover {
      color: var(--text-dim);
    }
  }
  .tabs button.active {
    color: var(--text);
    border-bottom-color: var(--hot);
  }
</style>
