/**
 * Generic per-key fixed-window rate limiter for unauthenticated endpoints.
 *
 * Designed for auth routes where keying is by IP address (callers aren't
 * authenticated). The default in-memory backend stores state in-process —
 * resets on restart. See S-M2 for the migration-to-shared-counter note.
 *
 * The `RateLimiterBackend` interface is backend-agnostic so routes can be
 * wired to a future Redis backend without any call-site changes (Phase 2 of
 * the Redis migration plan in TODO.md). `check()` returns `boolean | Promise<boolean>`
 * so consumers `await` the result — sync backends resolve immediately, async
 * backends (Redis INCR+EXPIRE via Lua) return a real promise.
 */

/**
 * Backend-agnostic rate limiter contract. The in-memory implementation
 * (`createRateLimiter`) satisfies this sync-only; a future Redis backend
 * will satisfy it async. Route factories depend on this abstract type so
 * swapping backends is a single-import change at composition time.
 */
export interface RateLimiterBackend {
  /** Returns `true` if the request is allowed, `false` if rate-limited. */
  check(key: string): boolean | Promise<boolean>;
}

export interface RateLimiterConfig {
  /** Maximum requests allowed per window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Maximum map entries before expired-entry sweep (default: 10_000). */
  maxEntries?: number;
}

interface Entry {
  count: number;
  windowStart: number;
}

/** In-memory backend extension of `RateLimiterBackend`. `_store` is visible for testing. */
export interface RateLimiter extends RateLimiterBackend {
  check(key: string): boolean;
  readonly _store: Map<string, Entry>;
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const store = new Map<string, Entry>();
  const maxEntries = config.maxEntries ?? 10_000;
  let lastSweep = Date.now();

  /**
   * Evict expired entries. Runs on every check() call but short-circuits
   * if less than one window has elapsed since the last sweep (P-W16).
   * Also runs unconditionally when store exceeds maxEntries as a hard cap.
   */
  function sweep() {
    const now = Date.now();
    if (store.size <= maxEntries && now - lastSweep < config.windowMs) return;
    lastSweep = now;
    for (const [key, entry] of store) {
      if (now - entry.windowStart > config.windowMs) store.delete(key);
    }
  }

  function check(key: string): boolean {
    sweep();
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || now - entry.windowStart > config.windowMs) {
      store.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= config.maxRequests) return false;
    entry.count++;
    return true;
  }

  return { check, _store: store };
}

/**
 * Sentinel returned by {@link getClientIp} when the caller's IP cannot be
 * resolved under the configured trust policy (header-less request behind a
 * proxy, missing `cf-connecting-ip` under Cloudflare, a malformed XFF chain,
 * or no usable socket peer in direct mode).
 *
 * Callers MUST treat this as "unresolved" via {@link isUnresolvedIp} and
 * **deny** (HTTP 429) rather than rate-limiting on it — otherwise every
 * unresolved request shares a single bucket, which is both a DoS amplifier
 * (one attacker exhausts everyone's budget) and a spoofing bypass (an
 * attacker who can blank the header escapes per-IP accounting entirely).
 *
 * The value is deliberately not a syntactically valid IP so it can never
 * collide with a real client key.
 */
export const UNRESOLVED_IP = " unresolved" as const;

/** True when `ip` is the {@link UNRESOLVED_IP} sentinel. */
export function isUnresolvedIp(ip: string): boolean {
  return ip === UNRESOLVED_IP;
}

/**
 * Shape-only validity check for an IPv4 / IPv6 address string. This is a
 * cheap guard against obviously-garbage XFF entries and bogus socket peers —
 * it is NOT a full RFC parser (it does not range-check IPv6 or canonicalise
 * it). The goal is to reject control characters, empty strings, port
 * suffixes, and non-address tokens so they cannot become rate-limit keys.
 */
export function isValidIp(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 45) return false;
  // IPv4: four dot-separated 0-255 octets (no leading zeros / non-numerics).
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = ipv4.exec(v);
  if (m) {
    return m.slice(1).every((o) => {
      const n = Number(o);
      return n >= 0 && n <= 255 && String(n) === o;
    });
  }
  // IPv6: only valid IPv6 characters (hex groups, '::' compression,
  // IPv4-mapped tails), and at least two colons OR a '::' run so a bare
  // `ipv4:port` (one colon, no '::') is rejected rather than mis-accepted.
  // Shape-only — no per-group length / count validation.
  if (!/^[0-9a-fA-F:.]+$/.test(v)) return false;
  const colons = (v.match(/:/g) ?? []).length;
  return v.includes("::") || colons >= 2;
}

