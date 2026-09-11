/**
 * Holds a screen wake lock for as long as the board is on screen.
 *
 * Bringing it up is the act of deciding to watch, so the screen dimming halfway
 * through a drive is the annoying case and there is nothing to configure:
 * closing the app is how you stop. Tying it to whether a game was live seemed
 * thriftier and was really just second-guessing the person holding the phone.
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

/** Starts holding the lock, and re-takes it whenever the app comes back on screen. */
export function keepScreenAwake(): void {
  wanted = true;
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", () => void sync());
  }
  void sync();
}
