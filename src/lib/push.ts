import type { League } from "../../shared/types";

export type Category = "hero" | "classic" | "upset" | "kickoff" | "primetime";

export interface PushConfig {
  available: boolean;
  publicKey: string | null;
  categories: Category[];
}

/** Whether this browser can do web push at all. iOS needs the PWA installed. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function fetchPushConfig(): Promise<PushConfig> {
  try {
    const res = await fetch("/api/notifications/config", { cache: "no-store" });
    if (!res.ok) return { available: false, publicKey: null, categories: [] };
    return (await res.json()) as PushConfig;
  } catch {
    return { available: false, publicKey: null, categories: [] };
  }
}

/** The server hands out a base64url VAPID key; the browser wants raw bytes. */
function decodeKey(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * The active service worker, or null.
 *
 * `serviceWorker.ready` never settles when registration failed, rather than
 * rejecting, so awaiting it bare hangs the caller forever. That is not
 * hypothetical: registration is skipped on a plain-http LAN address, which is a
 * documented way to run this, and it left the alerts toggle spinning with no
 * error and no way back.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (!existing) return null;
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
  } catch {
    return null;
  }
}

export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

export interface SubscribeInput {
  publicKey: string;
  wants: Record<League, Category[]>;
  zip: string | null;
  favourites: Record<League, string[]>;
}

/**
 * Subscribes this browser and registers the preferences with it.
 *
 * The server needs the postal code and favourites alongside the endpoint,
 * because it evaluates alerts the way this viewer's own board would: a game
 * their market is not carrying is not worth a notification, and a favourite
 * conference quietly lowers the bar.
 */
export async function subscribe(input: SubscribeInput): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission !== "granted") {
    const granted = await Notification.requestPermission();
    if (granted !== "granted") return false;
  }
  const reg = await registration();
  if (reg === null) return false;

  let sub = await reg.pushManager.getSubscription();
  if (sub === null) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(input.publicKey) as BufferSource,
      });
    } catch {
      return false;
    }
  }

  const raw = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const res = await fetch("/api/notifications/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: raw.endpoint,
      keys: raw.keys,
      wants: input.wants,
      zip: input.zip,
      favourites: input.favourites,
    }),
  });
  return res.ok;
}

/** Drops the server record and the browser's own subscription together. */
export async function unsubscribe(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/notifications/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
