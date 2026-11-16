import type { Db } from "@osn/db/service";
import { Effect } from "effect";

import type { AuthService } from "../services/auth";

/**
 * Resolves a Bearer access token from the Authorization header. Returns
 * the token claims on success, or null if the header is missing / invalid.
 * Used by profile and auth endpoints that authenticate via access token.
 */
export async function resolveAccessTokenPrincipal(
  auth: AuthService,
  authHeader: string | undefined,
): Promise<{
  profileId: string;
  email: string;
  handle: string;
  displayName: string | null;
  /** `osn_sid` — one-way binding to the session this token was minted from. */
  sessionBinding: string | null;
} | null> {
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const result = await Effect.runPromise(Effect.result(auth.verifyAccessToken(token)));
  if (result._tag === "Success") return result.success;
  return null;
}

/**
 * The same, for a **restricted recovery session's** access token
 * (`aud: "osn-recovery"`). Returns null for an ordinary access token, so this
 * never widens a caller that meant to accept only `osn-access`.
 *
 * One caller: `resolvePasskeyEnrollPrincipal`. Passkey enrolment is the only
 * thing a restricted session may reach.
 */
export async function resolveRecoveryTokenPrincipal(
  auth: AuthService,
  authHeader: string | undefined,
): Promise<{
  profileId: string;
  email: string;
  handle: string;
  displayName: string | null;
  sessionBinding: string | null;
} | null> {
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const result = await Effect.runPromise(Effect.result(auth.verifyRecoveryAccessToken(token)));
  if (result._tag === "Success") return result.success;
  return null;
}

/**
 * The caller of a route an account may reach while its deletion is pending:
 * an ordinary access token (`osn-access`, tried first), or the access token of
 * a session of an account whose deletion is pending (`osn-pending-deletion`),
 * with `pendingDeletion` saying which. Null for no token and for any other
 * audience.
 *
 * Only the deletion-status, export, restore and delete routes may call it,
 * and the step-up routes, for the step-ups export and restore need. A caller
 * given `pendingDeletion: true` reads the profile with
 * `findProfileByIdIncludingTombstoned` and refuses the token when the account
 * is no longer pending deletion; given `false`, it resolves the profile as
 * every other route does.
 */
export async function resolveAccountWindowPrincipal(
  auth: AuthService,
  authHeader: string | undefined,
): Promise<{
  profileId: string;
  email: string;
  handle: string;
  displayName: string | null;
  sessionBinding: string | null;
  pendingDeletion: boolean;
} | null> {
  const ordinary = await resolveAccessTokenPrincipal(auth, authHeader);
  if (ordinary) return { ...ordinary, pendingDeletion: false };
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const result = await Effect.runPromise(
    Effect.result(auth.verifyPendingDeletionAccessToken(token)),
  );
  if (result._tag === "Success") return { ...result.success, pendingDeletion: true };
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
