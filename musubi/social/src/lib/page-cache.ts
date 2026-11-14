import { isAuthExpiredError, type Session } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import {
  batch,
  createComputed,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type Setter,
} from "solid-js";

// The one cache for Musubi's page reads.
//
// A page shown again draws the rows it last had at once and reads them again
// behind them, so moving between pages never brings back a placeholder for
// something already seen. A first visit draws as many placeholders as rows
// that page last landed, one when nothing is known.
//
// Scope. Every entry belongs to the session `AuthProvider` holds: one session
// object stands for one account and one active profile, and signing in,
// switching profile, a profile reset, signing out and the session ending each
// replace it or take it away. When the session object changes, every entry and
// every row count is cleared and every read still out is dropped, so no
// account or profile ever reads another's rows. Keys carry the scope as well,
// so no key is shared across sessions even before the clear runs.
//
// Values sit in plain signals, never in a resource, so reading one never
// raises a `Suspense` boundary and a cached page paints with the navigation.
// The queries themselves are in `page-data.ts`, which loads on demand; this
// module holds no client.

type Status = "idle" | "pending" | "ready" | "refreshing" | "errored";

interface Entry<T> {
  readonly name: string;
  readonly read: () => Promise<T>;
  readonly countRows: (value: T) => number;
  readonly value: Accessor<T | undefined>;
  readonly setValue: Setter<T | undefined>;
  readonly status: Accessor<Status>;
  readonly setStatus: Setter<Status>;
  readonly error: Accessor<unknown>;
  readonly setError: Setter<unknown>;
  /** The last read sent; only its answer may land. */
  seq: number;
  /** Settles (never rejects) when the last read sent answers. */
  inFlight: Promise<void> | null;
  /** Mounted pages reading this entry. */
  readers: number;
}

/** What the module needs of each query, by name. */
interface QueryStore {
  /** Forgets every entry (a scope change). */
  forgetAll(): void;
  /** `invalidate()` with no arguments. */
  invalidateAll(): void;
}

let scope: string | null = null;
/** Counts scope changes; a read or a mutation taken under an older one lands nowhere. */
let generation = 0;
let scopeEnded = gate();
const [version, setVersion] = createSignal(0);
const serials = new WeakMap<Session, number>();
let lastSerial = 0;
const stores = new Map<string, QueryStore>();
const rowsSeen = new Map<string, number>();

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Binds the cache to `session`, the object `AuthProvider`'s session resource
 * holds, or `null` while signed out. Any change clears everything.
 */
export function bindScope(session: Session | null | undefined): void {
  let next: string | null = null;
  if (session) {
    let serial = serials.get(session);
    if (serial === undefined) {
      lastSerial += 1;
      serial = lastSerial;
      serials.set(session, serial);
    }
    next = String(serial);
  }
  if (next === scope) return;
  scope = next;
  generation += 1;
  const ended = scopeEnded;
  scopeEnded = gate();
  batch(() => {
    for (const store of stores.values()) store.forgetAll();
  });
  rowsSeen.clear();
  ended.open();
  setVersion(generation);
}

/**
 * Keeps the cache bound to the session of the nearest `AuthProvider`. An
 * errored or loading session counts as none: `.latest` throws on an errored
 * resource.
 */
export function useSessionScope(): void {
  const { session } = useAuth();
  createComputed(() => {
    const state = session.state;
    bindScope(state === "ready" || state === "refreshing" ? (session.latest ?? null) : null);
  });
}

/**
 * Mounted once by the shell, inside its `AuthProvider`: the cache follows the
 * session even with no page reading it, and is cleared when the shell goes
 * (a bare route mounts none).
 */
export function PageCacheScope(): null {
  useSessionScope();
  onCleanup(() => bindScope(null));
  return null;
}

/**
 * Marks every entry of the queries named (`PAGE_DATA`) out of date, as their
 * `invalidate()` does, for code that changes a page's rows without loading
 * the page's queries. A query not yet loaded holds nothing to mark.
 */
export function invalidatePages(...names: string[]): void {
  for (const name of names) stores.get(name)?.invalidateAll();
}

/** The scope a mutation starts under; pass it to `update` once its answer lands. */
export function scopeMark(): number {
  return generation;
}

/** How many placeholder rows `name`'s page draws: the rows it last landed, one when none. */
export function placeholderRows(name: string): number {
  return Math.max(1, rowsSeen.get(name) ?? 1);
}

const landed = <T>(entry: Entry<T>) => {
  const status = entry.status();
  return status === "ready" || status === "refreshing";
};

/** Drops the entry's read and blanks it, so a reader still holding it shows nothing. */
function forget<T>(entry: Entry<T>): void {
  entry.seq += 1;
  entry.inFlight = null;
  entry.setValue(undefined);
  entry.setError(undefined);
  entry.setStatus("idle");
}