/**
 * Options controlling how {@link getClientIp} resolves the trusted client IP.
 * Every resolution mode that depends on a proxy **fails closed**: if the
 * expected header/entry is missing or malformed it returns
 * {@link UNRESOLVED_IP} rather than silently falling back to a spoofable value.
 */
export interface ClientIpOptions {
  /**
   * Number of trusted reverse proxies in front of this service. When `> 0`,
   * the client IP is taken `trustedProxyCount` entries from the RIGHT of the
   * `x-forwarded-for` chain (the right-most entry is appended by the closest
   * proxy and is the only one an attacker cannot forge; counting from the
   * right is the only spoofing-resistant strategy). If the chain is missing,
   * shorter than `trustedProxyCount`, or the selected entry is not a valid
   * IP, resolution fails closed.
   *
   * Ignored when {@link trustCloudflare} is set. Default `0` (direct mode).
   */
  trustedProxyCount?: number;
  /**
   * When `true`, trust Cloudflare's `cf-connecting-ip` header exclusively and
   * NEVER fall back to `x-forwarded-for` (which Cloudflare also sets but which
   * an attacker upstream of CF could pollute). Missing/invalid header → fail
   * closed. Takes precedence over {@link trustedProxyCount}.
   */
  trustCloudflare?: boolean;
  /**
   * The transport-level socket peer address (e.g. Bun's
   * `server.requestIP(request)?.address`). Used only in direct mode
   * (`trustedProxyCount === 0` and no `trustCloudflare`) where there is no
   * trusted proxy to consult. Invalid/absent → {@link UNRESOLVED_IP}.
   */
  socketIp?: string | null;
}

/**
 * Extract the trusted client IP from request headers under an explicit trust
 * policy (S-M34).
 *
 * Resolution order:
 *  1. `trustCloudflare` → use `cf-connecting-ip`, else {@link UNRESOLVED_IP}
 *     (never falls through to XFF).
 *  2. `trustedProxyCount > 0` → take the entry `trustedProxyCount` from the
 *     right of `x-forwarded-for`; fail closed if missing/short/malformed.
 *  3. otherwise (direct / dev) → use {@link ClientIpOptions.socketIp} if it is
 *     a valid IP, else {@link UNRESOLVED_IP}.
 *
 * @deprecated The no-argument call form (`getClientIp(headers)`) preserves the
 * pre-S-M34 behaviour: it returns the LEFT-most `x-forwarded-for` entry and
 * falls back to the literal `"unknown"` — both of which a client can spoof
 * without a trusted proxy. This default exists only so sibling services keep
 * compiling during the rollout. **Migrate** by passing a {@link ClientIpOptions}
 * argument: set `{ trustCloudflare: true }` behind Cloudflare, or
 * `{ trustedProxyCount: N }` behind N trusted proxies (wire `socketIp` from
 * the server's socket peer for direct deployments), then deny requests where
 * {@link isUnresolvedIp} is true instead of bucketing them together.
 */
export function getClientIp(
  headers: Record<string, string | undefined>,
  options?: ClientIpOptions,
): string {
  // Legacy default (deprecated): left-most XFF, "unknown" fallback. Kept for
  // backward compatibility so un-migrated call sites still build.
  if (options === undefined) {
    const forwarded = headers["x-forwarded-for"];
    if (forwarded) return forwarded.split(",")[0]!.trim();
    return "unknown";
  }

  // 1. Cloudflare: cf-connecting-ip only, never fall back to XFF.
  if (options.trustCloudflare) {
    const cf = headers["cf-connecting-ip"]?.trim();
    if (cf && isValidIp(cf)) return cf;
    return UNRESOLVED_IP;
  }

  // 2. Trusted reverse proxies: Nth-from-right of x-forwarded-for.
  const proxyCount = options.trustedProxyCount ?? 0;
  if (proxyCount > 0) {
    const forwarded = headers["x-forwarded-for"];
    if (!forwarded) return UNRESOLVED_IP;
    const parts = forwarded
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    // Need at least `proxyCount` hops to identify the entry the closest
    // trusted proxy observed. Fewer means the chain was truncated/forged.
    if (parts.length < proxyCount) return UNRESOLVED_IP;
    const candidate = parts[parts.length - proxyCount];
    if (!candidate || !isValidIp(candidate)) return UNRESOLVED_IP;
    return candidate;
  }

  // 3. Direct / dev: trust only the transport socket peer.
  const socketIp = options.socketIp?.trim();
  if (socketIp && isValidIp(socketIp)) return socketIp;
  return UNRESOLVED_IP;
}
