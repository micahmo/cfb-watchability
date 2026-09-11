<script lang="ts">
  import { PROFILE_LABELS, PROFILES, type ProfileName } from "../../shared/weights";
  import { persist, prefs } from "./prefs.svelte";

  const PROFILE_HINTS: Record<ProfileName, string> = {
    bestGame: "Rank purely on how close and how late, ignoring who is playing.",
    balanced: "Weigh closeness heavily, but let big programs and big TV slots break ties.",
    biggestGame: "Favour games the country is watching, even when they are less tight.",
  };

  function setProfile(name: ProfileName) {
    prefs.profile = name;
    persist();
  }
</script>

<div class="controls">
  <div class="segmented" role="radiogroup" aria-label="Ranking profile">
    {#each Object.keys(PROFILES) as name (name)}
      <button
        type="button"
        role="radio"
        aria-checked={prefs.profile === name}
        class:active={prefs.profile === name}
        title={PROFILE_HINTS[name as ProfileName]}
        onclick={() => setProfile(name as ProfileName)}
      >
        {PROFILE_LABELS[name as ProfileName]}
      </button>
    {/each}
  </div>
</div>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .segmented {
    display: inline-flex;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 2px;
  }
  .segmented button {
    background: none;
    border: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 11px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  @media (hover: hover) {
    .segmented button:hover {
      color: var(--text);
    }
  }
  .segmented button.active {
    background: var(--bg-card-hi);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border-hi);
  }
</style>
