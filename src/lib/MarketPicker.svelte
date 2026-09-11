<script lang="ts">
  import { clearMarket, prefs, redetectMarket, setZip } from "./prefs.svelte";

  let {
    stations,
    detected = null,
    nudge = false,
  }: {
    stations: string[];
    /** Postal code Cloudflare reported, when the network knew it. */
    detected?: string | null;
    /** The slate splits by market and nothing has resolved one. */
    nudge?: boolean;
  } = $props();

  /** What the board is actually using, whoever supplied it. */
  const active = $derived(prefs.marketOff ? null : (prefs.zip ?? detected));

  let open = $state(false);
  let draft = $state(prefs.zip ?? "");

  const valid = $derived(/^\d{5}$/.test(draft));
  /* Two or three call signs is enough to recognise your own market at a glance;
     the full list is eight channels of noise. */
  const label = $derived(
    active === null
      ? prefs.marketOff
        ? "Market off"
        : "Set market"
      : stations.length
        ? `${active} · ${stations.slice(0, 3).join(", ")}`
        : active,
  );

  function save(): void {
    setZip(draft);
    open = false;
  }

  function clear(): void {
    draft = "";
    clearMarket();
    open = false;
  }

  function redetect(): void {
    draft = "";
    redetectMarket();
    open = false;
  }
</script>

<button type="button" class="toggle" class:set={active !== null} onclick={() => (open = !open)}>
  <!-- The whole explanation lives inside the panel. Out here a dot is enough to say
       there is something to set, and unlike a banner it costs no vertical space. -->
  {#if nudge && !open}<span class="dot" aria-hidden="true"></span>{/if}
  {label}
  <span class="caret" class:open>▾</span>
</button>

{#if open}
  <div class="panel">
    <p class="hint">
      {#if prefs.marketOff}
        Market filtering is off, so nothing is flagged as unavailable.
      {:else if prefs.zip === null && detected !== null}
        Using <strong>{detected}</strong>, worked out from your connection. Enter a
        postal code to override it.
      {:else}
        On Sunday afternoons the networks split the slate by market, so only one CBS
        and one FOX game reaches any given city. Your postal code is what turns
        "regional" into which game is actually on your channels.
      {/if}
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
      {#if active !== null}
        <button type="button" class="clear" onclick={clear}>Clear</button>
      {/if}
      <!-- So opting out, or overriding once, is not a one-way door back to typing. -->
      {#if prefs.marketOff || prefs.zip !== null}
        <button type="button" class="clear" onclick={redetect}>Redetect</button>
      {/if}
    </div>
    {#if active !== null && stations.length}
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
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warm);
    flex: none;
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
