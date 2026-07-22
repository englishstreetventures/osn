/**
 * GrowthBook feature-flag evaluation for Cloudflare Workers — key-optional,
 * fail-safe, edge-native.
 *
 * Shared by every backend that wants to gate behaviour behind a flag or run an
 * experiment (`@cire/api` first; `@osn/api`, `@zap/api` to follow). The design
 * mirrors the project's other key-optional integrations (`@shared/turnstile`,
 * the maps-embed key, `OSN_EMAIL_OPTIONAL`):
 *
 *  - **Client key UNSET** ⇒ `createFeatureFlags({ clientKey: undefined })`
 *    returns a provider that evaluates every flag from the {@link FLAGS}
 *    registry's coded default. NO network call is ever made. This keeps the PR
 *    safe to merge and deploy BEFORE a GrowthBook account exists — flags read
 *    exactly as their in-code defaults until the key is set.
 *  - **Client key SET** ⇒ the provider fetches the SDK payload from GrowthBook's
 *    CDN (once per cache window, optionally backed by KV so it is shared across
 *    isolates) and evaluates flags against it with the caller's attributes.
 *
 * Evaluation itself is **synchronous and offline** — we hand a pre-fetched
 * payload to the GrowthBook SDK's `initSync`, which does no I/O and needs no
 * Node APIs, so it runs cleanly in the Workers runtime. The only network is the
 * cached payload fetch, which goes through `instrumentedFetch` (shows on the
 * trace tree) and **fails safe**: an unreachable CDN falls back to the last
 * good payload, and with no payload at all every flag resolves to its coded
 * default. A flag lookup never throws and never blocks a request on GrowthBook.
 *
 * The registry ({@link FLAGS}) is the single source of truth for which flags
 * exist and what they default to. Callers reference flags by a typed key, so a
 * typo is a compile error and a flag that GrowthBook has never heard of still
 * has a safe, reviewed default.
 */

import { GrowthBook } from "@growthbook/growthbook";
import { instrumentedFetch } from "@shared/observability/fetch";

/**
 * The flag registry: every flag the code may read, mapped to the value it takes
 * when GrowthBook is unconfigured, unreachable, or has no rule for it. This is
 * the contract between code and the GrowthBook dashboard — a key here must match
 * a feature key there, and the default here is the fail-safe value.
 *
 * Keep keys namespaced by product (`cire.*`, `osn.*`) so one dashboard can serve
 * every Worker without collisions. Values may be boolean, string, or number;
 * the default's type is the flag's type for {@link FlagEvaluator.getValue}.
 */
export const FLAGS = {
  /**
   * OSN ("Pulse") account linking on the guest invite — the "Link your Pulse
   * account" section (`cire/web` `PulseAccountLink`, mounted in `InvitePage`).
   * Default OFF ⇒ `cire-api`'s `GET`/`POST /api/account/link` answer 503
   * ("disabled") and the guest UI hides itself (its `<Show when={ready}>` treats
   * a 503 probe as disabled), even where the ARC linking keys are configured.
   * Flip on in the GrowthBook dashboard (feature key `cire.account-linking`) to
   * reveal it — no deploy needed.
   */
  "cire.account-linking": false,
} as const satisfies Record<string, boolean | string | number>;

/** A valid flag key — the keys of {@link FLAGS}. Typo ⇒ compile error. */
export type FlagKey = keyof typeof FLAGS;

/**
 * Widen a registry literal to the flag's runtime value type. The registry is
 * `as const`, so a boolean flag's default reads as the literal `false`/`true` —
 * but at runtime a flag can take either boolean, so its value type is `boolean`
 * (likewise `string`/`number`). For a concrete key this reduces cleanly, so the
 * public `getValue` / `createStaticFlags` signatures stay exact; only the
 * internal generic-key evaluators need a cast.
 */
type Widen<T> = T extends boolean
  ? boolean
  : T extends number
    ? number
    : T extends string
      ? string
      : T;

/** The value type of a given flag — its registry default's type, widened. */
export type FlagValue<K extends FlagKey> = Widen<(typeof FLAGS)[K]>;

/**
 * Per-request targeting attributes handed to GrowthBook. `id` is the bucketing
 * key for percentage rollouts (a stable per-user/per-guest id ⇒ a user stays on
 * the same side of a 20% rollout across requests). Any extra fields become
 * targeting attributes (e.g. `weddingId`, `role`, `env`).
 */
export interface FlagAttributes {
  /** Stable bucketing id (osn profile id, guest session id, …). */
  id?: string;
  [attribute: string]: string | number | boolean | undefined;
}

/**
 * Evaluates flags for one request's attributes. Every method is synchronous and
 * never throws — an unknown/unconfigured flag falls back to its registry
 * default.
 */
