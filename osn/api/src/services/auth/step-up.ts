/**
 * Step-up (sudo) tokens — M-PK1. Short-lived ES256 JWTs minted by a fresh
 * authentication ceremony (passkey or OTP to the account's verified email)
 * and required by the most sensitive endpoints. Signed with the same ES256
 * key as access tokens but with a distinct audience claim (`osn-step-up`)
 * so they cannot be cross-used. Replay-guarded via single-use `jti`s in the
 * injected {@link StepUpJtiStore}.
 */

import { accounts, type NewPasskey, passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
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
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  metricAuthOtpSent,
  metricRecoveryCooldown,
  metricStepUpIssued,
  metricStepUpVerified,
  withStepUp,
} from "../../metrics";
import {
  CHALLENGE_TTL_MS,
  MAX_OTP_ATTEMPTS,
  PASSKEY_LAST_USED_COALESCE_MS,
  RECOVERY_COOLDOWN_MS,
} from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import {
  genOtpCode,
  hashSessionToken,
  logDevOtp,
  signJwt,
  type StepUpTokenClaims,
  verifyJwt,
} from "./helpers";
import type { AssertingCredential, PasskeyProvenance } from "./types";

/**
 * What a gate hands {@link createStepUpModule}'s verifier so it can apply the
 * post-recovery cooldown. The caller does the reads — it already has the rows —
 * and the verifier makes the single decision.
 *
 * Both variants carry `lastRecoveredAt` because the recovery window applies to
 * both, and `passkey_mutation` additionally carries the credential being acted
 * on, because that window's question is "is the target older than the thing
 * asking to remove it".
 */
export type ProvenanceCheck =
  | {
      readonly gate: "passkey_mutation";
      /** The passkey being deleted or renamed. */
      readonly targetId: string;
      /** Unix seconds; null when the target does not exist on this account. */
      readonly targetCreatedAt: number | null;
      readonly lastRecoveredAt: number | null;
    }
  | { readonly gate: "email_change"; readonly lastRecoveredAt: number | null };

/** The provenance facts a verified step-up token carries, already narrowed. */
interface StepUpProvenanceClaims {
  readonly amr: readonly string[];
  readonly passkeyId: string | null;
  readonly provenance: PasskeyProvenance | null;
  readonly createdAt: number | null;
}

const PROVENANCE_VALUES = new Set<string>(["webauthn", "otp", "totp", "recovery"]);

/**
 * The whole cooldown rule, in one pure function so it can be read and tested
 * without a database.
 *
 * Two independent 72-hour windows; either one refuses.
 *
 * **W1, registration provenance.** A passkey registered a minute ago under an
 * emailed code mints an `amr: ["webauthn"]` step-up indistinguishable from one
 * the user has held for a year, so the narrow `passkeyDeleteAllowedAmr` and
 * `emailChangeAllowedAmr` constrain only the direct path: register a credential
 * of your own, assert it, and you hold a token either gate accepts. W1 refuses
 * a credential whose own provenance is weaker than `webauthn`, inside 72 hours
 * of its registration, when it asks to remove something older than itself or to
 * change the account email.
 *
 * **W2, the recovery window.** After any recovery, a step-up minted from the
 * recovery-enrolled credential — or from an emailed OTP, whose "proves control
 * of the current mailbox" property is exactly what a recovery calls into
 * question — may not remove a pre-recovery credential or change the email for
 * 72 hours. A credential that PREDATES the recovery is the owner acting and is
 * refused nothing: that asymmetry is the point, because the attacker always
 * moves first and a symmetric lock would hand them the window.
 *
 * Two guards that look like details and are not:
 *
 * - **A `webauthn` token with no provenance claims is refused.** Only the
 *   signing key can mint one, so it is not an attack path — but a rule that
 *   reads a missing claim as "unrestricted" is one forgotten mint site away
 *   from being no rule at all.
 * - **W1 compares `<=`, not `<`, plus an id guard.** `passkeys.created_at` is
 *   unix seconds, so a credential registered in the same second as its target
 *   would slip a strict comparison. The id guard is what still lets a
 *   credential delete itself, so the account can never be trapped into keeping
 *   the one the recovery enrolled.
 *
 * **W2 compares `<`, and the asymmetry with W1 is deliberate.** The two
 * comparisons are not the same question. W1 asks "is the target at least as
 * old as the credential asking", where a same-second tie means the two are
 * indistinguishable in age and the older must win. W2 asks "does the target
 * predate the recovery", and a credential stamped in the recovery's own second
 * does not. Widening it to `<=` would buy nothing and cost the owner: a target
 * created in the recovery's second is at most a second old when the recovery
 * lands, so W1 already refuses every weak-provenance credential against it,
 * and the only asserter W2's `<=` could newly refuse is a post-recovery
 * credential carrying `webauthn` — which by the inheritance rule means one the
 * owner derived from a passkey they still hold. That is exactly the credential
 * that has to be able to delete what the recovery enrolled.
 */
