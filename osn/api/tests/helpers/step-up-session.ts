/**
 * The session a test mints a step-up token for. Every step-up token is bound
 * to the session family that minted it, and the verifier refuses it once that
 * family has no live, unrestricted, unexpired session, so a test that mints
 * one outside the routes needs a real session row to bind it to.
 */

import { sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { StepUpFactor, StepUpPurpose } from "@shared/observability/metrics";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";

import type { createAuthService } from "../../src/services/auth";
import type { MintingSession } from "../../src/services/auth/step-up";
import type { AssertingCredential } from "../../src/services/auth/types";

type AuthService = ReturnType<typeof createAuthService>;

/**
 * How long a seeded session lives. Past every fake clock a test sets inside
 * a token's life: the longest is a token's `exp` plus the verifier's 30-second
 * tolerance.
 */
const SEEDED_SESSION_TTL_S = 60 * 60;

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * A live, ordinary session of `accountId` in a family of its own, inserted
 * through the `Db` service (so a wrapped handle sees it): the minting session
 * to bind a step-up token to, and the row's hash, for a test that must spare
 * it from a sweep as a caller's own session is spared. Nobody holds its token.
 */
export const mintingSession = (
  accountId: string,
): Effect.Effect<MintingSession & { readonly sessionHash: string }, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const nowSec = Math.floor(Date.now() / 1000);
    const familyId = `sfam_${randomHex(6)}`;
    const sessionHash = randomHex(32);
    yield* Effect.promise(() =>
      db.insert(sessions).values({
        id: sessionHash,
        accountId,
        familyId,
        expiresAt: nowSec + SEEDED_SESSION_TTL_S,
        createdAt: nowSec,
        authenticatedAt: nowSec,
        lastUsedAt: nowSec,
      }),
    );
    return { accountId, familyId, sessionHash };
  });

/** `issueStepUpToken`, bound to a session {@link mintingSession} seeds for `accountId`. */
export const mintStepUpToken = (
  auth: Pick<AuthService, "issueStepUpToken">,
  accountId: string,
  factor: StepUpFactor,
  purpose?: StepUpPurpose,
  asserting?: AssertingCredential,
) =>
  Effect.flatMap(mintingSession(accountId), (minting) =>
    auth.issueStepUpToken(minting, factor, purpose, asserting),
  );

/** `completeStepUpTotp`, bound to a session {@link mintingSession} seeds for `accountId`. */
export const completeTotpStepUp = (
  auth: Pick<AuthService, "completeStepUpTotp">,
  accountId: string,
  code: string,
  purpose?: StepUpPurpose,
) =>
  Effect.flatMap(mintingSession(accountId), (minting) =>
    auth.completeStepUpTotp(minting, code, purpose),
  );

/** `completeStepUpPasskey`, bound to a session {@link mintingSession} seeds for `accountId`. */
export const completePasskeyStepUp = (
  auth: Pick<AuthService, "completeStepUpPasskey">,
  accountId: string,
  assertion: AuthenticationResponseJSON,
  purpose?: StepUpPurpose,
) =>
  Effect.flatMap(mintingSession(accountId), (minting) =>
    auth.completeStepUpPasskey(minting, assertion, purpose),
  );
