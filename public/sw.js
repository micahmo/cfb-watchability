/**
 * Minimal service worker.
 *
 * Caching strategy, in priority order:
 *   - /api/*            network only. A stale scoreboard defeats the whole point.
 *   - /assets/*         cache first. Vite content-hashes these, so they are immutable.
 *   - everything else   network first, cache as fallback.
 *
 * The last rule matters: an earlier version served index.html cache-first, which
 * meant a deploy did not reach the phone until the *second* load. Network-first
 * keeps offline support while never showing yesterday's app.
 */
const CACHE = "football-watchability-v4";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Content-hashed build output never changes under a given name.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match("/index.html"))),
  );
});

/**
 * Push notifications.
 *
 * The payload is built server side so the wording can depend on things only the
 * server knows: how many other games are live, and whether this viewer's own
 * market is carrying the game. The worker just renders it.
 */
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  const { title, body, league, gameId, category } = payload;
  if (!title) return;
  event.waitUntil(
    Promise.all([
      acknowledge(),
      self.registration.showNotification(title, {
      body: body ?? "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One notification per game: a later alert about the same game replaces the
      // earlier one rather than stacking a second buzz for the same thing.
      tag: gameId ? `game-${gameId}` : undefined,
      renotify: true,
        data: { league, gameId, category },
      }),
    ]),
  );
});

/**
 * Tells the server a living install received this.
 *
 * A push service keeps accepting messages for an endpoint whose app was uninstalled
 * or reinstalled, so a delivery succeeding proves nothing about whether anything is
 * still there. Only a running worker can, and this is it saying so. Best effort:
 * losing an acknowledgement is harmless, and it must never cost the notification.
 */
async function acknowledge() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/notifications/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    // Recording only, so a failure changes nothing the viewer sees.
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const league = event.notification.data?.league;
  const url = league ? `/?league=${league}` : "/";
  // Focus an open board rather than opening a second copy of it.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
