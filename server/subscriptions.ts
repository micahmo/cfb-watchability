import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import type { League } from "../shared/types.js";
import { checkDurability, explain, type Durability } from "./storage.js";

/** The alert kinds a viewer can subscribe to, per league. */
export type Category = "hero" | "classic" | "upset" | "kickoff" | "primetime";
export const CATEGORIES: Category[] = ["hero", "classic", "upset", "kickoff", "primetime"];

export interface Subscription {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Categories per league. An empty list means this league is off. */
  wants: Record<League, Category[]>;
  /** Mirrors the viewer's board settings, so alerts match what they would see. */
  zip: string | null;
  favorites: Record<League, string[]>;
  createdAt: string;
  /**
   * When a push service last accepted a message for this endpoint, and when a
   * service worker last said it actually arrived.
   *
   * Both are needed because neither is enough alone. Reinstalling the app orphans
   * a subscription: the new install is a fresh worker with a new endpoint, the old
   * record survives because nothing reports its death, and the push service keeps
   * returning success for the dead endpoint rather than the 410 `send` watches for.
   * Deduplicating at subscribe time cannot help, since the new install has no memory
   * of the endpoint it replaced. A living worker is the only thing that can testify,
   * so it acknowledges, and a gap between these two is the evidence.
   */
  lastPushAt: string;
  lastAckAt: string;
}

interface Stored {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: Subscription[];
}

const FILE = "notifications.json";

/**
 * How long a subscription may be pushed to without a single acknowledgement before
 * it is treated as gone.
 *
 * Measured as the gap between the two timestamps rather than against the clock, so
 * a quiet stretch costs nothing: a subscription nobody had reason to push to accrues
 * no gap however old its last acknowledgement. Generous on purpose. Its job is
 * orphans, whose gap grows without bound, so any sane value catches them; what the
 * number has to clear is the other direction, the longest a real phone can go
 * unacknowledged across sleep, dead zones and iOS throttling. Being wrong that way
 * deletes a live subscription, and here that is now self-healing rather than silent,
 * since the board re-registers on its next load.
 */
const DEAD_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Subscriptions and the VAPID keypair, on disk.
 *
 * A JSON file rather than a database: this is a handful of records written when
 * somebody toggles a switch, and a database would be the largest dependency in
 * the project by an order of magnitude. Dedupe state is deliberately *not* here,
 * because it does not need to be: alerts fire on transitions, and the first poll
 * after startup seeds the current state silently, so a restart is quiet rather
 * than repetitive.
 */
export class SubscriptionStore {
  private data: Stored | null = null;
  private readonly dir: string | undefined;
  readonly durability: Durability;

  constructor(dir: string | undefined) {
    this.dir = dir;
    this.durability = checkDurability(dir);
    if (!this.durability.durable) {
      console.log(`[notify] disabled: ${explain(this.durability)}`);
      return;
    }
    this.data = this.load();
    // `??` is wrong here: an unset template variable arrives as an empty string,
    // not undefined, and web-push rejects a blank subject by throwing.
    const contact = (process.env.NOTIFY_CONTACT ?? "").trim();
    webpush.setVapidDetails(
      contact.length > 0 ? contact : "mailto:nobody@example.com",
      this.data.vapid.publicKey,
      this.data.vapid.privateKey,
    );
    console.log(
      `[notify] enabled: ${explain(this.durability)}, ${this.data.subscriptions.length} subscription(s)`,
    );
  }

  get available(): boolean {
    return this.data !== null;
  }

  get publicKey(): string | null {
    return this.data?.vapid.publicKey ?? null;
  }

  get all(): Subscription[] {
    return this.data?.subscriptions ?? [];
  }

  private get file(): string {
    return path.join(path.resolve(this.dir as string), FILE);
  }

