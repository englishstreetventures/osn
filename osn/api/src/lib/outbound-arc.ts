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
): Promise<boolean> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    if (!process.env.OSN_ENV || process.env.OSN_ENV === "local") return false;
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
}): Promise<void> {
  const services = [
    { url: opts.pulseApiUrl, selfId: "osn-api" as const, scopes: "account:erase" },
    { url: opts.zapApiUrl, selfId: "osn-api" as const, scopes: "account:erase" },
  ].filter((s): s is { url: string; selfId: "osn-api"; scopes: string } => Boolean(s.url));

  for (const s of services) {
    try {
      await registerWithDownstream(s.url, s.selfId, s.scopes);
    } catch (err) {
      // Local dev with a downstream that hasn't booted yet — fall through.
      // Production / staging surfaces a fast-fail boot error via registerWithDownstream
      // when INTERNAL_SERVICE_SECRET is missing; non-network failures on a
      // configured stack still throw out of this loop.
      if (process.env.OSN_ENV && process.env.OSN_ENV !== "local") throw err;
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
 * Reset hook for tests — clears the in-memory keypair singleton so each
 * test that exercises outbound ARC starts with a fresh key.
 */
export function _resetOutboundKeyForTests(): void {
  _keyInitPromise = null;
}
