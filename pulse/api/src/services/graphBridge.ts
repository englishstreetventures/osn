import { exportKeyToJwk, generateArcKeyPair, getOrCreateArcToken } from "@osn/crypto";
import { Data, Effect } from "effect";

import { MAX_EVENT_GUESTS } from "../lib/limits";

/**
 * Single error type used by all graph-bridge functions. Wraps any failure
 * from the underlying OSN graph HTTP endpoints so callers have one tag to
 * catch instead of a union of errors they don't own.
 */
export class GraphBridgeError extends Data.TaggedError("GraphBridgeError")<{
  readonly cause: unknown;
}> {}

export interface ProfileDisplay {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

// ---------------------------------------------------------------------------
// Internal — key management and HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Isolated bridge to the OSN social graph over ARC-authenticated HTTP.
 *
 * This is the only file in `pulse/api` that makes S2S calls to `@osn/api`.
 * Other services call through here so changes to the transport layer stay
 * local to this file — no touching of `rsvps.ts` or routes.
 *
 * Auth strategy (in priority order):
 *   1. `PULSE_API_ARC_PRIVATE_KEY` env var — use a pre-distributed stable
 *      key (production). The matching public key must already be in the
 *      osn/api service_accounts table (e.g. seeded or added via admin).
 *   2. Ephemeral key + self-registration — generate a fresh P-256 key pair
 *      on startup and register the public key via `registerWithOsnApi()`
 *      (which calls `POST /graph/internal/register-service` using the
 *      shared `INTERNAL_SERVICE_SECRET`). No private key in any file.
 */

const OSN_API_URL = process.env.OSN_API_URL ?? "http://localhost:4000";

// Validate the URL scheme in production to prevent ARC tokens being sent
// over plaintext. The check runs once at module load; it never fires in
// tests because NODE_ENV is "test".
if (process.env.NODE_ENV === "production" && !OSN_API_URL.startsWith("https://")) {
  throw new Error(`OSN_API_URL must use https:// in production (got: ${OSN_API_URL})`);
}

// ---------------------------------------------------------------------------
// Key rotation config
// ---------------------------------------------------------------------------

/** How long a newly generated key is valid. Only applies to ephemeral keys. */
const KEY_TTL_MS = parseFloat(process.env.KEY_TTL_HOURS ?? "24") * 3600 * 1000;
/** How early before expiry to rotate. Must be > ARC token TTL (5 min). */
const KEY_ROTATION_BUFFER_MS =
  parseFloat(process.env.KEY_ROTATION_BUFFER_HOURS ?? "2") * 3600 * 1000;

// ---------------------------------------------------------------------------
// Key-pair singleton — Promise-based so concurrent startup callers collapse
// onto a single in-flight generation (fixes the async TOCTOU race).
// ---------------------------------------------------------------------------

interface KeyInit {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** UUID that becomes the `kid` JWT header field. */
  keyId: string;
  /** Unix ms when this key expires. */
  expiresAt: number;
}

let _keyInitPromise: Promise<KeyInit> | null = null;

function initKeys(): Promise<KeyInit> {
  _keyInitPromise ??= (async (): Promise<KeyInit> => {
    const pair = await generateArcKeyPair();
    const keyId = crypto.randomUUID();
    const expiresAt = Date.now() + KEY_TTL_MS;
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, keyId, expiresAt };
  })();
  return _keyInitPromise;
}

async function arcAuthHeader(): Promise<string> {
  const { privateKey, keyId } = await initKeys();
  const token = await getOrCreateArcToken(privateKey, {
    iss: "pulse-api",
    aud: "osn-core",
    // POST endpoints (/close-friends-of, /profile-displays) are read-equivalent
    // enrichment calls; graph:read is the correct scope for all four bridge calls.
    // If a truly mutating S2S POST is ever added, introduce a new scope and a
    // separate osPost variant rather than expanding this one.
    scope: "graph:read",
    kid: keyId,
  });
  return `ARC ${token}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function osGet<T>(path: string): Promise<T> {
  const res = await fetch(`${OSN_API_URL}${path}`, {
    headers: { authorization: await arcAuthHeader() },
  });
  if (!res.ok) throw new Error(`OSN API GET ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function osPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${OSN_API_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await arcAuthHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OSN API POST ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Startup self-registration (ephemeral key path)
// ---------------------------------------------------------------------------

/**
 * Registers the current public key with osn/api on startup.
 * Requires INTERNAL_SERVICE_SECRET — throws if unset so the misconfiguration
 * is caught immediately at boot rather than failing silently (S-L101).
 */
async function registerWithOsnApi(): Promise<void> {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    throw new Error(
      "INTERNAL_SERVICE_SECRET must be set — pulse-api cannot register its ARC key without it",
    );
  }

  const { publicKey, keyId, expiresAt } = await initKeys();
  const publicKeyJwk = await exportKeyToJwk(publicKey);
  const res = await fetch(`${OSN_API_URL}/graph/internal/register-service`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      serviceId: "pulse-api",
      keyId,
      publicKeyJwk,
      allowedScopes: "graph:read",
      expiresAt: Math.floor(expiresAt / 1000),
    }),
  });

  if (!res.ok) {
    throw new Error(`pulse-api failed to register with osn/api: HTTP ${res.status}`);
  }
}

