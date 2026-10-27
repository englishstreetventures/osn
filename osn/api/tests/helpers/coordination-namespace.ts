import type {
  CoordinationNamespace,
  CoordinationOp,
  CoordinationStub,
  CoordinationStubOptions,
} from "@shared/coordination";

/** One call an object received: the store (the name before `:`) and the operation. */
export interface RecordedCall {
  readonly store: string;
  readonly op: CoordinationOp;
}

interface Entry {
  v?: string;
  n?: number;
  exp: number;
}

const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;

function assertDuration(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TTL_MS) {
    throw new RangeError("duration out of range");
  }
}

export interface FakeNamespace {
  readonly ns: CoordinationNamespace;
  /** Every call, in the order the objects received them. Keys are not kept. */
  readonly calls: RecordedCall[];
  /** Every object name asked for, in order. */
  readonly names: string[];
  /** The location hint each object was asked for with, in the same order. */
  readonly hints: (string | undefined)[];
  /** While set, a call this predicate accepts rejects instead of running. */
  failWhen(predicate: ((call: RecordedCall) => boolean) | null): void;
}

/**
 * A stand-in for the `COORDINATION` binding with the store's semantics: one
 * entry per object name, a fixed window that starts at the first hit, expiry
 * checked on every read, a `write` at or below zero TTL that removes, and a
 * guess counted on the entry it reads. Each
 * call runs to completion before it answers, which is the atomicity a
 * Durable Object gives one object.
 */
export function createFakeNamespace(): FakeNamespace {
  const entries = new Map<string, Entry>();
  const calls: RecordedCall[] = [];
  const names: string[] = [];
  const hints: (string | undefined)[] = [];
  let failing: ((call: RecordedCall) => boolean) | null = null;

  const live = (name: string): Entry | undefined => {
    const entry = entries.get(name);
    return entry && entry.exp > Date.now() ? entry : undefined;
  };

  const ns: CoordinationNamespace = {
    getByName(name: string, options?: CoordinationStubOptions): CoordinationStub {
      names.push(name);
      hints.push(options?.locationHint);
      const store = name.slice(0, name.indexOf(":"));
      const run = async <A>(op: CoordinationOp, body: () => A): Promise<A> => {
        const call = { store, op };
        calls.push(call);
        if (failing?.(call)) throw new Error(`object unavailable: ${name}`);
        return body();
      };
      return {
        increment: (windowMs) =>
          run("increment", () => {
            assertDuration(windowMs);
            const entry = live(name);
            if (!entry) {
              entries.set(name, { n: 1, exp: Date.now() + windowMs });
              return 1;
            }
            entry.n = (entry.n ?? 0) + 1;
            return entry.n;
          }),
        count: () => run("count", () => live(name)?.n ?? 0),
        read: () => run("read", () => live(name)?.v ?? null),
        write: (value, ttlMs) =>
          run("write", () => {
            if (ttlMs <= 0) {
              entries.delete(name);
              return;
            }
            assertDuration(ttlMs);
            entries.set(name, { v: value, exp: Date.now() + ttlMs });
          }),
        remove: () =>
          run("remove", () => {
            const existed = live(name) !== undefined;
            entries.delete(name);
            return existed;
          }),
        claim: (ttlMs) =>
          run("claim", () => {
            assertDuration(ttlMs);
            if (live(name)) return false;
            entries.set(name, { v: "1", exp: Date.now() + ttlMs });
            return true;
          }),
        guess: () =>
          run("guess", () => {
            const entry = live(name);
            if (!entry) return { value: null, n: 0 };
            entry.n = (entry.n ?? 0) + 1;
            return { value: entry.v ?? null, n: entry.n };
          }),
        take: () =>
          run("take", () => {
            const entry = live(name);
            entries.delete(name);
            return entry?.v ?? null;
          }),
        swap: (expected, value, ttlMs) =>
          run("swap", () => {
            assertDuration(ttlMs);
            if ((live(name)?.v ?? null) !== expected) return false;
            entries.set(name, { v: value, exp: Date.now() + ttlMs });
            return true;
          }),
      };
    },
  };

  return {
    ns,
    calls,
    names,
    hints,
    failWhen(predicate) {
      failing = predicate;
    },
  };
}
