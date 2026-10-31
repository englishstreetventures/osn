/**
 * Typed calls on `CoordinationStore` objects through a binding. Nothing here
 * names a Workers type, so a Bun process can import it; a Worker passes its
 * `DurableObjectNamespace<CoordinationStore>`, which satisfies
 * {@link CoordinationNamespace}, and a test passes a stand-in.
 *
 * One object per logical key, named `<namespace>:<key>`. A namespace cannot
 * contain `:`, so two (namespace, key) pairs never share an object.
 */

/** Longest key a caller may address. A longer one is refused before any call. */
export const MAX_KEY_LENGTH = 256;

/** Longest window or TTL the store accepts: 31 days. The client clamps to it. */
export const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;

/** Letters, digits, `_`, `.` and `-`, 1 to 64 of them. Never `:`, the separator. */
const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export type CoordinationOp =
  | "increment"
  | "count"
  | "read"
  | "write"
  | "remove"
  | "claim"
  | "guess"
  | "take"
  | "swap";

/**
 * Where every object is asked to live: Cloudflare's Oceania region. Cloudflare
 * places an object near its hint when the object is first created, on a best
 * effort, and never moves it after, so the hint holds only if every `getByName`
 * passes it — which {@link createCoordinationClient} does. One fixed region
 * means an object's distance from the Worker does not depend on who created it.
 */
export const COORDINATION_LOCATION_HINT = "oc";

/** The options every stub is got with. */
export interface CoordinationStubOptions {
  readonly locationHint: typeof COORDINATION_LOCATION_HINT;
}

const STUB_OPTIONS: CoordinationStubOptions = { locationHint: COORDINATION_LOCATION_HINT };

/**
 * What a `remove` may delete, named by what its caller read: `{ value }`, only
 * while that is still the live value; `{ hits }`, that many hits off the live
 * count, deleting the entry when none are left. Exactly one key.
 */
export type RemoveCondition = { readonly value: string } | { readonly hits: number };

/**
 * The calls one object answers. Each is atomic on that object. Durations are
 * whole milliseconds from 1 to {@link MAX_TTL_MS}; anything else is refused,
 * except a `write` TTL at or below zero, which removes the entry.
 */
export interface CoordinationStub {
  /** Counts a hit in a fixed window that starts at the first hit; returns the count. */
  increment(windowMs: number): Promise<number>;
  /** Hits in the live window, or 0. */
  count(): Promise<number>;
  /** The live value, or null. */
  read(): Promise<string | null>;
  /** Stores `value` for `ttlMs`, replacing any entry. */
  write(value: string, ttlMs: number): Promise<void>;
  /**
   * Deletes the entry; true only if a live one was there. With `expected`,
   * deletes only what it names (see {@link RemoveCondition}); a live entry it
   * does not match stays as it was, and the answer is false.
   */
  remove(expected?: RemoveCondition): Promise<boolean>;
  /** Stores a marker for `ttlMs` if no live entry exists; true only for the caller that stored it. */
  claim(ttlMs: number): Promise<boolean>;
  /**
   * Counts a guess on the live value's own record and answers the value and
   * the count after it; with no live value, counts nothing and answers
   * `{ value: null, n: 0 }`. `write` restarts the count; `remove` and `take`
   * clear it.
   */
  guess(): Promise<{ value: string | null; n: number }>;
  /** The live value, removed in the same call, or null. */
  take(): Promise<string | null>;
  /**
   * Replaces the live value with `value` for `ttlMs` only if it is `expected`
   * (`null`: only if there is no live value), restarting the count; true only
   * for the caller that replaced it. A swap that does not match leaves a live
   * entry as it was.
   */
  swap(expected: string | null, value: string, ttlMs: number): Promise<boolean>;
}

export interface CoordinationNamespace {
  getByName(name: string, options?: CoordinationStubOptions): CoordinationStub;
}

/**
 * What kind of failure a call met, read from the runtime's flags on the error
 * and from its class, never from its message:
 *
 * - `overloaded`: the object refused the call because it had too much to do.
 * - `reset`: the object was restarted while the call was in flight.
 * - `retryable`: any other failure the runtime marks as safe to try again,
 *   such as a broken connection.
 * - `invalid_input`: the object refused an argument (`RangeError`).
 * - `other`: anything else.
 */
export type CoordinationErrorKind =
  | "overloaded"
  | "reset"
  | "retryable"
  | "invalid_input"
  | "other";

/** What a failed call reports. Never the key, a value or the error's message. */
export interface CoordinationErrorDetail {
  /** Whether the call was tried a second time before it failed. */
  readonly retried: boolean;
  /** Time from the first attempt to the final failure. */
  readonly durationMs: number;
  /** The final failure's kind. */
  readonly kind: CoordinationErrorKind;
}

/**
 * Called once for each call that fails, after any retry, before the failure
 * reaches the caller. It receives the namespace, the operation and the
 * {@link CoordinationErrorDetail} only.
 */
export type CoordinationErrorHook<S extends string> = (
  store: S,
  op: CoordinationOp,
  detail: CoordinationErrorDetail,
) => void;

export interface CoordinationClientOptions<S extends string> {
  readonly namespace: S;
  readonly onError?: CoordinationErrorHook<S>;
}

/**
 * Calls addressed by key within one namespace. A call that fails rejects with
 * the runtime's error. A key over {@link MAX_KEY_LENGTH} characters is refused
 * with a `RangeError` before any call is made.
 */
