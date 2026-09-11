<script lang="ts">
  import { prefs, setZip } from "./prefs.svelte";

  let { stations }: { stations: string[] } = $props();

  let open = $state(false);
  let draft = $state(prefs.zip ?? "");

  const valid = $derived(/^\d{5}$/.test(draft));
  /* Two or three call signs is enough to recognise your own market at a glance;
     the full list is eight channels of noise. */
  const label = $derived(
    prefs.zip === null
      ? "Set market"
      : stations.length
        ? `${prefs.zip} · ${stations.slice(0, 3).join(", ")}`
        : prefs.zip,
  );

  function save(): void {
    setZip(draft);
    open = false;
  }

  function clear(): void {
    draft = "";
    setZip(null);
    open = false;
  }
</script>

<button type="button" class="toggle" class:set={prefs.zip !== null} onclick={() => (open = !open)}>
  {label}
  <span class="caret" class:open>▾</span>
</button>

{#if open}
  <div class="panel">
    <p class="hint">
      On Sunday afternoons the networks split the slate by market, so only one CBS
      and one FOX game reaches any given city. Your postal code is what turns
      "regional" into which game is actually on your channels.
    </p>
    <div class="row">
      <input
        type="text"
        inputmode="numeric"
        maxlength="5"
        placeholder="02134"
        bind:value={draft}
        onkeydown={(e) => e.key === "Enter" && valid && save()}
      />
      <button type="button" class="save" disabled={!valid} onclick={save}>Save</button>
      {#if prefs.zip !== null}
        <button type="button" class="clear" onclick={clear}>Clear</button>
      {/if}
    </div>
    {#if prefs.zip !== null && stations.length}
      <p class="stations">Reading listings for {stations.join(", ")}.</p>
    {/if}
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
    /* Matches the segmented control and the favourites toggle beside it. */
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
  .toggle.set {
    color: var(--text);
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
    line-height: 1.5;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    padding: 6px 9px;
    width: 86px;
    letter-spacing: 0.06em;
  }
  input:focus {
    outline: none;
    border-color: var(--border-hi);
  }
  .save,
  .clear {
    background: none;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 11px;
    cursor: pointer;
  }
  .save:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .stations {
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
