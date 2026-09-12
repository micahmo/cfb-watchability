import crypto from "node:crypto";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { League } from "../shared/types.js";

/**
 * ESPN's own live-score push feed.
 *
 * Undocumented like every other endpoint here, and the same service espn.com
 * uses. It replaces nothing: REST polling stays the source of truth and this only
 * closes the gap between polls, so a failure here costs freshness rather than
 * correctness.
 *
 * The protocol, all of it learned by capture:
 *
 *   1. GET the host directory        -> { ip, securePort, token }
 *   2. upgrade to a websocket at     /FastcastService/pubsub/profiles/12000
 *   3. send { op: "C" }              -> { rc: 200, sid, hbi }
 *   4. send { op: "S", sid, tc }     -> { rc: 200 }
 *   5. receive { op: "P" | "R", pl } -> RFC 6902 JSON Patch against the scoreboard
 *
 * Three details are load-bearing and each one cost a capture to find. Node's
 * built-in `WebSocket` fails the upgrade, so the handshake is done by hand over
 * `https.request`. Patches arrive under **both** `op: "P"` and `op: "R"`, and
 * decoding only the first makes the feed look like it died after an opening
 * burst. And the payload's own `~c` field says how it is encoded: 1 is base64
 * zlib, 0 is the patch array already inline as JSON.
 */

const HOST_DIRECTORY = "https://fastcast.semfs.engsvc.go.com/public/websockethost";
const PROFILE_PATH = "/FastcastService/pubsub/profiles/12000";

export const TOPICS: Record<League, string> = {
  nfl: "scoreboard-football-nfl",
  cfb: "scoreboard-football-college-football",
};

/** One RFC 6902 operation, with ESPN's `uid/path/inside/event` addressing. */
export interface Patch {
  op: "add" | "remove" | "replace";
  /** `s:20~l:23~e:401858215/competitions/0/status/clock` */
  path: string;
  value?: unknown;
}

interface Frame {
  opcode: number;
  payload: Buffer;
  text: string;
  end: number;
}

/** Masked client frame. Servers must drop unmasked client frames, so this is not optional. */
function encodeFrame(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header: Buffer;
  if (body.length < 126) {
    header = Buffer.from([0x81, 0x80 | body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0xfe;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** A pong echoing the ping payload back, masked the same way. */
function encodePong(payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x8a, 0x80 | body.length]), mask, body]);
}

/** Yields whole frames, leaving any partial tail for the caller to keep buffered. */
function* decodeFrames(buf: Buffer): Generator<Frame> {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    let length = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (length === 126) {
      if (pos + 2 > buf.length) return;
      length = buf.readUInt16BE(pos);
      pos += 2;
    } else if (length === 127) {
      if (pos + 8 > buf.length) return;
      length = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    if (pos + length > buf.length) return;
    const payload = buf.subarray(pos, pos + length);
    yield { opcode, payload, text: payload.toString("utf8"), end: pos + length };
    offset = pos + length;
  }
}

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 10_000 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

/** Pulls the patch array out of a push, whichever way it was encoded. */
export function decodePatches(pl: string): Patch[] {
  const outer = JSON.parse(pl) as { "~c"?: number; pl?: unknown };
  if (outer["~c"] === 1) {
    const raw = zlib.inflateSync(Buffer.from(String(outer.pl), "base64")).toString("utf8");
    return JSON.parse(raw) as Patch[];
  }
  return (outer.pl ?? []) as Patch[];
}

export interface FastcastHandlers {
  onPatches: (patches: Patch[]) => void;
  /**
   * Fired on every connection, before any patch arrives.
   *
   * A gap in the stream leaves the local document wrong in ways no later patch
   * will correct, since a patch only carries the field that changed. So a fresh
   * connection means re-fetching over REST rather than trusting what is held.
   */
  onResync: () => void;
}

const MAX_BACKOFF_MS = 5 * 60_000;

/** One topic, one socket, reconnecting for as long as the process runs. */
export class FastcastClient {
  private socket: net.Socket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  private retrying = false;

