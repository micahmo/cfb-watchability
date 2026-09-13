<script lang="ts">
  import { prefs, setDelaySeconds, MAX_DELAY_SECONDS } from "./prefs.svelte";

  let {
    open = false,
    ontoggle,
    /** Snapshots received but not yet shown, purely so the panel can say it is working. */
    queued = 0,
  }: { open?: boolean; ontoggle?: () => void; queued?: number } = $props();

  /*
   * A nudge, not a guess.
   *
   * Nobody knows their own broadcast latency, and asking is asking the wrong
   * question: the answer is whatever makes the score change on the board at the
   * moment it changes on the television. So the control is built to be adjusted
   * while watching, in small steps, with the current value always in the chip so
   * it can be read without opening anything.
   */
  const STEP = 5;
  const label = $derived(prefs.delaySeconds === 0 ? "Live" : `−${prefs.delaySeconds}s`);

  function nudge(by: number): void {
    setDelaySeconds(prefs.delaySeconds + by);
  }
</script>

<button type="button" class="dd-toggle" onclick={() => ontoggle?.()}>
  {label}
  <span class="dd-caret" class:open>▾</span>
</button>

{#if open}
  <div class="dd-panel">
    <p class="dd-hint">
      Hold the board behind live, so it stops telling you what happened before your television does.
      Nudge it until the score changes on screen at the same moment you see it.
    </p>

    <div class="row">
      <button type="button" onclick={() => nudge(-STEP)} disabled={prefs.delaySeconds === 0}>
        −{STEP}s
      </button>
      <span class="value mono">{prefs.delaySeconds === 0 ? "Live" : `${prefs.delaySeconds}s behind`}</span>
      <button
        type="button"
        onclick={() => nudge(STEP)}
        disabled={prefs.delaySeconds >= MAX_DELAY_SECONDS}
      >
        +{STEP}s
      </button>
    </div>

    <input
      type="range"
      min="0"
      max={MAX_DELAY_SECONDS}
      step="1"
      value={prefs.delaySeconds}
      oninput={(e) => setDelaySeconds(Number(e.currentTarget.value))}
      aria-label="Seconds behind live"
    />

    <div class="presets">
      <!-- Rough starting points rather than promises. Cable sits near the bottom
           of this range and an app near the top, and the slider is what actually
           settles it. -->
      <button type="button" class:on={prefs.delaySeconds === 0} onclick={() => setDelaySeconds(0)}>
        Live
      </button>
      <button type="button" class:on={prefs.delaySeconds === 15} onclick={() => setDelaySeconds(15)}>
        Cable
      </button>
      <button type="button" class:on={prefs.delaySeconds === 35} onclick={() => setDelaySeconds(35)}>
        Streaming
      </button>
    </div>

    {#if prefs.delaySeconds > 0}
      <p class="note">
        {queued} update{queued === 1 ? "" : "s"} held back. Notifications use the same delay.
      </p>
    {/if}
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .row button,
  .presets button {
    padding: 6px 12px;
    border: 1px solid var(--border-hi);
    border-radius: 999px;
    background: var(--bg-card-hi);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .row button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .value {
    flex: 1;
    text-align: center;
    font-size: 15px;
    font-weight: 600;
  }
  input[type="range"] {
    width: 100%;
    margin: 0 0 10px;
    accent-color: var(--accent);
  }
  .presets {
    display: flex;
    gap: 6px;
  }
  .presets button.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .note {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
