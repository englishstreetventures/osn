import type { Db } from "@osn/db/service";
import { Effect } from "effect";

import type { AuthService, ProfileWithEmail } from "../services/auth";

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
 * Unified auth check for routes that need both the authenticated profile and
 * its accountId. Combines the Bearer access-token verification with the
 * profile DB lookup in a single call — collapses the duplicate pattern used
 * across profile and auth routes (S-M2).
 */
export async function requireAuth(
  auth: AuthService,
  run: <A, E>(eff: Effect.Effect<A, E, Db>) => Promise<A>,
  authHeader: string | undefined,
): Promise<{ profile: ProfileWithEmail; accountId: string } | null> {
  const claims = await resolveAccessTokenPrincipal(auth, authHeader);
  if (!claims) return null;
  const profile = await run(auth.findProfileById(claims.profileId));
  if (!profile) return null;
  return { profile, accountId: profile.accountId };
}