export function provenanceRefusal(
  claims: StepUpProvenanceClaims,
  check: ProvenanceCheck,
  nowMs: number,
): "passkey_mutation_refused" | "email_change_refused" | null {
  const refusal =
    check.gate === "email_change" ? "email_change_refused" : "passkey_mutation_refused";
  const assertedByPasskey = claims.amr.includes("webauthn");

  // W1 — the credential's own provenance.
  if (assertedByPasskey) {
    if (claims.provenance === null || claims.createdAt === null || claims.passkeyId === null) {
      return refusal;
    }
    const weak = claims.provenance !== "webauthn";
    const inOwnWindow = nowMs - claims.createdAt * 1000 < RECOVERY_COOLDOWN_MS;
    if (weak && inOwnWindow) {
      if (check.gate === "email_change") return refusal;
      if (
        check.targetCreatedAt !== null &&
        check.targetId !== claims.passkeyId &&
        check.targetCreatedAt <= claims.createdAt
      ) {
        return refusal;
      }
    }
  }

  // W2 — the account's recovery window.
  const recoveredAt = check.lastRecoveredAt;
  if (recoveredAt === null) return null;
  if (nowMs - recoveredAt * 1000 >= RECOVERY_COOLDOWN_MS) return null;

  if (check.gate === "email_change") {
    // An emailed OTP is admitted at this gate because it proves control of the
    // CURRENT mailbox. A recovery is precisely the event after which that no
    // longer follows.
    return claims.amr.includes("otp") ? refusal : null;
  }

  // A direct non-passkey factor reaches here only where a deployment has
  // widened `passkeyDeleteAllowedAmr`; the default admits `webauthn` alone.
  // Covered anyway, because a widened allow-list must not silently reopen this.
  const postRecoveryCredential =
    assertedByPasskey && claims.createdAt !== null && claims.createdAt >= recoveredAt;
  if (!assertedByPasskey || postRecoveryCredential) {
    if (
      check.targetCreatedAt !== null &&
      check.targetId !== claims.passkeyId &&
      // Strict, unlike W1's `<=` above, and the docstring says why: a target
      // stamped in the recovery's own second does not predate it, and refusing
      // one would only ever stop the owner's `webauthn`-provenance credential
      // from removing what the recovery enrolled.
      check.targetCreatedAt < recoveredAt
    ) {
      return refusal;
    }
  }
  return null;
}

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
    emailChangeAllowedAmr,
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
  const issueStepUpToken = (
    accountId: string,
    factor: StepUpFactor,
    purpose?: StepUpPurpose,
    /**
     * The credential that was asserted, when the factor was a passkey. Carried
     * into the token so the two gates that apply the cooldown can tell a
     * credential the user has held for a year from one registered a minute ago
     * under an emailed code — `amr: ["webauthn"]` says the same thing for both.
     *
     * Optional so the other two ceremonies, and callers minting for gates that
     * do not apply the rule, are unchanged. A `webauthn` token that omits it is
     * refused where the rule runs rather than admitted.
     */
    asserting?: AssertingCredential,
  ) =>
    Effect.gen(function* () {
      // Map the ceremony factor onto RFC 8176 "amr" values the verifier reads.
      // An exhaustive record rather than a chain of ternaries: the chain's
      // else-arm silently mapped every unlisted factor to "recovery", which no
      // allow-list admits, so adding a factor produced tokens that verified
      // nowhere and failed with the same generic message as a forgery. A
      // missing key here is a compile error instead.
      const AMR_FOR_FACTOR = {
        passkey: "webauthn",
        otp: "otp",
        totp: "totp",
        recovery_code: "recovery",
      } satisfies Record<StepUpFactor, string>;
      const amr = AMR_FOR_FACTOR[factor];
      const token = yield* Effect.tryPromise({
        try: () => {
          const claims: StepUpTokenClaims = {
            sub: accountId,
            aud: STEP_UP_AUDIENCE,
            amr: [amr],
            jti: crypto.randomUUID(),
          };
          if (purpose) claims.purpose = purpose;
          if (asserting) {
            claims.pk_id = asserting.id;
            claims.pk_provenance = asserting.provenance;
            claims.pk_created_at = asserting.createdAt;
          }
          return signJwt(
            claims,
            config.jwtPrivateKey,
            config.jwtKid,
            stepUpTokenTtl,
            config.issuerUrl,
          );
        },
        catch: (cause) => new AuthError({ message: String(cause) }),
      });
      metricStepUpIssued(factor);
      return token;
    });

  /**
   * Verifies a step-up token and returns the amr + purpose it carries
   * along with the verified accountId (the token's `sub` claim). Pass
   * `expectedAccountId` to enforce a sub equality check (most callers do);
   * pass `null` to accept any account — used by cross-service verifiers
   * like `/internal/step-up/verify` where the calling service derives the
   * accountId from the token's verified sub rather than asserting one
   * up front. Fails with an AuthError on any signature / audience / expiry
   * / replay issue; the error message is intentionally generic so the wire
   * doesn't leak whether it was a wrong sub or a replayed jti.
   */
  const verifyStepUpToken = (
    token: string,
    expectedAccountId: string | null,
    allowedAmr: ReadonlySet<string>,
    expectedPurpose?: StepUpPurpose,
    /**
     * The post-recovery cooldown, when the calling gate applies it. Evaluated
     * AFTER the audience / subject / amr / purpose checks and BEFORE the jti is
     * consumed, which is deliberate on both counts: a refusal must not spend
     * the user's single-use token on an action they will now have to take a
     * different way, and exactly one outcome must reach the counter — running
     * it outside this function recorded `ok` and `provenance_blocked` for the
     * same verification.
     */
    provenance?: ProvenanceCheck,
  ): Effect.Effect<
    {
      amr: string[];
      purpose: StepUpPurpose | null;
      accountId: string;
      /** `pk_provenance`, narrowed; null when the token carries none. */
      assertingProvenance: PasskeyProvenance | null;
      /** `pk_created_at` in unix seconds; null when the token carries none. */
      assertingCreatedAt: number | null;
    },
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

      const provenanceClaim = payloadResult["pk_provenance"];
      const createdAtClaim = payloadResult["pk_created_at"];
      const passkeyIdClaim = payloadResult["pk_id"];
      const assertingProvenance: PasskeyProvenance | null =
        typeof provenanceClaim === "string" && PROVENANCE_VALUES.has(provenanceClaim)
          ? (provenanceClaim as PasskeyProvenance)
          : null;
      const assertingCreatedAt = typeof createdAtClaim === "number" ? createdAtClaim : null;

      // The post-recovery cooldown, before the jti is spent. See the parameter
      // docstring: a refusal here leaves the token unconsumed on purpose.
      if (provenance) {
        const refusal = provenanceRefusal(
          {
            amr,
            passkeyId: typeof passkeyIdClaim === "string" ? passkeyIdClaim : null,
            provenance: assertingProvenance,
            createdAt: assertingCreatedAt,
          },
          provenance,
          Date.now(),
        );
        if (refusal) {
          yield* record("provenance_blocked");
          metricRecoveryCooldown(refusal);
          return yield* Effect.fail(
            new AuthError({
              message:
                "This credential is too new to make that change. Use a passkey you already had, or try again once the security hold ends.",
            }),
          );
        }
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
      return { amr, purpose: tokenPurpose, accountId, assertingProvenance, assertingCreatedAt };
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
      const updates: Partial<Pick<NewPasskey, "counter" | "lastUsedAt" | "updatedAt">> = {
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

      // Carry the asserted credential's provenance into the token. `webauthn`
      // in the AMR says a ceremony happened; this says whose credential ran it,
      // which is the difference the cooldown turns on. A NULL column is a row
      // that predates the column and reads as `webauthn`.
      const stepUpToken = yield* issueStepUpToken(accountId, "passkey", purpose, {
        id: pk.id,
        provenance:
          pk.provenanceAmr && PROVENANCE_VALUES.has(pk.provenanceAmr)
            ? (pk.provenanceAmr as PasskeyProvenance)
            : "webauthn",
        createdAt: Math.floor(pk.createdAt.getTime() / 1000),
      });
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
      yield* logDevOtp("step-up", code);
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
   * Read the two facts the cooldown needs about a passkey mutation: when the
   * target credential was created, and when this account was last recovered.
   *
   * One `Effect.all`, so the gate costs one round trip rather than two. A
   * target that does not exist on this account comes back `null` and the rule
   * simply does not fire — `deletePasskey` and `renamePasskey` own the
   * not-found answer, and duplicating it here would leak which of the two
   * refusals applied.
   */
  const readMutationFacts = (
    accountId: string,
    targetPasskeyId: string,
  ): Effect.Effect<
    { targetCreatedAt: number | null; lastRecoveredAt: number | null },
    DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [targetRows, accountRows] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () =>
              db
                .select({ createdAt: passkeys.createdAt })
                .from(passkeys)
                .where(and(eq(passkeys.id, targetPasskeyId), eq(passkeys.accountId, accountId)))
                .limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () =>
              db
                .select({ lastRecoveredAt: accounts.lastRecoveredAt })
                .from(accounts)
                .where(eq(accounts.id, accountId))
                .limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );
      const target = targetRows[0];
      return {
        targetCreatedAt: target ? Math.floor(target.createdAt.getTime() / 1000) : null,
        lastRecoveredAt: accountRows[0]?.lastRecoveredAt ?? null,
      };
    });

  /**
   * S-L4: separate step-up verifier for `DELETE /passkeys/:id` and
   * `PATCH /passkeys/:id`. Defaults to passkey-only AMR — the caller
   * necessarily has a passkey (the last-passkey lockout guard fires
   * otherwise), so requiring one for deletion is the strongest available
   * signal at no UX cost.
   *
   * Takes the credential being acted on, because the AMR alone cannot answer
   * the question the cooldown asks: a passkey registered a minute ago under an
   * emailed code mints the same `webauthn` AMR as one the user has held for a
   * year, and the difference only matters relative to the credential it wants
   * to remove.
   *
   * Rename shares it deliberately. A credential the rule would stop deleting an
   * older one can otherwise relabel it — which is how a user is talked into
   * confirming a delete on the wrong row — and renaming the NEW credential is
   * never blocked, because it does not predate itself.
   */
  const verifyStepUpForPasskeyDelete = (
    accountId: string,
    stepUpToken: string,
    targetPasskeyId: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const facts = yield* readMutationFacts(accountId, targetPasskeyId);
      // Purpose-bound (confused-deputy guard): a token minted for a different
      // ceremony (recovery generate, email change) cannot be replayed here.
      // Rename shares this verifier, so the client mints `passkey_delete` for
      // both rename and delete.
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyDeleteAllowedAmr, "passkey_delete", {
        gate: "passkey_mutation",
        targetId: targetPasskeyId,
        targetCreatedAt: facts.targetCreatedAt,
        lastRecoveredAt: facts.lastRecoveredAt,
      });
    });

  /**
   * Step-up verifier for `POST /account/email/complete`.
   *
   * `emailChangeAllowedAmr` admits `webauthn` and `otp` and no deployment may
   * widen it — the `otp` arm is there because an emailed code proves control of
   * the CURRENT mailbox. Both of the ways that reasoning fails are handled
   * here rather than in the allow-list, because neither is about the factor:
   *
   * - a passkey registered under a weaker AMR minutes ago mints `webauthn`, so
   *   the register-then-assert pivot reaches this gate without touching the
   *   list;
   * - after a recovery the current mailbox may be the attacker's, so the `otp`
   *   arm's premise is exactly what the recovery called into question.
   *
   * Email change is the pivot to a permanent, mailbox-independent takeover, so
   * this gate is the one the whole cooldown exists to hold.
   */
  const verifyStepUpForEmailChange = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ lastRecoveredAt: accounts.lastRecoveredAt })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      yield* verifyStepUpToken(stepUpToken, accountId, emailChangeAllowedAmr, "email_change", {
        gate: "email_change",
        lastRecoveredAt: rows[0]?.lastRecoveredAt ?? null,
      });
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
  ): Effect.Effect<PasskeyProvenance, AuthError> =>
    Effect.gen(function* () {
      // Purpose-bound: only a token minted for passkey enrolment is accepted,
      // so a recovery-generate or email-change token can't bind an attacker
      // authenticator via a replay.
      const result = yield* verifyStepUpToken(
        stepUpToken,
        accountId,
        passkeyRegisterAllowedAmr,
        "passkey_register",
      );

      // What the new credential inherits. `webauthn` in the AMR means a passkey
      // was asserted, and the credential being registered is then only as
      // strong as the one that authorised it — otherwise the two-hop pivot
      // becomes a three-hop pivot and nothing is closed.
      //
      // The inheritance is EFFECTIVE, not raw: once the asserting credential is
      // past its own window it may perform these deletions itself, so a child
      // it authorises cannot be made safer by restricting it. Raw inheritance
      // would restrict every device in a lineage for the life of the account —
      // and `config.ts` records that the common reason a user adds a device by
      // OTP is that the first one is hard to reach.
      if (result.amr.includes("webauthn")) {
        const claim = result.assertingProvenance;
        const createdAt = result.assertingCreatedAt;
        if (claim === null || createdAt === null) return "recovery";
        const pastOwnWindow = Date.now() - createdAt * 1000 >= RECOVERY_COOLDOWN_MS;
        return pastOwnWindow ? "webauthn" : claim;
      }
      if (result.amr.includes("otp")) return "otp";
      if (result.amr.includes("totp")) return "totp";
      // An AMR the allow-list admitted but this map does not name. Fail closed:
      // the most restrictive provenance, never the least.
      return "recovery";
    });

  /**
   * Step-up verifier for `POST /totp/enroll/begin`.
   *
   * Gated for the reason `/passkey/register/begin` is, and on the same
   * allow-list: without it a stolen access token silently binds an attacker's
   * authenticator seed to the victim's account, and every later gate that
   * accepts a `totp` AMR would then accept the attacker.
   *
   * Purpose-bound, so a token minted to add a passkey cannot enrol a second
   * factor instead.
   */
  const verifyStepUpForTotpEnroll = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyRegisterAllowedAmr, "totp_enroll");
    });

  /**
   * Step-up verifier for `DELETE /totp`.
   *
   * A `totp` AMR is admitted here, which is deliberate: the holder of the seed
   * can already mint codes, so removing the credential is a downgrade rather
   * than an escalation, it writes a `totp_disabled` security event and sends a
   * notice, and demanding `webauthn` would strand a user whose passkey device
   * is gone with a second factor they cannot remove.
   */
  const verifyStepUpForTotpDisable = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyRegisterAllowedAmr, "totp_disable");
    });

  /**
   * Step-up verifier for `POST /recovery/generate`.
   *
   * S-M1: requires the token's `purpose` claim to be `"recovery_generate"`.
   * Generating burns the account's whole existing set, so a token minted for
   * any other ceremony — an email change, a passkey delete — must not be
   * replayable here.
   */
  const verifyStepUpForRecoveryGenerate = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(
        stepUpToken,
        accountId,
        recoveryGenerateAllowedAmr,
        "recovery_generate",
      );
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
   * Step-up verifier for `GET /account/export` (C-H1 — DSAR Art. 15 / 20
   * data export). Reuses the recovery-AMR allowlist (passkey OR OTP), same
   * rationale as account-delete: exporting is a sensitive read that must
   * survive the user having lost their last passkey.
   *
   * Requires the token's `purpose` claim to be `"account_export"` so a token
   * minted for delete (or any other ceremony) cannot be replayed to export.
   */
  const verifyStepUpForAccountExport = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(
        stepUpToken,
        accountId,
        recoveryGenerateAllowedAmr,
        "account_export",
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
    verifyStepUpForEmailChange,
    verifyStepUpForPasskeyRegister,
    verifyStepUpForTotpEnroll,
    verifyStepUpForTotpDisable,
    verifyStepUpForRecoveryGenerate,
    verifyStepUpForAccountDelete,
    verifyStepUpForAccountExport,
    verifyStepUpForExternalPurpose,
  };
}

export type StepUpModule = ReturnType<typeof createStepUpModule>;