/**
 * Schedules automatic key rotation before `expiresAtMs`.
 * On failure, retries in 5 minutes.
 */
function scheduleRotation(expiresAtMs: number): void {
  const rotateAt = expiresAtMs - KEY_ROTATION_BUFFER_MS;
  const delay = Math.max(rotateAt - Date.now(), 0);
  setTimeout(() => void rotateKey(), delay).unref?.();
}

async function rotateKey(): Promise<void> {
  try {
    const pair = await generateArcKeyPair();
    const keyId = crypto.randomUUID();
    const expiresAt = Date.now() + KEY_TTL_MS;

    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!secret) return; // rotation only works with shared secret

    const publicKeyJwk = await exportKeyToJwk(pair.publicKey);
    const res = await fetch(`${OSN_API_URL}/graph/internal/register-service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        serviceId: "pulse-api",
        keyId,
        publicKeyJwk,
        allowedScopes: "graph:read",
        expiresAt: Math.floor(expiresAt / 1000),
      }),
    });
    if (!res.ok) throw new Error(`key rotation failed: HTTP ${res.status}`);

    // Swap singleton AFTER successful registration so no requests use the
    // new key before osn/api knows about it.
    _keyInitPromise = Promise.resolve<KeyInit>({
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      keyId,
      expiresAt,
    });

    scheduleRotation(expiresAt);
  } catch {
    // Back-off 5 min on failure with ±30 s jitter to avoid thundering-herd
    // when multiple instances fail simultaneously (P-I100).
    setTimeout(() => void rotateKey(), 5 * 60 * 1000 + Math.random() * 30_000).unref?.();
  }
}

/**
 * Registers the service's ephemeral public key with osn/api and schedules
 * automatic key rotation. Call once at startup.
 *
 * Throws if `INTERNAL_SERVICE_SECRET` is unset — misconfiguration is surfaced
 * immediately at boot rather than failing silently on the first S2S call.
 */
export async function startKeyRotation(): Promise<void> {
  await registerWithOsnApi();
  const { expiresAt } = await initKeys();
  scheduleRotation(expiresAt);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The set of profile IDs `profileId` is connected to (accepted connections only).
 * Returns a `Set` for O(1) membership checks in the RSVP visibility filter.
 *
 * Bounded by `MAX_EVENT_GUESTS` — the platform's hard cap on event guest
 * count. See `lib/limits.ts` for rationale.
 */
export const getConnectionIds = (profileId: string): Effect.Effect<Set<string>, GraphBridgeError> =>
  Effect.tryPromise({
    try: async () => {
      const data = await osGet<{ connectionIds: string[] }>(
        `/graph/internal/connections?profileId=${encodeURIComponent(profileId)}&limit=${MAX_EVENT_GUESTS}`,
      );
      return new Set(data.connectionIds);
    },
    catch: (cause) => new GraphBridgeError({ cause }),
  });

/**
 * The set of profile IDs `profileId` has marked as close friends. Bounded by
 * `MAX_EVENT_GUESTS` for the same reason as `getConnectionIds`.
 */
export const getCloseFriendIds = (
  profileId: string,
): Effect.Effect<Set<string>, GraphBridgeError> =>
  Effect.tryPromise({
    try: async () => {
      const data = await osGet<{ closeFriendIds: string[] }>(
        `/graph/internal/close-friends?profileId=${encodeURIComponent(profileId)}&limit=${MAX_EVENT_GUESTS}`,
      );
      return new Set(data.closeFriendIds);
    },
    catch: (cause) => new GraphBridgeError({ cause }),
  });

/**
 * Returns the subset of `attendeeIds` that have marked `viewerId` as a
 * close friend — i.e. attendees who explicitly opted to let this viewer
 * into their close-friends circle.
 *
 * Used by `listRsvps` to stamp an `isCloseFriend` display flag on each
 * returned row. Display affordance only — close-friendship never gates access.
 */
export const getCloseFriendsOf = (
  viewerId: string,
  attendeeIds: string[],
): Effect.Effect<Set<string>, GraphBridgeError> =>
  attendeeIds.length === 0
    ? Effect.succeed(new Set())
    : Effect.tryPromise({
        try: async () => {
          const data = await osPost<{ closeFriendIds: string[] }>(
            "/graph/internal/close-friends-of",
            { viewerId, profileIds: attendeeIds },
          );
          return new Set(data.closeFriendIds);
        },
        catch: (cause) => new GraphBridgeError({ cause }),
      });

/**
 * Fetches display metadata for a batch of OSN profile IDs. Used by the RSVP
 * service to join names/avatars onto RSVP rows before returning to the client.
 * Names NEVER come from the JWT — always fresh from OSN.
 *
 * Returns a Map keyed by profile ID for efficient lookup during join.
 */
export const getProfileDisplays = (
  profileIds: string[],
): Effect.Effect<Map<string, ProfileDisplay>, GraphBridgeError> =>
  profileIds.length === 0
    ? Effect.succeed(new Map())
    : Effect.tryPromise({
        try: async () => {
          const data = await osPost<{ profiles: ProfileDisplay[] }>(
            "/graph/internal/profile-displays",
            { profileIds },
          );
          return new Map(data.profiles.map((p) => [p.id, p]));
        },
        catch: (cause) => new GraphBridgeError({ cause }),
      });