/**
 * `next`, with every object or list in it that equals one in `prev` (by its
 * JSON) taken from `prev` instead. A list read again that answers the same
 * rows keeps the same row objects, so `<For>` keeps their elements: no avatar
 * reloads, and focus stays on a row's button. Answers are parsed JSON, so
 * JSON equality is equality, and the round trip loses nothing.
 */
function keepSame<T>(prev: T | undefined, next: T): T {
  if (prev === undefined) return next;
  const held = new Map<string, object>();
  JSON.stringify(prev, (_key, value: unknown) => {
    if (value !== null && typeof value === "object") held.set(JSON.stringify(value), value);
    return value;
  });
  if (held.size === 0) return next;
  return JSON.parse(JSON.stringify(next), (_key, value: unknown) =>
    value !== null && typeof value === "object"
      ? (held.get(JSON.stringify(value)) ?? value)
      : value,
  ) as T;
}

/** Writes an answer into the entry and counts its rows for the next first load. */
function land<T>(entry: Entry<T>, answer: T): void {
  const value = keepSame(untrack(entry.value), answer);
  batch(() => {
    entry.setValue(() => value);
    entry.setError(undefined);
    entry.setStatus("ready");
  });
  rowsSeen.set(entry.name, entry.countRows(value));
}

function send<T>(entry: Entry<T>, refreshing = false): Promise<void> {
  entry.seq += 1;
  const seq = entry.seq;
  const sentUnder = generation;
  batch(() => {
    if (!landed(entry)) {
      entry.setError(undefined);
      entry.setStatus("pending");
    } else if (refreshing) {
      entry.setStatus("refreshing");
    }
  });
  const current = () => sentUnder === generation && seq === entry.seq;
  let answer: Promise<T>;
  try {
    answer = entry.read();
  } catch (err) {
    answer = Promise.reject(err);
  }
  const settled = answer
    .then(
      (value) => (current() ? land(entry, value) : undefined),
      (err: unknown) => {
        if (!current()) return;
        // The session went; the scope change that follows clears this entry.
        if (isAuthExpiredError(err)) {
          batch(() => {
            if (entry.status() === "refreshing") entry.setStatus("ready");
          });
          return;
        }
        // No rows left behind a failure: the caller may have lost access.
        batch(() => {
          entry.setValue(undefined);
          entry.setError(err);
          entry.setStatus("errored");
        });
      },
    )
    .finally(() => {
      if (entry.seq === seq) entry.inFlight = null;
    });
  entry.inFlight = settled;
  return settled;
}

/** Waits until no read of `entry` is out, or the scope it was taken under has ended. */
async function quiet<T>(entry: Entry<T>, under: number, ended: Promise<void>): Promise<void> {
  if (!entry.inFlight || under !== generation) return;
  await Promise.race([entry.inFlight, ended]);
  return quiet(entry, under, ended);
}

/** What a page reads: the rows, the read's state, and how many placeholders to draw. */
export interface PageRead<T> {
  /**
   * The rows last landed; `undefined` before the first lands. Throws the
   * failure when the last read failed, as a resource does, so a page that
   * names no failure falls to its error boundary.
   */
  (): T | undefined;
  /**
   * `unresolved` with nothing to read (no session yet, no arguments);
   * `pending` while a first read is out; `refreshing` while a read the page
   * asked for with `refresh` is out, rows on screen. A read behind rows a
   * page shows again leaves the state `ready`.
   */
  readonly state: "unresolved" | "pending" | "ready" | "refreshing" | "errored";
  /**
   * No rows yet, or a read the page asked for with `refresh` is out: the
   * region's `aria-busy`. A read behind rows already on screen marks nothing:
   * the rows are whole, and a screen reader may pass over a busy region.
   */
  readonly busy: boolean;
  readonly error: unknown;
  /** Placeholder rows to draw for a first load. */
  readonly rows: number;
  /**
   * Waits until no read of the rows is out, then resolves them; `undefined`
   * when the scope changed meanwhile or nothing has landed. A row action
   * awaits it, so it never acts on a row the read in flight removes.
   */
  settled(): Promise<T | undefined>;
}

export interface PageQuery<A extends unknown[], T> {
  /**
   * Reads the rows for `args` in a component; `undefined` args read nothing.
   * Each time the page shows them (it mounts, its arguments or the scope
   * change) they are read: behind the rows when some have landed, joining a
   * read already out.
   */
  use(args: () => A | undefined): PageRead<T>;
  /**
   * Starts a read for a link about to be followed, only for rows never read
   * (or forgotten) with none out: landed rows are read again when shown, and a
   * failed read is tried again when shown, not on every hover. Signed out it
   * sends nothing.
   */
  preload(...args: A): void;
  /**
   * Reads again now and marks the rows `refreshing` until it answers. Settles
   * when that read answers, fails or is dropped; never rejects.
   */
  refresh(...args: A): Promise<void>;
  /**
   * Writes a mutation's known outcome into landed rows, and drops any read
   * still out, which may predate it. Nothing is written when the scope has
   * changed since `mark` (`scopeMark()`, taken before the request) or nothing
   * has landed.
   */
  update(args: A, change: (value: T) => T, mark: number): void;
  /**
   * The rows are out of date. A page showing them reads them again now; for
   * one not on screen, any read out is dropped (the next show reads anyway).
   * With no arguments: every entry of this query.
   */
  invalidate(...args: A | []): void;
  /** Forgets the rows (a deleted organisation): the next show is a first load. Sends nothing. */
  drop(...args: A): void;
  /** Placeholder rows to draw for this page's first load. */
  rows(): number;
}