  constructor(
    private readonly topic: string,
    private readonly handlers: FastcastHandlers,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.socket?.destroy();
    this.socket = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * `error` and `close` both fire on the same failure, so this guards against
   * scheduling two reconnections and ending up with two sockets on one topic.
   */
  private retry(why: string): void {
    if (this.stopped || this.retrying) return;
    this.retrying = true;
    this.clearHeartbeat();
    this.socket = null;
    this.failures += 1;
    const wait = Math.min(1000 * 2 ** this.failures, MAX_BACKOFF_MS);
    this.log(`${this.topic}: ${why}, reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(() => {
      this.retrying = false;
      void this.connect();
    }, wait).unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let host: { ip: string; securePort: number; token: string };
    try {
      host = await getJson(HOST_DIRECTORY);
    } catch (err) {
      this.retry(`host lookup failed (${err instanceof Error ? err.message : err})`);
      return;
    }

    const req = https.request({
      host: host.ip,
      port: host.securePort,
      path: `${PROFILE_PATH}?TrafficManager-Token=${host.token}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
      timeout: 15_000,
    });

    req.on("upgrade", (_res, socket) => {
      this.socket = socket;
      this.failures = 0;
      socket.on("error", (err) => this.retry(`socket error (${err.message})`));
      socket.on("close", () => this.retry("socket closed"));
      this.listen(socket);
      // Step 3 is a send, not a wait: the service stays silent until a session
      // is opened, which is what made the first capture look like a dead topic.
      socket.write(encodeFrame(JSON.stringify({ op: "C" })));
    });
    req.on("error", (err) => this.retry(`upgrade failed (${err.message})`));
    req.end();
  }

  private listen(socket: net.Socket): void {
    let buffered = Buffer.alloc(0);
    let sid: string | null = null;

    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      let consumed = 0;
      for (const frame of decodeFrames(buffered)) {
        consumed = frame.end;

        // Protocol pings, not the application heartbeat. Leaving these
        // unanswered is what silently kills the session after a couple of
        // minutes, and it is easy to miss because a JSON parser skips them.
        if (frame.opcode === 0x9) {
          socket.write(encodePong(frame.payload));
          continue;
        }
        if (frame.opcode === 0x8) continue;

        let message: any;
        try {
          message = JSON.parse(frame.text);
        } catch {
          continue;
        }

        if (message.op === "C") {
          sid = message.sid;
          const every = (message.hbi ?? 30) * 1000;
          this.clearHeartbeat();
          this.heartbeat = setInterval(() => {
            socket.write(encodeFrame(JSON.stringify({ op: "B", sid })));
          }, every);
          this.heartbeat.unref?.();
          socket.write(encodeFrame(JSON.stringify({ op: "S", sid, tc: this.topic })));
          this.log(`${this.topic}: connected`);
          this.handlers.onResync();
        } else if (message.op === "P" || message.op === "R") {
          try {
            const patches = decodePatches(message.pl);
            if (patches.length > 0) this.handlers.onPatches(patches);
          } catch {
            // A payload we cannot read changes nothing: the REST poll still
            // corrects the document within its own interval.
          }
        }
      }
      if (consumed > 0) buffered = buffered.subarray(consumed);
    });
  }
}

/**
 * Applies one operation to ESPN's event document.
 *
 * The path is the uid followed by an RFC 6901 pointer with no leading slash, so
 * the uid is split off by the caller and only the remainder is walked here.
 * Arrays use numeric segments, and `-` means append.
 *
 * Returns false when the path does not exist, which is normal rather than an
 * error: a patch can arrive for a field this document has never carried, and the
 * REST poll is what reconciles that.
 */
export function applyPatch(event: any, segments: string[], op: string, value: unknown): boolean {
  if (segments.length === 0) return false;
  let node = event;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = unescapeSegment(segments[i]);
    if (node === null || typeof node !== "object") return false;
    node = Array.isArray(node) ? node[Number(key)] : node[key];
  }
  if (node === null || typeof node !== "object") return false;

  const last = unescapeSegment(segments[segments.length - 1]);
  if (Array.isArray(node)) {
    if (op === "add") {
      if (last === "-") node.push(value);
      else node.splice(Number(last), 0, value);
      return true;
    }
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
    if (op === "remove") node.splice(index, 1);
    else node[index] = value;
    return true;
  }

  if (op === "remove") {
    if (!(last in node)) return false;
    delete node[last];
    return true;
  }
  node[last] = value;
  return true;
}

/** RFC 6901 escaping. The uid is split off before this runs, so its `~` is safe. */
function unescapeSegment(segment: string): string {
  return segment.includes("~") ? segment.replace(/~1/g, "/").replace(/~0/g, "~") : segment;
}

/** Splits `s:20~l:23~e:401858215/competitions/0/status/clock` into uid and pointer. */
export function splitPath(path: string): { uid: string; segments: string[] } | null {
  const cut = path.indexOf("/");
  if (cut <= 0) return null;
  return { uid: path.slice(0, cut), segments: path.slice(cut + 1).split("/") };
}
