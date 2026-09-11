<script lang="ts">
  import { isStale } from "./appUpdate";

  let { serverBuild = null }: { serverBuild?: string | null } = $props();

  let applying = $state(false);
  let dismissed = $state<string | null>(null);

  // Dismissing says "not now" about this build, not "never tell me again", so a
  // later deploy is announced again on a board left open all afternoon.
  const ready = $derived(isStale(serverBuild) && dismissed !== serverBuild);

  function reload(): void {
    applying = true;
    // The worker fetches HTML network first, so an ordinary reload picks up the new
    // bundle. No cache to clear and nothing to coordinate with the worker.
    window.location.reload();
  }
</script>

{#if ready}
  <!-- Polite rather than assertive: worth noticing, never worth interrupting a live game. -->
  <div class="toast" role="status">
    <span>A new version is available.</span>
    <button class="apply" onclick={reload} disabled={applying}>
      {applying ? "Refreshing..." : "Refresh"}
    </button>
    <button class="dismiss" onclick={() => (dismissed = serverBuild)} aria-label="Dismiss">&times;</button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    /* Anchored to both edges and centered with auto margins rather than left: 50% and
       a transform. A fixed element sizes itself against the space from its offsets to
       the edge, so left: 50% leaves it half the viewport to fit in and the text wraps
       while the box still looks like it has room to spare. */
    left: 0;
    right: 0;
    width: fit-content;
    margin: 0 auto;
    bottom: calc(16px + env(safe-area-inset-bottom));
    z-index: 20;

    display: flex;
    align-items: center;
    gap: 12px;

    max-width: calc(100vw - 32px);
    padding: 10px 11px 10px 16px;
    border: 1px solid var(--border-hi);
    border-radius: 10px;
    background: var(--bg-card-hi, var(--bg-card));
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }

  .apply {
    border: 1px solid var(--border-hi);
    border-radius: 7px;
    padding: 6px 12px;
    background: var(--bg-raised);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .apply:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .dismiss {
    border: none;
    background: none;
    color: var(--text-faint);
    font-size: 20px;
    line-height: 1;
    padding: 0 4px;
    cursor: pointer;
  }
</style>
