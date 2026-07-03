/**
 * Step-up (sudo) tokens — M-PK1. Short-lived ES256 JWTs minted by a fresh
 * authentication ceremony (passkey or OTP to the account's verified email)
 * and required by the most sensitive endpoints. Signed with the same ES256
 * key as access tokens but with a distinct audience claim (`osn-step-up`)
 * so they cannot be cross-used. Replay-guarded via single-use `jti`s in the
 * injected {@link StepUpJtiStore}.
 */

import { accounts, passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { type EmailError, EmailService } from "@shared/email";
import type {
  StepUpFactor,
  StepUpPurpose,
  StepUpVerifyResult,
} from "@shared/observability/metrics";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { timingSafeEqualString } from "../../lib/timing-safe";
import {
  metricAuthOtpSent,
  metricStepUpIssued,
  metricStepUpVerified,
  withStepUp,
} from "../../metrics";
import { CHALLENGE_TTL_MS, MAX_OTP_ATTEMPTS, PASSKEY_LAST_USED_COALESCE_MS } from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genOtpCode, hashSessionToken, logDevOtp, signJwt, verifyJwt } from "./helpers";

export function createStepUpModule(ctx: AuthContext) {
  const {
    config,
    stores,
    jtiStore,
    otpTtl,
    stepUpTokenTtl,
    recoveryGenerateAllowedAmr,
    passkeyDeleteAllowedAmr,
    passkeyRegisterAllowedAmr,
  } = ctx;

  const STEP_UP_AUDIENCE = "osn-step-up";

  /**
   * Mints a step-up (sudo) JWT bound to {@link accountId} via the `sub`
   * claim. When {@link purpose} is supplied the token also carries a
   * matching `purpose` claim that the verifier can require — used by
   * sensitive operations (account delete, app delete) to defend against
   * confused-deputy reuse of a token meant for a different action.
   * Tokens minted without a purpose remain valid for any verifier that
   * does not require one (back-compat with recovery / passkey / email
   * change endpoints).
   */
  const issueStepUpToken = (accountId: string, factor: StepUpFactor, purpose?: StepUpPurpose) =>
    Effect.gen(function* () {
      // Map the ceremony factor onto RFC 8176 "amr" values the verifier reads.
      const amr = factor === "passkey" ? "webauthn" : factor === "otp" ? "otp" : "recovery";
      const token = yield* Effect.tryPromise({
        try: () =>
          signJwt(
            {
              sub: accountId,
              aud: STEP_UP_AUDIENCE,
              amr: [amr],
              jti: crypto.randomUUID(),
              ...(purpose ? { purpose } : {}),
            },
            config.jwtPrivateKey,
            config.jwtKid,
            stepUpTokenTtl,
            config.issuerUrl,
          ),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });
      metricStepUpIssued(factor);
      return token;
    });

  /**
   * Verifies a step-up token and returns the amr values it carries. Fails
   * with an AuthError on any signature / audience / expiry / replay issue;
   * the error message is intentionally generic so the wire doesn't leak
   * whether it was a wrong sub or a replayed jti.
   */
  /**
   * Verifies a step-up token and returns the amr + purpose it carries
   * along with the verified accountId (the token's `sub` claim). Pass
   * `expectedAccountId` to enforce a sub equality check (most callers do);
   * pass `null` to accept any account — used by cross-service verifiers
   * like `/internal/step-up/verify` where the calling service derives the
   * accountId from the token's verified sub rather than asserting one
   * up front.
   */
  const verifyStepUpToken = (
    token: string,
    expectedAccountId: string | null,
    allowedAmr: ReadonlySet<string>,
    expectedPurpose?: StepUpPurpose,
  ): Effect.Effect<
    { amr: string[]; purpose: StepUpPurpose | null; accountId: string },
    AuthError
  > =>
    Effect.gen(function* () {
      const record = (result: StepUpVerifyResult) =>
        Effect.sync(() => metricStepUpVerified(result));

      const payloadResult = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtPublicKey, config.issuerUrl),
        catch: () => new AuthError({ message: "Invalid step-up token" }),
      }).pipe(Effect.tapError(() => record("invalid")));

      if (payloadResult["aud"] !== STEP_UP_AUDIENCE) {
        yield* record("wrong_audience");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }
      if (typeof payloadResult["sub"] !== "string") {
        yield* record("wrong_subject");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }
      if (expectedAccountId !== null && payloadResult["sub"] !== expectedAccountId) {
        yield* record("wrong_subject");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }
      const accountId = payloadResult["sub"];
      const jti = payloadResult["jti"];
      if (typeof jti !== "string") {
        yield* record("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }

      const amrRaw = payloadResult["amr"];
      const amr = Array.isArray(amrRaw)
        ? amrRaw.filter((v): v is string => typeof v === "string")
        : [];
      if (!amr.some((v) => allowedAmr.has(v))) {
        yield* record("amr_not_allowed");
        return yield* Effect.fail(new AuthError({ message: "Step-up factor not permitted" }));
      }

      // Confused-deputy guard: when the verifier requires a specific purpose,
      // the token must carry a matching `purpose` claim. Tokens minted
      // without a purpose are accepted only by verifiers that don't require
      // one (preserves back-compat with the legacy recovery / passkey
      // verifyStepUpFor* helpers).
      const purposeClaim = payloadResult["purpose"];
      const tokenPurpose: StepUpPurpose | null =
        typeof purposeClaim === "string" ? (purposeClaim as StepUpPurpose) : null;
      if (expectedPurpose && tokenPurpose !== expectedPurpose) {
        yield* record("wrong_purpose");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }

      // S-H1: cluster-safe single-use guard. First consumer wins; every
      // subsequent presentation — local, another pod, or a replay after a
      // Redis failover — lands on the jti-already-consumed branch.
      const consumed = yield* Effect.tryPromise({
        try: () => jtiStore.consume(jti, stepUpTokenTtl * 1000),
        catch: () => new AuthError({ message: "Step-up token could not be verified" }),
      });
      if (!consumed) {
        yield* record("jti_replay");
        return yield* Effect.fail(new AuthError({ message: "Step-up token already used" }));
      }
      yield* record("ok");
      return { amr, purpose: tokenPurpose, accountId };
    });

  /**
   * Step-up passkey: begin. Caller is already authenticated; we scope
   * the challenge to their account so a stolen assertion for a different
   * credential cannot be replayed.
   */
  const beginStepUpPasskey = (
    accountId: string,
  ): Effect.Effect<
    { options: PublicKeyCredentialRequestOptionsJSON },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const accountPasskeys = yield* Effect.tryPromise({
        try: () => db.select().from(passkeys).where(eq(passkeys.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (accountPasskeys.length === 0) {
        return yield* Effect.fail(
          new AuthError({ message: "No passkeys registered for this account" }),
        );
      }
      const options = yield* Effect.tryPromise({
        try: () =>
          generateAuthenticationOptions({
            rpID: config.rpId,
            allowCredentials: accountPasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            })),
            userVerification: "preferred",
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });
      // P-I3: bound growth under ceremony-begin spam — handled inside the store (O3).
      yield* Effect.promise(() =>
        stores.stepUpPasskeyChallenges.set(
          accountId,
          { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS },
          CHALLENGE_TTL_MS,
        ),
      );
      return { options };
    }).pipe(withStepUp("begin"));

  /**
   * Step-up passkey: complete. Verifies the assertion against the account's
   * own challenge (not an identifier-keyed one — defence against a stolen
   * session being used to step up as somebody else) and mints the token.
   *
   * `purpose` binds the resulting JWT to a specific destructive operation
   * (S-C1) — verifiers that require a matching purpose (e.g.
   * `verifyStepUpForAccountDelete`) reject tokens minted for any other
   * purpose. Tokens minted without a purpose remain valid for legacy
   * callers that don't enforce one.
   */
  const completeStepUpPasskey = (
    accountId: string,
    assertion: AuthenticationResponseJSON,
    purpose?: StepUpPurpose,
  ): Effect.Effect<{ stepUpToken: string; expiresIn: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() => stores.stepUpPasskeyChallenges.get(accountId));
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      yield* Effect.promise(() => stores.stepUpPasskeyChallenges.delete(accountId));

      const { db } = yield* Db;
      const pkResult = yield* Effect.tryPromise({
        try: () =>
          db.select().from(passkeys).where(eq(passkeys.credentialId, assertion.id)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const pk = pkResult[0];
      if (!pk || pk.accountId !== accountId) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }

      const verification = yield* Effect.tryPromise({
        try: () =>
          verifyAuthenticationResponse({
            response: assertion,
            expectedChallenge: entry.challenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpId,
            credential: {
              id: pk.credentialId,
              publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64")),
              counter: pk.counter,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            },
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });
      if (!verification.verified) {
        return yield* Effect.fail(new AuthError({ message: "Passkey verification failed" }));
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const shouldTouchLastUsed =
        !pk.lastUsedAt || Date.now() - pk.lastUsedAt * 1000 >= PASSKEY_LAST_USED_COALESCE_MS;
      const updates: Record<string, number | boolean> = {
        counter: verification.authenticationInfo.newCounter,
      };
      if (shouldTouchLastUsed) {
        updates["lastUsedAt"] = nowSec;
        updates["updatedAt"] = nowSec;
      }
      yield* Effect.tryPromise({
        try: () => db.update(passkeys).set(updates).where(eq(passkeys.id, pk.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const stepUpToken = yield* issueStepUpToken(accountId, "passkey", purpose);
      return { stepUpToken, expiresIn: stepUpTokenTtl };
    }).pipe(withStepUp("complete"));

  /**
   * Step-up OTP: begin. Emails a fresh 6-digit code to the account's
   * verified email. Keyed separately from login OTPs so a login code
   * cannot authorise a sensitive action and vice versa.
   */
  const beginStepUpOtp = (
    accountId: string,
  ): Effect.Effect<{ sent: boolean }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const accountRow = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = accountRow[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      const code = genOtpCode();
      // P-I3: bound growth under ceremony-begin spam — handled inside the store (O3).
      yield* Effect.promise(() =>
        stores.stepUpOtp.set(
          accountId,
          {
            codeHash: hashSessionToken(code),
            attempts: 0,
            expiresAt: Date.now() + otpTtl * 1000,
          },
          otpTtl * 1000,
        ),
      );
      yield* logDevOtp("step-up", account.email, code);
      const email = yield* EmailService;
      yield* email
        .send({
          template: "otp-step-up",
          to: account.email,
          data: { code, ttlMinutes: otpTtl / 60 },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) =>
              new AuthError({ message: `Failed to send email: ${cause.reason}` }),
          ),
        );
      // S-L1: distinguish step-up OTPs from login OTPs on the dashboard.
      metricAuthOtpSent("step_up");
      return { sent: true };
    }).pipe(withStepUp("begin"));

  const completeStepUpOtp = (
    accountId: string,
    code: string,
    purpose?: StepUpPurpose,
  ): Effect.Effect<{ stepUpToken: string; expiresIn: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = yield* Effect.promise(() => stores.stepUpOtp.get(accountId));
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!timingSafeEqualString(entry.codeHash, hashSessionToken(code))) {
        // O3: persist the attempt bump (store does not alias the value) and
        // carry the remaining TTL so the entry expires on its original schedule.
        const attempts = entry.attempts + 1;
        if (attempts >= MAX_OTP_ATTEMPTS) {
          yield* Effect.promise(() => stores.stepUpOtp.delete(accountId));
        } else {
          yield* Effect.promise(() =>
            stores.stepUpOtp.set(
              accountId,
              { ...entry, attempts },
              Math.max(0, entry.expiresAt - Date.now()),
            ),
          );
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      yield* Effect.promise(() => stores.stepUpOtp.delete(accountId));
      const stepUpToken = yield* issueStepUpToken(accountId, "otp", purpose);
      return { stepUpToken, expiresIn: stepUpTokenTtl };
    }).pipe(withStepUp("complete"));

  /**
   * S-L4: separate step-up verifier for `DELETE /passkeys/:id`. Defaults
   * to passkey-only AMR — the caller necessarily has a passkey (the
   * last-passkey lockout guard fires otherwise), so requiring one for
   * deletion is the strongest available signal at no UX cost.
   */
  const verifyStepUpForPasskeyDelete = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyDeleteAllowedAmr);
    });

  /**
   * S-H1: step-up verifier for `/passkey/register/{begin,complete}` on
   * accounts that already have ≥1 passkey. Without this gate, a stolen
   * access token (XSS) could silently bind an attacker-controlled
   * authenticator to the victim account — every other high-value auth
   * mutation on the branch is step-up gated, and enroll must match.
   */
  const verifyStepUpForPasskeyRegister = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyRegisterAllowedAmr);
    });

  const verifyStepUpForRecoveryGenerate = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, recoveryGenerateAllowedAmr);
    });

  /**
   * Step-up verifier for `DELETE /account` (Flow A — full OSN account
   * erasure). Reuses the recovery-AMR allowlist (passkey OR OTP) — the user
   * may have already nuked their last passkey, in which case OTP-to-email
   * is the only escape; a stricter passkey-only rule would lock out users
   * who legitimately want to delete after losing their authenticator.
   *
   * S-C1: requires the token's `purpose` claim to be `"account_delete"`.
   * Tokens minted for any other ceremony (recovery, passkey, email change)
   * are rejected, defending against confused-deputy reuse.
   */
  const verifyStepUpForAccountDelete = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(
        stepUpToken,
        accountId,
        recoveryGenerateAllowedAmr,
        "account_delete",
      );
    });

  /**
   * Cross-service step-up verifier — called by Pulse / Zap via the
   * ARC-gated `/internal/step-up/verify` endpoint. Requires a matching
   * {@link StepUpPurpose} so a token minted for one app cannot be
   * replayed at another (confused-deputy guard).
   *
   * S-H2: returns the verified accountId from the token's `sub` claim so
   * the calling service can use it server-to-server without requiring
   * the user to supply it in a body field. The accountId is never
   * exposed to the user (P6 invariant) — only to ARC-authenticated
   * downstream services.
   */
  const verifyStepUpForExternalPurpose = (
    stepUpToken: string,
    expectedPurpose: StepUpPurpose,
  ): Effect.Effect<{ accountId: string }, AuthError> =>
    Effect.gen(function* () {
      const result = yield* verifyStepUpToken(
        stepUpToken,
        null,
        recoveryGenerateAllowedAmr,
        expectedPurpose,
      );
      return { accountId: result.accountId };
    });

  return {
    issueStepUpToken,
    verifyStepUpToken,
    beginStepUpPasskey,
    completeStepUpPasskey,
    beginStepUpOtp,
    completeStepUpOtp,
    verifyStepUpForPasskeyDelete,
    verifyStepUpForPasskeyRegister,
    verifyStepUpForRecoveryGenerate,
    verifyStepUpForAccountDelete,
    verifyStepUpForExternalPurpose,
  };
}

export type StepUpModule = ReturnType<typeof createStepUpModule>;