export interface FlagEvaluator {
  /**
   * True when the flag is on. For a non-boolean flag, GrowthBook's truthiness
   * of the evaluated value; prefer {@link getValue} for string/number flags.
   */
  isOn(key: FlagKey): boolean;
  /**
   * The flag's evaluated value, typed to the registry default's type. Returns
   * the registry default when GrowthBook has no value for it.
   */
  getValue<K extends FlagKey>(key: K): FlagValue<K>;
}

/**
 * Builds per-request {@link FlagEvaluator}s. Hold ONE of these per Worker (built
 * from env once) and call {@link forRequest} per request with that request's
 * attributes.
 */
export interface FeatureFlags {
  /**
   * Evaluate flags for a request. Loads the SDK payload (cached; may hit the
   * CDN on a cold/expired cache) then returns a synchronous evaluator bound to
   * `attributes`. Fail-safe: on any load failure the evaluator uses the last
   * good payload, or coded defaults if none.
   */
  forRequest(attributes?: FlagAttributes): Promise<FlagEvaluator>;
}

/** Minimal fetch shape — both global `fetch` and `instrumentedFetch` satisfy it. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Minimal KV shape this module needs (a subset of Cloudflare's `KVNamespace`).
 * Optional everywhere — absent ⇒ the payload cache lives only in the isolate's
 * memory (still correct, just not shared across isolates).
 */
export interface FlagsKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** The slice of `ExecutionContext` we use — lets a refresh outlive the response. */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FeatureFlagsConfig {
  /**
   * GrowthBook SDK client key (`GROWTHBOOK_CLIENT_KEY`). Unset/empty ⇒ the
   * provider is inert: coded defaults only, zero network.
   */
  clientKey?: string | undefined | null;
  /** GrowthBook API/CDN host. Defaults to {@link DEFAULT_API_HOST}. */
  apiHost?: string | undefined | null;
  /** Optional KV namespace for a cross-isolate payload cache. */
  kv?: FlagsKV | undefined | null;
  /** Optional execution context so payload refreshes run after the response. */
  ctx?: WaitUntilCtx | undefined | null;
  /** Cache freshness window in seconds. Default {@link DEFAULT_TTL_SECONDS}. */
  ttlSeconds?: number;
  /** Test seam; defaults to the instrumented fetch. */
  fetchImpl?: FetchLike;
  /** Test seam for the cache clock; defaults to `Date.now`. */
  now?: () => number;
}

/** GrowthBook's managed CDN. */
export const DEFAULT_API_HOST = "https://cdn.growthbook.io";
/** Default payload cache window: 60s. A flag change propagates within this. */
export const DEFAULT_TTL_SECONDS = 60;
/** KV key the payload is cached under. */
const KV_PAYLOAD_KEY = "gb:payload";

/** The subset of GrowthBook's SDK payload we pass to `initSync`. */
interface SdkPayload {
  features?: Record<string, unknown>;
  savedGroups?: Record<string, unknown>;
}

/** A payload plus the epoch-ms it was fetched, for TTL checks. */
interface CachedPayload {
  payload: SdkPayload;
  fetchedAt: number;
}

/**
 * Build a {@link FeatureFlags} provider from config. Safe to call once per
 * Worker and reuse; the payload cache lives on the returned object (and,
 * optionally, in KV).
 */
