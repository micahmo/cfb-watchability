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
     are on, the same way favorites does. */
  const LABELS: Record<Category, string> = {
    hero: "Turn this on",
    classic: "Instant classic",
    upset: "Upset alert",
    kickoff: "Kickoff",
    primetime: "Primetime",
  };
  const BLURB: Record<Category, string> = {
    hero: "A game gets good enough to switch to, with time left to get there",
    classic: "It goes from good to memorable",
    upset: "An underdog is doing something it should not be",
    kickoff: "The pick of a busy kickoff window is starting",
    primetime: "The only game in its slot is on. Might not be great, but football is on",
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

  /**
   * What the server was last told, so the sync below only acts on a real change.
   * Plain variables rather than state: writing them must not retrigger the effect
   * that writes them.
   */
  let synced: string | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Keeps the server's record matching what this browser currently knows.
   *
   * Registering only when a category is toggled left two silent failures. A
   * subscription could die and stay dead, because a push service may rotate an
   * endpoint and reinstalling the app produces a fresh worker with a new one, and in
   * both cases the server keeps a record nothing will ever be delivered to while the
   * viewer sees their switches still on. And anything learned *after* subscribing
   * never arrived: the market resolves from a snapshot, so subscribing from the
   * college tab registered no market at all, and changing a favorite conference
   * moved the board's own ranking without ever reaching the alerts that use it.
   *
   * Re-registering whenever the inputs change covers all of it, and the same call
   * repairs the endpoint on the way past. Silent by design: it never prompts, and
   * permission already being granted is what makes this a repair rather than a
   * request.
   */
  $effect(() => {
    const wants = { nfl: prefs.alerts.nfl ?? [], cfb: prefs.alerts.cfb ?? [] };
    const favorites = prefs.favorites;
    const zip = marketZip;
    const key = JSON.stringify({ wants, favorites, zip });

    if (config === null || !config.publicKey || !config.available) return;
    if (!anyOn || Notification.permission !== "granted") return;
    // A first run with nothing synced still goes, since that is the endpoint repair.
    if (key === synced) return;

    const publicKey = config.publicKey;
    // Ticking four conferences is one update, not four.
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      synced = key;
      void subscribe({ publicKey, wants, zip, favorites }).then((ok) => {
        // Let the next change try again rather than leaving the server behind.
        if (!ok) synced = null;
      });
    }, 800);
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

    // This call is the authoritative one, so the background sync must not repeat it.
    if (syncTimer !== null) clearTimeout(syncTimer);
    synced = nowEmpty ? null : JSON.stringify({ wants, favorites: prefs.favorites, zip: marketZip });

    try {
      if (nowEmpty) {
        await unsubscribe();
      } else {
        const ok = await subscribe({
          publicKey: config.publicKey,
          wants,
          zip: marketZip,
          favorites: prefs.favorites,
        });
        if (!ok) {
          // Permission refused, or the push service said no. Put the switch back
          // rather than showing it on when nothing will arrive.
          setAlerts(league, previous);
          synced = null;
          error =
            Notification.permission === "denied"
              ? "Notifications are blocked for this site in your browser settings."
              : "Could not turn alerts on. Try again in a moment.";
        }
      }
    } catch {
      setAlerts(league, previous);
      synced = null;
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
        <!-- College has no standalone slot: a Saturday night is a dozen games. -->
        {#each config.categories.filter((c) => c !== "primetime" || league === "nfl") as category (category)}
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
