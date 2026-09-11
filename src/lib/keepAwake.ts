/**
 * Holds a screen wake lock while there is a game to watch.
 *
 * Leaving the board up during a game and having the phone dim halfway through a
 * drive is the annoying case, so there is nothing to configure. Unlike a
 * presence board, though, this one gets left open on quiet afternoons too, and
 * holding the screen awake to display "nothing is live right now" is just
 * battery. So the lock follows the live list rather than the app being open.
 *
 * The browser drops the lock whenever the page stops being visible and never
 * restores it, so the visibility listener is the whole mechanism rather than a
 * refinement. It also means this cannot hold a phone awake in the background:
 * switch away and the lock is gone.
 */
let sentinel: WakeLockSentinel | null = null;
let wanted = false;
let listening = false;

async function sync(): Promise<void> {
  if (!("wakeLock" in navigator)) return;

  if (!wanted || document.visibilityState !== "visible") {
    // Releasing is best-effort: a lock the browser already dropped on its own
    // throws, and there is nothing useful to do about that.
    try {
      await sentinel?.release();
    } catch {
      // Already gone.
    }
    sentinel = null;
    return;
  }

  if (sentinel !== null && !sentinel.released) return;

  try {
    sentinel = await navigator.wakeLock.request("screen");
  } catch {
    // Battery saver refuses, and so does a backgrounded page. Neither is worth
    // surfacing: the screen simply behaves as it normally would.
    sentinel = null;
  }
}

/** Call with true while games are live, false when the board goes quiet. */
export function setKeepAwake(active: boolean): void {
  wanted = active;
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", () => void sync());
  }
  void sync();
}