  private load(): Stored {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Stored;
      if (parsed?.vapid?.publicKey && parsed?.vapid?.privateKey) {
        parsed.subscriptions ??= [];
        // Records written before acknowledgement tracking existed have neither
        // timestamp. Start them level rather than letting an absent value read as
        // an infinitely old acknowledgement and prune a live subscription on boot.
        const now = new Date().toISOString();
        for (const sub of parsed.subscriptions) {
          sub.lastPushAt ??= sub.createdAt ?? now;
          sub.lastAckAt ??= sub.createdAt ?? now;
        }
        return parsed;
      }
      console.error("[notify] ignoring an unreadable store and generating new keys");
    } catch {
      // First run, or the file is gone. Either way, start fresh.
    }
    // Rotating these silently invalidates every existing subscription, which is
    // why they are generated once and then left alone.
    const keys = webpush.generateVAPIDKeys();
    const fresh: Stored = { vapid: keys, subscriptions: [] };
    this.persist(fresh);
    console.log("[notify] generated a new VAPID keypair");
    return fresh;
  }

  private persist(data: Stored = this.data as Stored): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[notify] could not save: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Adds or replaces by endpoint, so re-subscribing updates rather than duplicates. */
  upsert(input: Omit<Subscription, "id" | "createdAt" | "lastPushAt" | "lastAckAt">): Subscription | null {
    if (this.data === null) return null;
    const existing = this.data.subscriptions.find((s) => s.endpoint === input.endpoint);
    const now = new Date().toISOString();
    const record: Subscription = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      // Level to begin with, so a new subscription is never born already looking
      // overdue for an acknowledgement it has had no chance to send.
      lastPushAt: existing?.lastPushAt ?? now,
      lastAckAt: existing?.lastAckAt ?? now,
      ...input,
      // A re-registration that carries no market must not erase a known one. The
      // board re-registers itself on load to heal a rotated endpoint, and the zip
      // it has to hand is null until a snapshot resolves one, which on the college
      // tab may be never. Forgetting the market there would silently disable the
      // gate that stops alerts for games the viewer cannot watch.
      zip: input.zip ?? existing?.zip ?? null,
    };
    this.data.subscriptions = [
      ...this.data.subscriptions.filter((s) => s.endpoint !== input.endpoint),
      record,
    ];
    this.persist();
    return record;
  }

  /** A worker reporting that a push reached a living install. */
  acknowledge(endpoint: string): void {
    if (this.data === null) return;
    const sub = this.data.subscriptions.find((s) => s.endpoint === endpoint);
    if (sub === undefined) return;
    sub.lastAckAt = new Date().toISOString();
    this.persist();
  }

  /**
   * Drops subscriptions pushed to for longer than `DEAD_AFTER_MS` with nothing
   * coming back. Cheap enough to call on every evaluation: it touches disk only
   * when something actually goes.
   */
  pruneUnacknowledged(): number {
    if (this.data === null) return 0;
    const dead = this.data.subscriptions.filter(
      (s) => Date.parse(s.lastPushAt) - Date.parse(s.lastAckAt) > DEAD_AFTER_MS,
    );
    if (dead.length === 0) return 0;
    const gone = new Set(dead.map((s) => s.endpoint));
    this.data.subscriptions = this.data.subscriptions.filter((s) => !gone.has(s.endpoint));
    this.persist();
    console.log(`[notify] dropped ${dead.length} subscription(s) unacknowledged for over 30 days`);
    return dead.length;
  }

  remove(endpoint: string): void {
    if (this.data === null) return;
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.data.subscriptions.length !== before) this.persist();
  }

  /**
   * Sends one payload, dropping the subscription if the push service says the
   * browser has thrown it away. A 404 or 410 is the normal end of a
   * subscription's life, not an error worth retrying.
   */
  async send(sub: Subscription, payload: unknown): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
      );
      // Accepted by the push service, which says nothing about whether anything
      // received it. Recorded so the gap is only ever measured against pushes a
      // live worker actually had the chance to acknowledge.
      sub.lastPushAt = new Date().toISOString();
      this.persist();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        console.log(`[notify] dropping expired subscription ${sub.id}`);
        this.remove(sub.endpoint);
        return;
      }
      console.error(`[notify] send failed for ${sub.id}: ${status ?? (err as Error).message}`);
    }
  }
}
