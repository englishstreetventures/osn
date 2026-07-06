import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@shared/crypto";
import { instrumentedFetch } from "@shared/observability";

/**
 * Pulse-api outbound ARC issuer for the leave-app flow.
 *
 * A SEPARATE key from graphBridge's so the two surfaces don't share signing
 * material. ⚠ Note this does NOT (yet) buy scope isolation between the keys:
 * osn-api authorises scopes per SERVICE (`service_accounts.allowedScopes`,
 * upsert = full replace), not per key, so both pulse-api registrations must
 * carry the identical scope union or they clobber each other on every boot
 * race / rotation (S-H1, prep-pr review 2026-07-05). Keep `ALLOWED_SCOPES`
 * in lockstep with `services/graphBridge.ts` `REGISTERED_SCOPES`. Per-key
 * scope storage (restoring the key-compromise blast-radius separation this
 * file originally claimed) is tracked in wiki/TODO.md.
 *
 * Tokens minted here still carry only the minimal per-call scope
 * (`arcAuthHeader(audience, scope)`).
 *
 * Key shape mirrors graphBridge so the rotation lifecycle is uniform.
 */

const OSN_API_URL = process.env.OSN_API_URL ?? "http://localhost:4000";
const KEY_TTL_MS = parseFloat(process.env.PULSE_LEAVE_ARC_KEY_TTL_HOURS ?? "24") * 3_600 * 1_000;
// Full pulse-api scope union — see the header comment (must equal
// graphBridge's REGISTERED_SCOPES).
const ALLOWED_SCOPES = "graph:read,graph:resolve-account,step-up:verify,app-enrollment:write";

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