export function createFeatureFlags(config: FeatureFlagsConfig): FeatureFlags {
  const clientKey = config.clientKey?.trim();

  // Key-optional branch: no client key ⇒ a provider that never touches the
  // network and evaluates purely from the registry. Mirrors the null-verifier
  // branch in @shared/turnstile.
  if (!clientKey) {
    return {
      async forRequest() {
        return defaultsEvaluator();
      },
    };
  }

  const apiHost = (config.apiHost?.trim() || DEFAULT_API_HOST).replace(/\/+$/, "");
  const ttlMs = (config.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const fetchImpl = config.fetchImpl ?? instrumentedFetch;
  const kv = config.kv ?? null;
  const ctx = config.ctx ?? null;
  const clock = config.now ?? Date.now;
  const url = `${apiHost}/api/features/${clientKey}`;

  // In-isolate memo: the freshest payload this isolate knows about. Shared
  // across every request the isolate serves so a warm isolate never re-fetches
  // within the TTL. `null` until the first successful load.
  let memo: CachedPayload | null = null;
  // De-dupes concurrent cold-start fetches within one isolate.
  let inFlight: Promise<CachedPayload | null> | null = null;

  async function loadPayload(now: number): Promise<SdkPayload> {
    // 1. Fresh in-isolate memo ⇒ use it, no I/O.
    if (memo && now - memo.fetchedAt < ttlMs) return memo.payload;

    // 2. Cold or expired memo: try the shared KV cache before the network.
    if (!memo && kv) {
      const cached = await readKv(kv);
      if (cached) {
        memo = cached;
        // If KV was itself fresh, we're done. Otherwise fall through to refresh
        // but keep this as the fail-safe fallback.
        if (now - cached.fetchedAt < ttlMs) return cached.payload;
      }
    }

    // 3. Refresh from the CDN. De-dupe concurrent refreshes in this isolate.
    if (!inFlight) {
      inFlight = fetchPayload(url, fetchImpl, now)
        .then((fetched) => {
          if (fetched) {
            memo = fetched;
            // Persist to KV for other isolates; don't block the request on it.
            if (kv) {
              const write = writeKv(kv, fetched, config.ttlSeconds ?? DEFAULT_TTL_SECONDS);
              if (ctx) ctx.waitUntil(write);
              else void write.catch(() => {});
            }
          }
          return fetched;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    const refreshed = await inFlight;

    // 4. Fail-safe ladder: fresh fetch → any stale memo → empty payload (⇒ the
    // evaluator serves registry defaults). A CDN blip never breaks a request.
    return refreshed?.payload ?? memo?.payload ?? {};
  }

  return {
    async forRequest(attributes) {
      let payload: SdkPayload;
      try {
        payload = await loadPayload(clock());
      } catch {
        // Belt-and-braces: loadPayload already fails safe, but never let a flag
        // read throw into a request handler.
        payload = memo?.payload ?? {};
      }
      return gbEvaluator(payload, attributes);
    },
  };
}

/** Read + parse the cached payload from KV; `null` on miss or corrupt entry. */
async function readKv(kv: FlagsKV): Promise<CachedPayload | null> {
  try {
    const raw = await kv.get(KV_PAYLOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed || typeof parsed.fetchedAt !== "number" || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the payload to KV. Best-effort; caller decides whether to await. */
async function writeKv(kv: FlagsKV, cached: CachedPayload, ttlSeconds: number): Promise<void> {
  try {
    // Keep the KV entry a little past our own TTL so a stale-but-present entry
    // is always available as the fail-safe fallback (min 60s per KV's floor).
    await kv.put(KV_PAYLOAD_KEY, JSON.stringify(cached), {
      expirationTtl: Math.max(60, ttlSeconds * 10),
    });
  } catch {
    // A KV write failure is non-fatal: the isolate memo still serves this
    // isolate; other isolates just re-fetch. Swallow.
  }
}

/** Fetch + parse the SDK payload from the CDN. `null` on any failure (fail-safe). */
async function fetchPayload(
  url: string,
  fetchImpl: FetchLike,
  now: number,
): Promise<CachedPayload | null> {
  try {
    const res = await fetchImpl(url, {
      // Bound the call so a hung CDN can't tie up the isolate; an abort lands in
      // the catch ⇒ null ⇒ fail-safe fallback to stale/defaults.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: Record<string, unknown>;
      savedGroups?: Record<string, unknown>;
    };
    return {
      payload: { features: data.features ?? {}, savedGroups: data.savedGroups ?? {} },
      fetchedAt: now,
    };
  } catch {
    return null;
  }
}

/** Build a GrowthBook-backed evaluator for one payload + attribute set. */
function gbEvaluator(payload: SdkPayload, attributes: FlagAttributes | undefined): FlagEvaluator {
  const gb = new GrowthBook({ attributes: attributes ?? {} });
  // Synchronous, no I/O — safe on the Workers runtime.
  gb.initSync({ payload: payload as never });

  return {
    isOn(key) {
      try {
        return gb.isOn(key);
      } catch {
        return Boolean(FLAGS[key]);
      }
    },
    getValue(key) {
      // Generic-key index of the `as const` registry doesn't reduce against the
      // widened return type, and GrowthBook's own widening differs — cast via
      // `unknown`. Concrete-key callers still get the exact `FlagValue<K>`.
      try {
        return gb.getFeatureValue(key, FLAGS[key]) as unknown as FlagValue<typeof key>;
      } catch {
        return FLAGS[key] as unknown as FlagValue<typeof key>;
      }
    },
  };
}

/** Evaluator that ignores GrowthBook entirely and serves registry defaults. */
function defaultsEvaluator(): FlagEvaluator {
  return {
    isOn(key) {
      return Boolean(FLAGS[key]);
    },
    getValue(key) {
      return FLAGS[key] as unknown as FlagValue<typeof key>;
    },
  };
}

/**
 * Build a provider with explicit flag values — no GrowthBook, no network. For
 * tests, and for callers that want to force flags from code. A flag absent from
 * `overrides` falls back to its {@link FLAGS} registry default.
 *
 * ```ts
 * const flags = createStaticFlags({ "cire.account-linking": true });
 * ```
 */
export function createStaticFlags(
  overrides: Partial<{ [K in FlagKey]: FlagValue<K> }> = {},
): FeatureFlags {
  const pick = <K extends FlagKey>(key: K): FlagValue<K> =>
    (key in overrides ? overrides[key] : FLAGS[key]) as unknown as FlagValue<K>;
  const evaluator: FlagEvaluator = {
    isOn(key) {
      return Boolean(pick(key));
    },
    getValue(key) {
      return pick(key);
    },
  };
  return {
    async forRequest() {
      return evaluator;
    },
  };
}
