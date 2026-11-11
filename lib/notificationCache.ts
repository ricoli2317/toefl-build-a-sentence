import type { NotificationItem } from "./notifications.ts";

// Independent, in-memory, account-scoped cache. Never stores tokens or business
// data. Server confirmations are authoritative; localStorage is not an authority.
export class NotificationCache {
  unreadCount: number | null = null;
  autoOffered = false;
  private checkedAt = 0;
  private revision = 0;
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private receipts = new Map<string, string>();
  private loadCount: () => Promise<number>;
  private now: () => number;

  constructor(loadCount: () => Promise<number>, now = () => Date.now()) {
    this.loadCount = loadCount;
    this.now = now;
  }

  async refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.unreadCount !== null && this.now() - this.checkedAt < 60000) return;
    const generation = this.generation;
    const run = async () => {
      // A response started before an acknowledgement may not overwrite the badge.
      // Re-query after the write instead of guessing how many reads it included.
      while (generation === this.generation) {
        const revision = this.revision;
        const count = await this.loadCount();
        if (generation !== this.generation) return;
        if (revision !== this.revision) continue;
        this.unreadCount = count;
        this.checkedAt = this.now();
        return;
      }
    };
    this.inFlight = run().finally(() => { if (generation === this.generation) this.inFlight = null; });
    return this.inFlight;
  }

  confirm(id: string, readAt: string, wasUnread: boolean) {
    if (this.receipts.has(id)) return;
    this.receipts.set(id, readAt);
    this.revision += 1;
    this.checkedAt = 0;
    if (wasUnread && this.unreadCount !== null) this.unreadCount = Math.max(0, this.unreadCount - 1);
  }

  overlay(items: NotificationItem[]): NotificationItem[] {
    return items.map(item => ({ ...item, read_at: this.receipts.get(item.id) ?? item.read_at }));
  }

  clear() {
    this.generation += 1;
    this.revision += 1;
    this.unreadCount = null;
    this.checkedAt = 0;
    this.autoOffered = false;
    this.receipts.clear();
    this.inFlight = null;
  }
}
