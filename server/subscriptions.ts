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
}

interface Stored {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: Subscription[];
}

const FILE = "notifications.json";

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
  upsert(input: Omit<Subscription, "id" | "createdAt">): Subscription | null {
    if (this.data === null) return null;
    const existing = this.data.subscriptions.find((s) => s.endpoint === input.endpoint);
    const record: Subscription = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...input,
    };
    this.data.subscriptions = [
      ...this.data.subscriptions.filter((s) => s.endpoint !== input.endpoint),
      record,
    ];
    this.persist();
    return record;
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
