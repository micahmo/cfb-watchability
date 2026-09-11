/**
 * Notices when a newer build has been deployed while the board is open.
 *
 * Not through the service worker, which is the usual route and does not work
 * here: `sw.js` is copied into the build untouched and names no hashed bundles,
 * so it is byte identical between deploys and `updatefound` would never fire.
 *
 * The server reports which bundle it is serving on every snapshot, and the board
 * already asks for one every twenty seconds, so a deploy is noticed on the next
 * poll for free.
 *
 * Two earlier approaches are worth not repeating. Re-fetching `index.html` on a
 * timer worked but was as slow as the interval. Hanging it off "a request failed,
 * so the container must have restarted" was worse and is what shipped: a restart
 * that lands between two polls produces no error at all, so the check never ran
 * and the deploy went unnoticed indefinitely. That trigger was borrowed from an
 * app with a persistent event stream, where a dropped connection really is
 * unambiguous evidence; polling has no equivalent.
 */

/** The bundle this page loaded. Vite writes exactly one module script tag. */
export function runningBundle(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return script === null ? null : new URL(script.src, window.location.origin).pathname;
}

/** Whether the server is serving something other than what this page is running. */
export function isStale(serverBuild: string | null): boolean {
  if (serverBuild === null) return false;
  const running = runningBundle();
  if (running === null) return false;
  return new URL(serverBuild, window.location.origin).pathname !== running;
}
