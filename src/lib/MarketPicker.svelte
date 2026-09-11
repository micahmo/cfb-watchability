<script lang="ts">
  import { clearMarket, prefs, redetectMarket, setZip } from "./prefs.svelte";

  let {
    stations,
    detected = null,
    city = null,
    nudge = false,
    open = false,
    ontoggle,
    onclose,
  }: {
    stations: string[];
    /** Postal code Cloudflare reported, when the network knew it. */
    detected?: string | null;
    /** City for that postal code, so the chip names a place not a transmitter. */
    city?: string | null;
    /** The slate splits by market and nothing has resolved one. */
    nudge?: boolean;
    open?: boolean;
    ontoggle?: () => void;
    onclose?: () => void;
  } = $props();

  /** What the board is actually using, whoever supplied it. */
  const active = $derived(prefs.marketOff ? null : (prefs.zip ?? detected));

  let draft = $state(prefs.zip ?? "");

  const valid = $derived(/^\d{5}$/.test(draft));
  /* A place, not a list of transmitters. The call signs mean nothing to someone
     who just wants to know the board is pointed at the right city. */
  const label = $derived(
    active === null
      ? prefs.marketOff
        ? "Market off"
        : "Set market"
      : city !== null
          ? `${city} ${active}`
        : active,
  );

  function save(): void {
    setZip(draft);
    onclose?.();
  }

  function clear(): void {
    draft = "";
    clearMarket();
    onclose?.();
  }

  function redetect(): void {
    draft = "";
    redetectMarket();
    onclose?.();
  }
</script>

<button type="button" class="dd-toggle" onclick={() => ontoggle?.()}>
  <!-- The whole explanation lives inside the panel. Out here a dot is enough to say
       there is something to set, and unlike a banner it costs no vertical space. -->
  {#if nudge && !open}<span class="dot" aria-hidden="true"></span>{/if}
  {label}
  <span class="dd-caret" class:open>▾</span>
</button>

{#if open}
  <div class="dd-panel">
    <p class="dd-hint">
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
        placeholder={active ?? "02134"}
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
      <p class="stations">Reading {stations.join(", ")}.</p>
    {/if}
  </div>
{/if}

<style>
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warm);
    flex: none;
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
