import fs from "node:fs";
import path from "node:path";

/**
 * Durable storage for the one feature that needs it.
 *
 * Everything else here is a cache of ESPN that rebuilds within a poll or two, so
 * the container is disposable. Push notifications are not: a VAPID keypair that
 * changes silently invalidates every subscription anyone has made, and the
 * subscriptions themselves cannot be rebuilt from anywhere.
 *
 * So the feature is offered only when there is somewhere real to put them. A
 * container cannot be told it has a volume, but it can look: a mounted volume is
 * a separate mount from the container's own layer, and the filesystem type says
 * whether it is real storage or RAM.
 */

/** Mounted, but still gone when the container stops. */
const MEMORY_FILESYSTEMS = new Set(["tmpfs", "ramfs"]);

export type DurabilityReason =
  | "ok"
  | "not-configured"
  | "missing"
  | "not-writable"
  | "container-layer"
  | "memory";

export interface Durability {
  durable: boolean;
  reason: DurabilityReason;
  /** Filesystem backing the directory, when it could be determined. */
  fsType: string | null;
}

/**
 * The mount covering a path: its mount point and filesystem type, taken from the
 * longest match in /proc/self/mountinfo.
 *
 * What matters is the mount *point*, not the filesystem. A path still covered by
 * the root mount is on the container's own writable layer and dies with the
 * container; a path with its own deeper mount was given to us from outside.
 *
 * Testing the filesystem type alone looks right and is wrong. It assumes the
 * container layer is `overlay`, and on a host using the btrfs storage driver the
 * container's own layer reports `btrfs`, which passes for real storage. Found by
 * running the check inside the actual deployment rather than trusting it.
 */
function coveringMount(target: string): { point: string; type: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null; // Not Linux, or no procfs. Caller treats this as unknown.
  }

  let best: { point: string; type: string } | null = null;
  for (const line of raw.split("\n")) {
    // ... root mountPoint options - fsType source superOptions
    const [fields, rest] = line.split(" - ");
    if (rest === undefined) continue;
    const point = fields.split(" ")[4];
    const type = rest.split(" ")[0];
    if (point === undefined || type === undefined) continue;
    const covers = target === point || target.startsWith(point === "/" ? "/" : `${point}/`);
    if (covers && (best === null || point.length > best.point.length)) best = { point, type };
  }
  return best;
}

/** True when the process is inside a container, where the check means something. */
function inContainer(): boolean {
  return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
}

export function checkDurability(dir: string | undefined): Durability {
  if (!dir) return { durable: false, reason: "not-configured", fsType: null };

  const resolved = path.resolve(dir);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch {
    return { durable: false, reason: "missing", fsType: null };
  }
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch {
    return { durable: false, reason: "not-writable", fsType: null };
  }

  const mount = coveringMount(resolved);
  // Outside a container an ordinary directory is exactly as durable as the host,
  // which is all anyone can ask. The mount check only distinguishes anything when
  // there is a container layer to distinguish it from.
  if (!inContainer() || mount === null) return { durable: true, reason: "ok", fsType: mount?.type ?? null };

  if (MEMORY_FILESYSTEMS.has(mount.type)) {
    return { durable: false, reason: "memory", fsType: mount.type };
  }
  if (mount.point === "/") {
    return { durable: false, reason: "container-layer", fsType: mount.type };
  }
  return { durable: true, reason: "ok", fsType: mount.type };
}

export function explain(d: Durability): string {
  switch (d.reason) {
    case "ok":
      return `durable storage on ${d.fsType ?? "the host filesystem"}`;
    case "not-configured":
      return "no storage directory configured (set NOTIFY_DIR)";
    case "missing":
      return "the storage directory could not be created";
    case "not-writable":
      return "the storage directory is not writable";
    case "container-layer":
      return "the storage directory is on the container's own layer, so it would be lost on restart (mount a volume)";
    case "memory":
      return "the storage directory is in memory, so it would be lost on restart (mount a real volume)";
  }
}
