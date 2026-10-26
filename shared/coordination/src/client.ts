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

export type CoordinationOp = "increment" | "count" | "read" | "write" | "remove" | "claim";

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
  /** Deletes the entry; true only if a live one was there. */
  remove(): Promise<boolean>;
  /** Stores a marker for `ttlMs` if no live entry exists; true only for the caller that stored it. */
  claim(ttlMs: number): Promise<boolean>;
}

export interface CoordinationNamespace {
  getByName(name: string): CoordinationStub;
}

/** What a failed call reports. Never the key and never a value. */
export interface CoordinationErrorDetail {
  /** Whether the call was tried a second time before it failed. */
  readonly retried: boolean;
  /** Time from the first attempt to the final failure. */
  readonly durationMs: number;
}

/**
 * Called once for each call that fails, after any retry, before the failure
 * reaches the caller. It receives the namespace and the operation only.
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
  remove(key: string): Promise<boolean>;
  claim(key: string, ttlMs: number): Promise<boolean>;
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
   * Runs `run` on the key's object. Only `read` and `count` change nothing,
   * so only they are tried a second time, through a fresh stub, since a stub
   * that has thrown may stay broken.
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
        return await run(ns.getByName(name));
      } catch (error) {
        if ((op !== "read" && op !== "count") || !isRetryable(error)) throw error;
        retried = true;
        return await run(ns.getByName(name));
      }
    } catch (error) {
      onError?.(namespace, op, { retried, durationMs: Date.now() - started });
      throw error;
    }
  }

  return {
    increment: (key, windowMs) => call("increment", key, (stub) => stub.increment(clamp(windowMs))),
    count: (key) => call("count", key, (stub) => stub.count()),
    read: (key) => call("read", key, (stub) => stub.read()),
    write: (key, value, ttlMs) => call("write", key, (stub) => stub.write(value, clamp(ttlMs))),
    remove: (key) => call("remove", key, (stub) => stub.remove()),
    claim: (key, ttlMs) => call("claim", key, (stub) => stub.claim(clamp(ttlMs))),
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
