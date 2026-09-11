<script lang="ts">
  import type { League } from "../../shared/types";
  import { prefs, setAlerts } from "./prefs.svelte";
  import {
    fetchPushConfig,
    pushSupported,
    subscribe,
    unsubscribe,
    type Category,
    type PushConfig,
  } from "./push";

  let {
    league,
    marketZip = null,
    open = false,
    ontoggle,
  }: {
    league: League;
    /**
     * The postal code the board actually resolved, typed or detected.
     *
     * Not `prefs.zip`: that is null whenever the market came from the network,
     * which is the default path. Sending it left every subscription with no
     * market, so the promise that alerts skip games you cannot watch was quietly
     * doing nothing.
     */
    marketZip?: string | null;
    open?: boolean;
    ontoggle?: () => void;
  } = $props();

  /* Deliberately not a setting per category per league in one panel: that is
     eight checkboxes on a phone. The panel configures whichever league's tab you
     are on, the same way favourites does. */
  const LABELS: Record<Category, string> = {
    hero: "Turn this on",
    classic: "Instant classic",
    upset: "Upset alert",
    kickoff: "Kickoff",
  };
  const BLURB: Record<Category, string> = {
    hero: "A game gets good enough to switch to, with time left to get there",
    classic: "It goes from good to memorable",
    upset: "An underdog is doing something it should not be",
    kickoff: "The pick of a busy kickoff window is starting",
  };

  let config = $state<PushConfig | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const supported = pushSupported();
  /* Hidden rather than shown-and-disabled. A control that cannot do anything is
     an invitation to try, and explaining why would mean telling a viewer about
     the server's filesystem, which is none of their business. */
  const usable = $derived(supported && config?.available === true);
  const chosen = $derived(prefs.alerts[league] ?? []);
  const anyOn = $derived((prefs.alerts.nfl ?? []).length + (prefs.alerts.cfb ?? []).length > 0);
  const label = $derived(chosen.length > 0 ? `Alerts (${chosen.length})` : "Alerts");

  // Asked once on load rather than on open, so the control knows whether to
  // render itself at all before the viewer reaches for it.
  $effect(() => {
    if (config === null) void fetchPushConfig().then((c) => (config = c));
  });

  async function toggle(category: Category): Promise<void> {
    if (config === null || !config.publicKey) return;
    const next = chosen.includes(category)
      ? chosen.filter((c) => c !== category)
      : [...chosen, category];

    busy = true;
    error = null;
    const previous = prefs.alerts[league] ?? [];
    setAlerts(league, next);

    const wants = { nfl: prefs.alerts.nfl ?? [], cfb: prefs.alerts.cfb ?? [] };
    const nowEmpty = wants.nfl.length === 0 && wants.cfb.length === 0;

    try {
      if (nowEmpty) {
        await unsubscribe();
      } else {
        const ok = await subscribe({
          publicKey: config.publicKey,
          wants,
          zip: marketZip,
          favourites: prefs.favourites,
        });
        if (!ok) {
          // Permission refused, or the push service said no. Put the switch back
          // rather than showing it on when nothing will arrive.
          setAlerts(league, previous);
          error =
            Notification.permission === "denied"
              ? "Notifications are blocked for this site in your browser settings."
              : "Could not turn alerts on. Try again in a moment.";
        }
      }
    } catch {
      setAlerts(league, previous);
      error = "Could not reach the server.";
    } finally {
      busy = false;
    }
  }
</script>

{#if usable}
  <button type="button" class="dd-toggle" onclick={() => ontoggle?.()}>
    {label}
    <span class="dd-caret" class:open>▾</span>
  </button>
{/if}

{#if usable && open}
  <div class="dd-panel">
    {#if config}
      <p class="dd-hint">
        Alerts for {league === "nfl" ? "the NFL" : "college"}. Games your market is not carrying are
        never sent.
      </p>
      <div class="grid">
        {#each config.categories as category (category)}
          <label class="item" class:on={chosen.includes(category)}>
            <input
              type="checkbox"
              checked={chosen.includes(category)}
              disabled={busy}
              onchange={() => toggle(category)}
            />
            <span>
              <span class="name">{LABELS[category]}</span>
              <span class="blurb">{BLURB[category]}</span>
            </span>
          </label>
        {/each}
      </div>
      {#if error}<p class="error">{error}</p>{/if}
      {#if anyOn && !error}<p class="note">At most three a day per league.</p>{/if}
    {/if}
  </div>
{/if}

<style>
  .grid {
    display: grid;
    gap: 9px;
  }
  .item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .item input {
    margin-top: 2px;
    flex: none;
  }
  .name {
    display: block;
    font-weight: 600;
  }
  .item.on .name {
    color: var(--text);
  }
  .blurb {
    display: block;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-faint);
  }
  .error {
    margin: 9px 0 0;
    font-size: 11px;
    color: var(--warm);
  }
  .note {
    margin: 9px 0 0;
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
