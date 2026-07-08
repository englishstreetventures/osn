import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@shared/crypto";
import { instrumentedFetch } from "@shared/observability";
import { Effect } from "effect";

/**
 * Outbound ARC token issuer for osn-api.
 *
 * Mirrors `pulse/api/src/services/graphBridge.ts` but with osn-api as the
 * issuer. Used by the account-erasure flow to call into Pulse + Zap
 * `/internal/account-deleted` and by the app-enrollment leave callback
 * verifier to round-trip step-up tokens between services.
 *
 * Single ephemeral keypair per process. Re-registered with each downstream
 * service on startup via the shared `INTERNAL_SERVICE_SECRET` (same flow
 * Pulse uses to register with osn-api). Rotated automatically.
 */

/**
 * Comma-separated scopes osn-api registers with each downstream (Pulse + Zap)
 * when it uploads its ARC public key. `account:erase` drives the C-H2 delete
 * fan-out; `account:export` drives the C-H1 DSAR export fan-out. A downstream
 * only accepts an inbound token whose scope is in the key's registered set, so
 * both must be registered here for either fan-out to authenticate.
 */
const DOWNSTREAM_SCOPES = "account:erase,account:export";

const KEY_TTL_MS = parseFloat(process.env.OSN_ARC_KEY_TTL_HOURS ?? "24") * 3_600 * 1_000;
const KEY_ROTATION_BUFFER_MS =
  parseFloat(process.env.OSN_ARC_KEY_ROTATION_BUFFER_HOURS ?? "2") * 3_600 * 1_000;

interface KeyInit {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  keyId: string;
  expiresAt: number;
}

let _keyInitPromise: Promise<KeyInit> | null = null;

function initKeys(): Promise<KeyInit> {
  _keyInitPromise ??= (async (): Promise<KeyInit> => {
    const pair = await generateArcKeyPair();
    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      keyId: crypto.randomUUID(),
      expiresAt: Date.now() + KEY_TTL_MS,
    };
  })();
  return _keyInitPromise;
}

/**
 * Mints an ARC token for the given audience + scope and returns the
 * full `Authorization: ARC <token>` header value.
 */
export async function arcAuthHeader(audience: string, scope: string): Promise<string> {
  const { privateKey, keyId } = await initKeys();
  const token = await getOrCreateArcToken(privateKey, {
    iss: "osn-api",
    aud: audience,
    scope,
    kid: keyId,
  });
  return `ARC ${token}`;
}

/**
 * POSTs JSON to a downstream service with an ARC token attached. Uses
 * `instrumentedFetch` so outbound calls show up on the trace tree and the
 * HTTP-client metric histogram.
 */
