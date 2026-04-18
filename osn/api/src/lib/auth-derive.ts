import { createHash } from "node:crypto";

import type { Db } from "@osn/db/service";
import { getClientIp } from "@shared/rate-limit";
import { Effect } from "effect";

import type { AuthService, SessionContext } from "../services/auth";

/**
 * Resolves a Bearer access token from the Authorization header. Returns
 * the token claims on success, or null if the header is missing / invalid.
 * Used by profile and auth endpoints that authenticate via access token (S-H1).
 */
export async function resolveAccessTokenPrincipal(
  auth: AuthService,
  authHeader: string | undefined,
): Promise<{
  profileId: string;
  email: string;
  handle: string;
  displayName: string | null;
} | null> {
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const result = await Effect.runPromise(Effect.either(auth.verifyAccessToken(token)));
  if (result._tag === "Right") return result.right;
  return null;
}

/**
 * Resolves the accountId from a Bearer access token. Returns null if auth
 * fails. Wraps resolveAccessTokenPrincipal + DB lookup.
 */
export async function resolveAccountId(
  auth: AuthService,
  run: <A, E>(eff: Effect.Effect<A, E, Db>) => Promise<A>,
  authHeader: string | undefined,
): Promise<{ accountId: string } | null> {
  const claims = await resolveAccessTokenPrincipal(auth, authHeader);
  if (!claims) return null;
  const profile = await run(auth.findProfileById(claims.profileId));
  if (!profile) return null;
  return { accountId: profile.accountId };
}

/** Cap the UA column at 512 chars — protects the DB from pathological headers. */
const USER_AGENT_MAX = 512;

/**
 * Returns the IP-hashing salt. Defaults to a stable local-dev sentinel so
 * tests / local dev produce deterministic hashes; production must set
 * `OSN_IP_HASH_SALT` explicitly. The hash is a coarse device fingerprint for
 * the session list UI — NOT a security boundary — so rotating the salt
 * (invalidating historic `ip_hash` equality) is acceptable.
 */
function ipHashSalt(): string {
  return process.env["OSN_IP_HASH_SALT"] ?? "osn-local-ip-salt";
}

/**
 * Computes the salted SHA-256 fingerprint used in `sessions.ip_hash` and
 * `sessions.created_ip_hash`. Returns null when the client IP is unavailable
 * (the route layer then stores null for that column).
 */
export function hashClientIp(clientIp: string | null): string | null {
  if (!clientIp) return null;
  return createHash("sha256")
    .update(clientIp + ipHashSalt())
    .digest("hex");
}

/**
 * Builds the `SessionContext` passed into `issueTokens` / `refreshTokens`.
 * Reads from the inbound request headers — User-Agent (trimmed + capped) and
 * the forwarded client IP (hashed + salted).
 */
export function resolveSessionContext(headers: Record<string, string | undefined>): SessionContext {
  const rawUa = headers["user-agent"];
  const userAgent = rawUa ? rawUa.slice(0, USER_AGENT_MAX) : undefined;
  const clientIp = getClientIp(headers) || null;
  const ipHash = hashClientIp(clientIp) ?? undefined;
  return { userAgent, ipHash };
}
