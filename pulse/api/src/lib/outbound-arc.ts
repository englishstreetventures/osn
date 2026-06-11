import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@shared/crypto";
import { instrumentedFetch } from "@shared/observability";

/**
 * Pulse-api outbound ARC issuer for the leave-app flow.
 *
 * graphBridge.ts already registers a key with `graph:read` scope. We use a
 * SEPARATE key here registered with the leave-app scopes
 * (`step-up:verify`, `app-enrollment:write`) so a graph-bridge key
 * compromise can't be replayed at the more sensitive enrolment surface.
 *
 * Key shape mirrors graphBridge so the rotation lifecycle is uniform.
 */

const OSN_API_URL = process.env.OSN_API_URL ?? "http://localhost:4000";
const KEY_TTL_MS = parseFloat(process.env.PULSE_LEAVE_ARC_KEY_TTL_HOURS ?? "24") * 3_600 * 1_000;
const ALLOWED_SCOPES = "step-up:verify,app-enrollment:write";

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

export async function arcAuthHeader(audience: string, scope: string): Promise<string> {
  const { privateKey, keyId } = await initKeys();
  const token = await getOrCreateArcToken(privateKey, {
    iss: "pulse-api",
    aud: audience,
    scope,
    kid: keyId,
  });
  return `ARC ${token}`;
}

/**
 * Registers the leave-app key with osn-api on startup. Returns false in
 * local dev when `INTERNAL_SERVICE_SECRET` is unset; throws in any
 * non-local environment.
 */
export async function registerLeaveAppKeyWithOsnApi(): Promise<boolean> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    if (!process.env.OSN_ENV || process.env.OSN_ENV === "local") return false;
    throw new Error(
      "INTERNAL_SERVICE_SECRET must be set — pulse-api cannot register its leave-app ARC key",
    );
  }
  const { publicKey, keyId, expiresAt } = await initKeys();
  const publicKeyJwk = await exportKeyToJwk(publicKey);
  const res = await instrumentedFetch(`${OSN_API_URL}/graph/internal/register-service`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      serviceId: "pulse-api",
      keyId,
      publicKeyJwk,
      allowedScopes: ALLOWED_SCOPES,
      expiresAt: Math.floor(expiresAt / 1_000),
    }),
  });
  if (!res.ok) {
    throw new Error(`pulse-api leave-app key registration failed: HTTP ${res.status}`);
  }
  return true;
}

export function _resetLeaveAppKeyForTests(): void {
  _keyInitPromise = null;
}
