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
    open = false,
    ontoggle,
  }: {
    league: League;
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
  const chosen = $derived(prefs.alerts[league] ?? []);
  const anyOn = $derived((prefs.alerts.nfl ?? []).length + (prefs.alerts.cfb ?? []).length > 0);
  const label = $derived(chosen.length > 0 ? `Alerts (${chosen.length})` : "Alerts");

  $effect(() => {
    if (open && config === null) void fetchPushConfig().then((c) => (config = c));
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
          zip: prefs.zip,
          favourites: prefs.favourites,
        });
        if (!ok) {
          // Permission refused, no service worker, or the push service said no.
          // Put the switch back rather than showing it on when nothing will come.
          setAlerts(league, previous);
          error =
            Notification.permission === "denied"
              ? "Notifications are blocked for this site in your browser settings."
              : (await navigator.serviceWorker.getRegistration()) === undefined
                ? "No service worker. Open the board over HTTPS, or install it first."
                : "Could not subscribe.";
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

<button type="button" class="dd-toggle" onclick={() => ontoggle?.()}>
  {label}
  <span class="dd-caret" class:open>▾</span>
</button>

{#if open}
  <div class="dd-panel">
    {#if !supported}
      <p class="dd-hint">
        This browser cannot do push notifications. On iOS the board has to be added to the home
        screen first.
      </p>
    {:else if config === null}
      <p class="dd-hint">Checking…</p>
    {:else if !config.available}
      <p class="dd-hint">
        The server has nowhere durable to keep subscriptions, so alerts are turned off. Mount a
        volume and set <code>NOTIFY_DIR</code> to enable them.
      </p>
    {:else}
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
  code {
    font-size: 10px;
  }
</style>