export async function arcPostJson<T>(
  url: string,
  body: unknown,
  options: { audience: string; scope: string; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs).unref?.();
  try {
    const res = await instrumentedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await arcAuthHeader(options.audience, options.scope),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`outbound ARC POST ${url} returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Like `arcPostJson` but returns the raw {@link Response} so the caller can
 * stream the body (used by the DSAR export fan-out to pipe a downstream's
 * NDJSON sub-bundle line-by-line into the outer envelope without buffering
 * it). Throws on a non-2xx status. The abort timer bounds time-to-headers;
 * the streaming body read is the caller's responsibility.
 */
export async function arcFetchStream(
  url: string,
  body: unknown,
  options: { audience: string; scope: string; timeoutMs?: number },
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs).unref?.();
  try {
    const res = await instrumentedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await arcAuthHeader(options.audience, options.scope),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`outbound ARC POST ${url} returned ${res.status}`);
    }
    return res;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wraps `arcPostJson` as an Effect with a tagged failure suitable for
 * service-layer error channels.
 */
export const arcPostJsonEffect = <T>(
  url: string,
  body: unknown,
  options: { audience: string; scope: string; timeoutMs?: number },
): Effect.Effect<T, Error> =>
  Effect.tryPromise({
    try: () => arcPostJson<T>(url, body, options),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`outbound ARC POST ${url} failed`),
  });

/**
 * Registers osn-api's outbound ARC public key with a downstream service via
 * its `/internal/register-service` endpoint (using the shared
 * INTERNAL_SERVICE_SECRET). Returns `false` when the secret is unset in
 * a local dev environment; throws in any non-local environment so a
 * misconfigured deployment fails fast at boot.
 *
 * Each downstream service must implement a sibling `/internal/register-service`
 * route; Pulse and Zap mirror osn-api's existing handler under
 * `/graph/internal/register-service`.
 */
export async function registerWithDownstream(
  serviceUrl: string,
  serviceSelfId: string,
  allowedScopes: string,
  // INTERNAL_SERVICE_SECRET + OSN_ENV threaded in by the caller. On workerd
  // secrets live ONLY on the `env` binding (not `process.env`), so they cannot
  // be read at module scope here. Defaults preserve the Bun path.
  secretEnv: { internalServiceSecret?: string; osnEnv?: string } = {
    internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET,
    osnEnv: process.env.OSN_ENV,
  },
): Promise<boolean> {
  const secret = secretEnv.internalServiceSecret;
  if (!secret) {
    if (!secretEnv.osnEnv || secretEnv.osnEnv === "local") return false;
    throw new Error(
      "INTERNAL_SERVICE_SECRET must be set — osn-api cannot register its outbound ARC key without it",
    );
  }
  const { publicKey, keyId, expiresAt } = await initKeys();
  const publicKeyJwk = await exportKeyToJwk(publicKey);
  const res = await instrumentedFetch(`${serviceUrl}/internal/register-service`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      serviceId: serviceSelfId,
      keyId,
      publicKeyJwk,
      allowedScopes,
      expiresAt: Math.floor(expiresAt / 1_000),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `osn-api failed to register outbound ARC key with ${serviceUrl}: HTTP ${res.status}`,
    );
  }
  return true;
}

/**
 * Hook intended for `osn/api/src/index.ts` startup — registers with each
 * downstream that osn-api will fan out to (Pulse + Zap) and schedules
 * rotation. Safe to call repeatedly; rotation timer is unref'd so it
 * never blocks shutdown.
 */
export async function startOutboundKeyRotation(opts: {
  pulseApiUrl?: string;
  zapApiUrl?: string;
  // INTERNAL_SERVICE_SECRET + OSN_ENV threaded in by the caller (see
  // `registerWithDownstream`). Defaults preserve the Bun `process.env` path.
  internalServiceSecret?: string;
  osnEnv?: string;
}): Promise<void> {
  const osnEnv = opts.osnEnv ?? process.env.OSN_ENV;
  const internalServiceSecret = opts.internalServiceSecret ?? process.env.INTERNAL_SERVICE_SECRET;
  const services = [
    { url: opts.pulseApiUrl, selfId: "osn-api" as const, scopes: DOWNSTREAM_SCOPES },
    { url: opts.zapApiUrl, selfId: "osn-api" as const, scopes: DOWNSTREAM_SCOPES },
  ].filter((s): s is { url: string; selfId: "osn-api"; scopes: string } => Boolean(s.url));

  for (const s of services) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential so a configured-stack failure short-circuits before the next downstream
      await registerWithDownstream(s.url, s.selfId, s.scopes, { internalServiceSecret, osnEnv });
    } catch (err) {
      // Local dev with a downstream that hasn't booted yet — fall through.
      // Production / staging surfaces a fast-fail boot error via registerWithDownstream
      // when INTERNAL_SERVICE_SECRET is missing; non-network failures on a
      // configured stack still throw out of this loop.
      if (osnEnv && osnEnv !== "local") throw err;
    }
  }

  const { expiresAt } = await initKeys();
  const rotateAt = expiresAt - KEY_ROTATION_BUFFER_MS;
  const delay = Math.max(rotateAt - Date.now(), 0);
  setTimeout(() => {
    _keyInitPromise = null;
    void startOutboundKeyRotation(opts);
  }, delay).unref?.();
}

/**
 * Once-per-isolate registration guard for the Workers `scheduled` path.
 *
 * The Bun server self-reschedules rotation via `startOutboundKeyRotation`'s
 * `setTimeout`, but a workerd isolate has no long-lived timer — every cron
 * tick re-enters `scheduled`. `registerWithDownstream` is an idempotent
 * upsert, so repeating it is harmless, but POSTing osn's public key to every
 * downstream on *every* tick is wasteful. This flag is flipped on the first
 * successful registration pass so subsequent ticks within the same isolate
 * skip the network round-trips. A fresh isolate starts unregistered and
 * registers again on its first tick. Note: workerd has no rotation timer, so
 * the latch is never reset within an isolate's life; the downstream
 * registration TTL (~24h) only bites an isolate that outlives it — in practice
 * isolates are short-lived, and a lapsed registration just 401s the fan-out,
 * which is retried next tick (fail-and-retry, never a silent erasure drop).
 */
let _downstreamRegistered = false;

/**
 * Registers osn's outbound ARC public key with each configured downstream
 * (Pulse + Zap) exactly once per isolate. Intended for the Workers
 * `scheduled` handler, which has no boot hook to run `startOutboundKeyRotation`
 * (the Bun path does that in `local.ts`).
 *
 * Reuses `registerWithDownstream` (no duplicated POST logic). Idempotent at
 * two levels: the module flag skips the network calls after the first success
 * this isolate, and `registerWithDownstream` itself is a PUT/upsert downstream.
 *
 * Resolves to `true` once registration has been attempted+succeeded (or was
 * already done this isolate), `false` when there is nothing to register (no
 * downstream URLs configured) so the caller can tell a no-op apart. Any
 * registration failure rejects — the caller is expected to log + swallow so a
 * transient downstream outage never aborts the cron sweeps.
 */
export async function registerOutboundKeysOnce(opts: {
  pulseApiUrl?: string;
  zapApiUrl?: string;
  internalServiceSecret?: string;
  osnEnv?: string;
}): Promise<boolean> {
  if (_downstreamRegistered) return true;

  const osnEnv = opts.osnEnv ?? process.env.OSN_ENV;
  const internalServiceSecret = opts.internalServiceSecret ?? process.env.INTERNAL_SERVICE_SECRET;
  const services = [
    { url: opts.pulseApiUrl, selfId: "osn-api" as const, scopes: DOWNSTREAM_SCOPES },
    { url: opts.zapApiUrl, selfId: "osn-api" as const, scopes: DOWNSTREAM_SCOPES },
  ].filter((s): s is { url: string; selfId: "osn-api"; scopes: string } => Boolean(s.url));

  if (services.length === 0) return false;

  for (const s of services) {
    // eslint-disable-next-line no-await-in-loop -- sequential so a configured-stack failure short-circuits before the next downstream (mirrors startOutboundKeyRotation)
    await registerWithDownstream(s.url, s.selfId, s.scopes, { internalServiceSecret, osnEnv });
  }

  // Only latch once every configured downstream accepted the key — a partial
  // failure throws above, leaving the flag false so the next tick retries.
  _downstreamRegistered = true;
  return true;
}

/**
 * Reset hook for tests — clears the in-memory keypair singleton so each
 * test that exercises outbound ARC starts with a fresh key. Also clears the
 * once-per-isolate downstream-registration latch so registration can be
 * re-exercised.
 */
export function _resetOutboundKeyForTests(): void {
  _keyInitPromise = null;
  _downstreamRegistered = false;
}
