import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@shared/crypto";
import { Data, Effect } from "effect";

/**
 * Isolated bridge to the OSN social graph over ARC-authenticated HTTP.
 *
 * This is the only file in `zap/api` that makes S2S calls to `@osn/api`.
 * Other services call through here (via `consent.ts`) so the transport layer
 * stays local — mirrors `pulse/api/src/services/graphBridge.ts`.
 *
 * PROVISIONING NOTE: this requires `zap-api` to be registered as an ARC issuer
 * in the OSN `service_accounts` table (allowed scope `graph:read`, audience
 * `osn-api`). In local dev that happens via self-registration with
 * `INTERNAL_SERVICE_SECRET`; production must seed the public key out-of-band.
 */

export class GraphBridgeError extends Data.TaggedError("GraphBridgeError")<{
  readonly cause: unknown;
}> {}

const OSN_API_URL = process.env.OSN_API_URL ?? "http://localhost:4000";

// Validate the URL scheme in production to prevent ARC tokens being sent over
// plaintext. Runs once at module load; never fires in tests (NODE_ENV=test).
if (process.env.NODE_ENV === "production" && !OSN_API_URL.startsWith("https://")) {
  throw new Error(`OSN_API_URL must use https:// in production (got: ${OSN_API_URL})`);
}

// ---------------------------------------------------------------------------
// Key-pair singleton (ephemeral key path — mirrors pulse graphBridge)
// ---------------------------------------------------------------------------

interface KeyInit {
  privateKey: CryptoKey;
  keyId: string;
}

let _keyInitPromise: Promise<KeyInit> | null = null;

function initKeys(): Promise<KeyInit> {
  _keyInitPromise ??= (async (): Promise<KeyInit> => {
    const pair = await generateArcKeyPair();
    return { privateKey: pair.privateKey, keyId: crypto.randomUUID() };
  })();
  return _keyInitPromise;
}

async function arcAuthHeader(): Promise<string> {
  const { privateKey, keyId } = await initKeys();
  const token = await getOrCreateArcToken(privateKey, {
    iss: "zap-api",
    aud: "osn-api",
    scope: "graph:read",
    kid: keyId,
  });
  return `ARC ${token}`;
}

// ---------------------------------------------------------------------------
// Startup self-registration (ephemeral key path)
// ---------------------------------------------------------------------------

function isLocalEnv(): boolean {
  return !process.env.OSN_ENV || process.env.OSN_ENV === "local";
}

/**
 * Registers the current public key with osn/api so its ARC tokens verify.
 * Returns `false` when `INTERNAL_SERVICE_SECRET` is unset in local dev (the
 * caller logs a warning and boots anyway); throws in any non-local env so a
 * misconfigured deploy is caught at boot rather than on the first S2S call.
 */
export async function registerWithOsnApi(): Promise<boolean> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    if (isLocalEnv()) return false;
    throw new Error(
      "INTERNAL_SERVICE_SECRET must be set — zap-api cannot register its ARC key without it",
    );
  }

  const pair = await generateArcKeyPair();
  const keyId = crypto.randomUUID();
  _keyInitPromise = Promise.resolve({ privateKey: pair.privateKey, keyId });

  const publicKeyJwk = await exportKeyToJwk(pair.publicKey);
  const res = await fetch(`${OSN_API_URL}/graph/internal/register-service`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      serviceId: "zap-api",
      keyId,
      publicKeyJwk,
      allowedScopes: "graph:read",
      // 24h; local dev re-registers on each boot.
      expiresAt: Math.floor((Date.now() + 24 * 3600 * 1000) / 1000),
    }),
  });
  if (!res.ok) throw new Error(`zap-api failed to register with osn/api: HTTP ${res.status}`);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True iff `viewerProfileId` and `targetProfileId` are an accepted connection
 * in the OSN social graph. Uses the per-pair `/graph/internal/connection-status`
 * endpoint (status `"connected"`) — one round-trip per pair, no list scan.
 * Self-pairs are trivially "connected".
 *
 * Fails with `GraphBridgeError` on any HTTP / network failure — callers MUST
 * treat that as fail-closed (reject), never as "allowed".
 */
export const areConnected = (
  viewerProfileId: string,
  targetProfileId: string,
): Effect.Effect<boolean, GraphBridgeError> =>
  viewerProfileId === targetProfileId
    ? Effect.succeed(true)
    : Effect.tryPromise({
        try: async () => {
          const qs = new URLSearchParams({
            viewerId: viewerProfileId,
            targetId: targetProfileId,
          });
          const res = await fetch(
            `${OSN_API_URL}/graph/internal/connection-status?${qs.toString()}`,
            { headers: { authorization: await arcAuthHeader() } },
          );
          if (!res.ok) {
            throw new Error(`OSN API GET /graph/internal/connection-status returned ${res.status}`);
          }
          const data = (await res.json()) as { status: string };
          return data.status === "connected";
        },
        catch: (cause) => new GraphBridgeError({ cause }),
      });