/**
 * One kind of page read: `read` fetches it, `countRows` says how many rows
 * the answer draws, which sets the next first load's placeholder count.
 */
export function pageQuery<A extends unknown[], T>(
  name: string,
  read: (...args: A) => Promise<T>,
  countRows: (value: T) => number,
): PageQuery<A, T> {
  const entries = new Map<string, Entry<T>>();

  const keyOf = (args: readonly unknown[]) => `${scope}\u0000${name}\u0000${JSON.stringify(args)}`;
  const existing = (args: readonly unknown[]) =>
    scope === null ? undefined : entries.get(keyOf(args));

  function entryFor(args: A): Entry<T> | undefined {
    if (scope === null) return undefined;
    const key = keyOf(args);
    const held = entries.get(key);
    if (held) return held;
    const [value, setValue] = createSignal<T | undefined>(undefined);
    const [status, setStatus] = createSignal<Status>("idle");
    const [error, setError] = createSignal<unknown>(undefined);
    const entry: Entry<T> = {
      name,
      read: () => read(...args),
      countRows,
      value,
      setValue,
      status,
      setStatus,
      error,
      setError,
      seq: 0,
      inFlight: null,
      readers: 0,
    };
    entries.set(key, entry);
    return entry;
  }

  /** Out of date: read again now if a page shows it, else drop any read out. */
  function stale(entry: Entry<T>): void {
    if (entry.readers > 0) {
      void send(entry);
      return;
    }
    entry.seq += 1;
    entry.inFlight = null;
    batch(() => {
      if (entry.status() === "pending") entry.setStatus("idle");
      if (entry.status() === "refreshing") entry.setStatus("ready");
    });
  }

  stores.set(name, {
    forgetAll() {
      for (const entry of entries.values()) forget(entry);
      entries.clear();
    },
    invalidateAll() {
      if (scope !== null) for (const entry of entries.values()) stale(entry);
    },
  });

  function use(args: () => A | undefined): PageRead<T> {
    useSessionScope();
    const entry = createMemo(() => {
      version();
      const a = args();
      return a === undefined ? undefined : entryFor(a);
    });
    // A show: the entry resolving, never a change of its state, so a failed
    // read is not sent again by itself.
    createComputed(() => {
      const shown = entry();
      if (!shown) return;
      shown.readers += 1;
      onCleanup(() => {
        shown.readers -= 1;
      });
      untrack(() => {
        if (!shown.inFlight) void send(shown);
      });
    });

    const current = (() => {
      const shown = entry();
      if (!shown) return undefined;
      if (shown.status() === "errored") throw shown.error();
      return shown.value();
    }) as PageRead<T>;
    Object.defineProperties(current, {
      state: {
        get: () => {
          const status = entry()?.status() ?? "idle";
          return status === "idle" ? "unresolved" : status;
        },
      },
      busy: {
        get: () => {
          const shown = entry();
          if (!shown) return true;
          const status = shown.status();
          return status === "idle" || status === "pending" || status === "refreshing";
        },
      },
      error: { get: () => entry()?.error() },
      rows: { get: () => placeholderRows(name) },
    });
    current.settled = async () => {
      const under = generation;
      const shown = untrack(entry);
      if (!shown) return undefined;
      await quiet(shown, under, scopeEnded.promise);
      return under === generation && landed(shown) ? shown.value() : undefined;
    };
    return current;
  }

  return {
    use,
    preload(...args) {
      const entry = entryFor(args);
      if (!entry || entry.inFlight || entry.status() !== "idle") return;
      void send(entry);
    },
    refresh(...args) {
      const entry = entryFor(args);
      if (!entry) return Promise.resolve();
      return Promise.race([send(entry, true), scopeEnded.promise]);
    },
    update(args, change, mark) {
      if (mark !== generation) return;
      const entry = existing(args);
      const value = entry?.value();
      if (!entry || !landed(entry) || value === undefined) return;
      entry.seq += 1;
      entry.inFlight = null;
      land(entry, change(value));
    },
    invalidate(...args) {
      if (scope === null) return;
      const matches =
        args.length === 0 ? [...entries.values()] : [existing(args)].filter((e) => e !== undefined);
      for (const entry of matches) stale(entry);
    },
    drop(...args) {
      const entry = existing(args);
      if (entry) batch(() => forget(entry));
    },
    rows: () => placeholderRows(name),
  };
}
