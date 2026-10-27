import { DurableObject } from "cloudflare:workers";

import { MAX_TTL_MS } from "./client";

/** The one stored record: a value, a count, or both, and when it stops being live. */
interface Entry {
  readonly v?: string;
  readonly n?: number;
  /** Epoch milliseconds. The entry is live while `exp > Date.now()`. */
  readonly exp: number;
}

const ENTRY = "entry";

/** Refuses a duration that is not a whole number of milliseconds from 1 to 31 days. */
function assertDuration(ms: unknown, what: "windowMs" | "ttlMs"): asserts ms is number {
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TTL_MS) {
    throw new RangeError(`${what} must be a whole number of milliseconds from 1 to ${MAX_TTL_MS}`);
  }
}

/**
 * One logical key's short-lived state: a fixed-window counter, a value with a
 * TTL, or a single-use claim. One object per key
 * (`getByName("<namespace>:<key>")`, built by the client), so a hot key loads
 * only itself.
 *
 * Every method reads and writes the SQLite-backed synchronous KV with no await
 * in between, so each call is atomic against every other call on the same
 * object without relying on input gates; the alarm is set or deleted after. Expiry is exact on read; an alarm at the expiry time then empties
 * the object so it stops holding storage. Errors name the bad argument only,
 * never the object.
 *
 * Needs a SQLite-backed class (`new_sqlite_classes`): the synchronous KV
 * exists only there.
 */
export class CoordinationStore extends DurableObject<unknown> {
  private live(now: number): Entry | undefined {
    const entry = this.ctx.storage.kv.get<Entry>(ENTRY);
    return entry !== undefined && entry.exp > now ? entry : undefined;
  }

  private async store(entry: Entry): Promise<void> {
    this.ctx.storage.kv.put<Entry>(ENTRY, entry);
    await this.ctx.storage.setAlarm(entry.exp);
  }

  /**
   * Deletes the entry, then its alarm. The entry goes in the same synchronous
   * step as the caller's read, before the first await, so no other call on
   * this object can see it between the two. An object with no entry has no
   * alarm, so it is left alone.
   */
  private async clear(): Promise<void> {
    if (!this.ctx.storage.kv.delete(ENTRY)) return;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Counts a hit. With no live entry, starts a window of `windowMs` at 1; with
   * one, adds 1 and leaves the window's end where it was.
   */
  async increment(windowMs: number): Promise<number> {
    assertDuration(windowMs, "windowMs");
    const now = Date.now();
    const entry = this.live(now);
    if (entry === undefined) {
      await this.store({ n: 1, exp: now + windowMs });
      return 1;
    }
    const n = (entry.n ?? 0) + 1;
    this.ctx.storage.kv.put<Entry>(ENTRY, { ...entry, n });
    return n;
  }

  /** Hits in the live window, or 0. Writes nothing. */
  count(): number {
    return this.live(Date.now())?.n ?? 0;
  }

  /** The live value, or null. Writes nothing. */
  read(): string | null {
    return this.live(Date.now())?.v ?? null;
  }

  /** Replaces the entry with `value` for `ttlMs`. A TTL at or below zero removes it instead. */
  async write(value: string, ttlMs: number): Promise<void> {
    if (typeof value !== "string") throw new TypeError("value must be a string");
    if (typeof ttlMs === "number" && ttlMs <= 0) {
      await this.clear();
      return;
    }
    assertDuration(ttlMs, "ttlMs");
    await this.store({ v: value, exp: Date.now() + ttlMs });
  }

  /** Deletes the entry. True only if a live one was there. */
  async remove(): Promise<boolean> {
    const existed = this.live(Date.now()) !== undefined;
    await this.clear();
    return existed;
  }

  /**
   * Counts one guess against the live value and answers both in one call: the
   * value and the count after this guess. With no live entry it stores
   * nothing and answers `{ value: null, n: 0 }`, so a guess at nothing is not
   * counted. The count lives on the value's own record: `write` restarts it,
   * `remove` and `take` clear it with the value, and the expiry stays the
   * value's.
   */
  async guess(): Promise<{ value: string | null; n: number }> {
    const entry = this.live(Date.now());
    if (entry === undefined) return { value: null, n: 0 };
    const n = (entry.n ?? 0) + 1;
    this.ctx.storage.kv.put<Entry>(ENTRY, { ...entry, n });
    return { value: entry.v ?? null, n };
  }

  /** The live value, removed in the same call, or null. Of two takes at once, one gets it. */
  async take(): Promise<string | null> {
    const entry = this.live(Date.now());
    await this.clear();
    return entry?.v ?? null;
  }

  /**
   * Replaces the live value with `value` for `ttlMs` only if it is `expected`
   * (`null`: only if there is no live value), restarting the count. True only
   * when it replaced it; of several swaps from one value, one wins. A swap
   * that does not match rewrites a live entry unchanged — value, count and
   * expiry — so it costs the storage write a matching one does, and leaves an
   * empty object empty.
   */
  async swap(expected: string | null, value: string, ttlMs: number): Promise<boolean> {
    if (typeof value !== "string") throw new TypeError("value must be a string");
    assertDuration(ttlMs, "ttlMs");
    const now = Date.now();
    const entry = this.live(now);
    if ((entry?.v ?? null) !== expected) {
      if (entry !== undefined) this.ctx.storage.kv.put<Entry>(ENTRY, entry);
      return false;
    }
    await this.store({ v: value, exp: now + ttlMs });
    return true;
  }

  /** Stores a marker for `ttlMs` if there is no live entry. True only when it stored one. */
  async claim(ttlMs: number): Promise<boolean> {
    assertDuration(ttlMs, "ttlMs");
    const now = Date.now();
    if (this.live(now) !== undefined) return false;
    await this.store({ v: "1", exp: now + ttlMs });
    return true;
  }

  /**
   * Empties an expired object. An alarm can outlive the entry it was set for,
   * when a later write replaced that entry; then it is set again for the
   * current entry's expiry and nothing is deleted.
   */
  override async alarm(): Promise<void> {
    const entry = this.ctx.storage.kv.get<Entry>(ENTRY);
    if (entry === undefined) return;
    if (entry.exp > Date.now()) {
      await this.ctx.storage.setAlarm(entry.exp);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