export interface CoordinationClient {
  increment(key: string, windowMs: number): Promise<number>;
  count(key: string): Promise<number>;
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttlMs: number): Promise<void>;
  remove(key: string, expected?: RemoveCondition): Promise<boolean>;
  claim(key: string, ttlMs: number): Promise<boolean>;
  guess(key: string): Promise<{ value: string | null; n: number }>;
  take(key: string): Promise<string | null>;
  swap(key: string, expected: string | null, value: string, ttlMs: number): Promise<boolean>;
}

function assertNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`Invalid coordination namespace: must match ${NAMESPACE_PATTERN}`);
  }
}

/** Caps a duration at 31 days. Anything else is the store's to judge. */
function clamp(ms: number): number {
  return ms > MAX_TTL_MS ? MAX_TTL_MS : ms;
}

/**
 * True for an error the runtime marks as safe to try again: a broken
 * connection or a reset object, but not an overloaded one, where a retry
 * adds to the load that caused it.
 */
function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { retryable, overloaded } = error as { retryable?: unknown; overloaded?: unknown };
  return retryable === true && overloaded !== true;
}

/** The {@link CoordinationErrorKind} of `error`, from its flags first, then its class. */
export function coordinationErrorKind(error: unknown): CoordinationErrorKind {
  if (typeof error !== "object" || error === null) return "other";
  const flags = error as {
    overloaded?: unknown;
    durableObjectReset?: unknown;
    retryable?: unknown;
  };
  if (flags.overloaded === true) return "overloaded";
  if (flags.durableObjectReset === true) return "reset";
  if (flags.retryable === true) return "retryable";
  if (error instanceof RangeError) return "invalid_input";
  return "other";
}

export function createCoordinationClient<S extends string>(
  ns: CoordinationNamespace,
  options: CoordinationClientOptions<S>,
): CoordinationClient {
  const { namespace, onError } = options;
  assertNamespace(namespace);

  const objectName = (key: string): string => {
    if (key.length > MAX_KEY_LENGTH) {
      throw new RangeError(`Coordination key longer than ${MAX_KEY_LENGTH} characters`);
    }
    return `${namespace}:${key}`;
  };

  /**
   * Runs `run` on the key's object, got with the location hint. Only `read`
   * and `count` change nothing, so only they are tried a second time, through
   * a fresh stub, since a stub that has thrown may stay broken.
   */
  async function call<A>(
    op: CoordinationOp,
    key: string,
    run: (stub: CoordinationStub) => Promise<A>,
  ): Promise<A> {
    const name = objectName(key);
    const started = Date.now();
    let retried = false;
    try {
      try {
        return await run(ns.getByName(name, STUB_OPTIONS));
      } catch (error) {
        if ((op !== "read" && op !== "count") || !isRetryable(error)) throw error;
        retried = true;
        return await run(ns.getByName(name, STUB_OPTIONS));
      }
    } catch (error) {
      onError?.(namespace, op, {
        retried,
        durationMs: Date.now() - started,
        kind: coordinationErrorKind(error),
      });
      throw error;
    }
  }

  return {
    increment: (key, windowMs) => call("increment", key, (stub) => stub.increment(clamp(windowMs))),
    count: (key) => call("count", key, (stub) => stub.count()),
    read: (key) => call("read", key, (stub) => stub.read()),
    write: (key, value, ttlMs) => call("write", key, (stub) => stub.write(value, clamp(ttlMs))),
    remove: (key, expected) =>
      call("remove", key, (stub) =>
        expected === undefined ? stub.remove() : stub.remove(expected),
      ),
    claim: (key, ttlMs) => call("claim", key, (stub) => stub.claim(clamp(ttlMs))),
    guess: (key) => call("guess", key, (stub) => stub.guess()),
    take: (key) => call("take", key, (stub) => stub.take()),
    swap: (key, expected, value, ttlMs) =>
      call("swap", key, (stub) => stub.swap(expected, value, clamp(ttlMs))),
  };
}

export interface CoordinationRateLimiterOptions<S extends string> {
  readonly namespace: S;
  /** Hits allowed in one window; a whole number of at least 1. */
  readonly maxRequests: number;
  /** Fixed window, starting at the first hit. Clamped to 31 days. */
  readonly windowMs: number;
  readonly onError?: CoordinationErrorHook<S>;
}

/** Structurally a `RateLimiterBackend` (`@shared/rate-limit`). */
export interface CoordinationRateLimiter {
  check(key: string): Promise<boolean>;
}

/**
 * A fixed-window limiter. Fails closed: a key over {@link MAX_KEY_LENGTH}
 * characters is denied without a call, and a failed call is denied and
 * reported through `onError`.
 */
export function createCoordinationRateLimiter<S extends string>(
  ns: CoordinationNamespace,
  options: CoordinationRateLimiterOptions<S>,
): CoordinationRateLimiter {
  const { namespace, maxRequests, windowMs, onError } = options;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("Invalid coordination rate limiter: maxRequests must be a whole number >= 1");
  }
  const client = createCoordinationClient(ns, { namespace, onError });
  return {
    async check(key: string): Promise<boolean> {
      if (key.length > MAX_KEY_LENGTH) return false;
      try {
        return (await client.increment(key, windowMs)) <= maxRequests;
      } catch {
        // Fail closed; `onError` has already reported it.
        return false;
      }
    },
  };
}
