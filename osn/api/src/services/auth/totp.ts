/**
 * TOTP (RFC 6238) — enrolment, verification and removal.
 *
 * A second factor that depends on neither the account's mailbox nor its passkey
 * device, and works offline. In this phase it is a step-up factor only; it is
 * never a login factor, and [[passkey-primary]]'s "passkeys are the only
 * primary factor" rule is untouched.
 *
 * Three properties carry the security of this module, and each is enforced in
 * one place rather than at every call site:
 *
 * - **The secret is never stored in the clear.** `lib/totp-secret-crypto.ts`
 *   owns encryption; the raw bytes exist only as a local inside a verify.
 * - **Every accepted code is single use** (RFC 6238 §5.2), enforced by the
 *   conditional UPDATE in `consumeStep` rather than by a read-then-write.
 * - **Every failure looks the same on the wire.** Wrong code, replayed code, no
 *   credential and locked-out all answer one message and cost roughly one
 *   verification, so the route is not an oracle for whether an account has a
 *   second factor.
 *
 * See `[[wiki/systems/totp]]`.
 */

import { accounts, securityEvents, totpCredentials } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { base32Encode, generateTotpSecret, totpUri, verifyTotpCode } from "@shared/crypto/totp";
import { commitBatch, rowsChanged } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import type { StepUpPurpose, TotpVerifyResult } from "@shared/observability/metrics";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import { forkBackground } from "../../lib/background";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  fromJsonSafe,
  toJsonSafe,
} from "../../lib/totp-secret-crypto";
import {
  metricSecurityEventRecorded,
  metricTotpLockout,
  metricTotpVerified,
  withTotpOp,
} from "../../metrics";
import { TOTP_ENROLL_TTL_MS, TOTP_LOCKOUT_THRESHOLD, TOTP_MAX_ENROLL_ATTEMPTS } from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genId } from "./helpers";
import type { SecurityEventsModule } from "./security-events";
import type { StepUpModule } from "./step-up";
import type { SessionMeta } from "./types";

/**
 * The one message every failing code check answers with. A caller learns that
 * the attempt failed and nothing else — not whether the account has a
 * credential, not whether the code was right but already spent.
 */
const GENERIC_CODE_FAILURE = "Invalid or expired code";

export interface TotpStatus {
  enrolled: boolean;
  label: string | null;
  lastUsedAt: number | null;
  createdAt: number | null;
}

export function createTotpModule(
  ctx: AuthContext,
  securityEventsModule: SecurityEventsModule,
  stepUp: StepUpModule,
) {
  const { config, stores, hashIp, totpLockoutStore } = ctx;
  const { issueStepUpToken, verifyStepUpForTotpEnroll, verifyStepUpForTotpDisable } = stepUp;

  /**
   * The encryption key, or a failure. Every path that touches a secret goes
   * through here, so "no key configured" can only ever mean the feature is
   * unavailable — there is no branch anywhere that falls back to storing or
   * comparing a plaintext secret.
   */
  const encryptionKey = (): Effect.Effect<CryptoKey, AuthError> =>
    config.totpEncryptionKey
      ? Effect.succeed(config.totpEncryptionKey)
      : Effect.fail(new AuthError({ message: "TOTP is not configured" }));

  const confirmedCredential = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(totpCredentials)
            .where(
              and(eq(totpCredentials.accountId, accountId), isNotNull(totpCredentials.confirmedAt)),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows[0] ?? null;
    });

  /**
   * Claim `step` for a credential, or report that it is already spent.
   *
   * One conditional UPDATE, deliberately: a SELECT-then-UPDATE would let two
   * concurrent submissions of the same code both read a lower stored step and
   * both proceed, which is exactly the replay §5.2 forbids. SQLite and D1 both
   * apply a single statement atomically, so the loser of the race changes zero
   * rows and is rejected. It is NOT run inside `commitBatch`, which returns
   * `void` and would leave nothing to count.
   */
  const consumeStep = (credentialId: string, step: number, nowSec: number) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .update(totpCredentials)
            .set({ lastUsedStep: step, lastUsedAt: nowSec })
            .where(
              and(
                eq(totpCredentials.id, credentialId),
                isNotNull(totpCredentials.confirmedAt),
                sql`(${totpCredentials.lastUsedStep} is null or ${totpCredentials.lastUsedStep} < ${step})`,
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rowsChanged(result) > 0;
    });

  const rejectCode = (accountId: string, result: TotpVerifyResult) =>
    Effect.gen(function* () {
      const failures = yield* Effect.promise(() => totpLockoutStore.recordFailure(accountId));
      // "locked" on the attempt that crosses the threshold, so the dashboard
      // separates a fat-fingered code from an account under a grinding attack.
      metricTotpLockout(failures >= TOTP_LOCKOUT_THRESHOLD ? "locked" : "recorded");
      metricTotpVerified(result);
      return yield* Effect.fail(new AuthError({ message: GENERIC_CODE_FAILURE }));
    });

  /**
   * Verify `code` against the account's confirmed credential and consume the
   * step it matched. The single entry point for every TOTP check — step-up
   * today, recovery when that phase lands — so the lockout, the constant-cost
   * "not enrolled" branch and single-use consumption cannot be forgotten by a
   * new caller.
   */
  const checkTotpCode = (
    accountId: string,
    code: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const key = yield* encryptionKey();

      // Fail-closed: an unreachable lockout counter for TOTP means no throttle
      // at all behind a six-digit code, so an error here denies. See the
      // posture note in `lib/recovery-lockout-store.ts`.
      const locked = yield* Effect.promise(() => totpLockoutStore.isLocked(accountId));
      if (locked) {
        metricTotpLockout("locked");
        metricTotpVerified("locked_out");
        return yield* Effect.fail(new AuthError({ message: GENERIC_CODE_FAILURE }));
      }

      const credential = yield* confirmedCredential(accountId);

      // An absent credential still pays for a verification. `verifyTotpCode`
      // runs an empty secret against its dummy key, deriving and comparing the
      // same number of candidates, so "no TOTP on this account" does not answer
      // faster than "wrong code" to anyone who can reach the route.
      const secret = credential
        ? yield* Effect.tryPromise({
            try: () => decryptTotpSecret(key, accountId, credential),
            catch: (cause) => new DatabaseError({ cause }),
          })
        : new Uint8Array(0);

      const matched = yield* Effect.promise(() => verifyTotpCode({ secret, code }));
      if (!matched || !credential) {
        return yield* rejectCode(accountId, credential ? "invalid" : "not_enrolled");
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const claimed = yield* consumeStep(credential.id, matched.step, nowSec);
      if (!claimed) {
        // The code was arithmetically correct and already spent — a replay, and
        // the one rejection worth distinguishing on a dashboard.
        return yield* rejectCode(accountId, "replayed");
      }

      yield* Effect.promise(() => totpLockoutStore.reset(accountId));
      metricTotpLockout("reset");
      metricTotpVerified("ok");
    });

  /**
   * `POST /totp/enroll/begin` — mint a secret and park it, unconfirmed.
   *
   * Step-up gated: without it a stolen access token silently binds an
   * attacker's authenticator, and every gate that accepts a `totp` AMR would
   * then accept the attacker. The secret does not reach D1 until a code proves
   * the user actually holds it.
   */
  const beginTotpEnrollment = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<{ otpauthUri: string; totpSecret: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpForTotpEnroll(accountId, stepUpToken);
      const key = yield* encryptionKey();

      const existing = yield* confirmedCredential(accountId);
      if (existing) {
        return yield* Effect.fail(
          new AuthError({ message: "An authenticator app is already set up on this account" }),
        );
      }

      const { db } = yield* Db;
      const accountRows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = accountRows[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }

      const secret = generateTotpSecret();
      const encrypted = yield* Effect.tryPromise({
        try: () => encryptTotpSecret(key, accountId, secret),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.promise(() =>
        stores.pendingTotpEnrollments.set(
          accountId,
          { ...toJsonSafe(encrypted), attempts: 0, expiresAt: Date.now() + TOTP_ENROLL_TTL_MS },
          TOTP_ENROLL_TTL_MS,
        ),
      );

      // The only response in the service that carries secret material. The
      // field names match the logger deny-list entries (`totpSecret`,
      // `otpauthUri`) — renaming either silently un-redacts it.
      return {
        otpauthUri: totpUri({ secret, accountName: account.email, issuer: config.rpName }),
        totpSecret: base32Encode(secret),
      };
    }).pipe(withTotpOp("enroll_begin"));

  /**
   * `POST /totp/enroll/complete` — prove possession, then persist.
   *
   * Not step-up gated: `begin` was, and the pending secret is the proof that a
   * gated `begin` happened. The row is written with the step this code matched
   * already consumed — the enrolment code is a real code, and leaving
   * `lastUsedStep` null would keep the digits the user just typed into a form
   * replayable at `/step-up/totp/complete` for the rest of their window.
   */
  const completeTotpEnrollment = (
    accountId: string,
    code: string,
    label: string | null,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ enrolled: true }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const key = yield* encryptionKey();

      const pending = yield* Effect.promise(() => stores.pendingTotpEnrollments.get(accountId));
      if (!pending || Date.now() > pending.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: GENERIC_CODE_FAILURE }));
      }

      const existing = yield* confirmedCredential(accountId);
      if (existing) {
        return yield* Effect.fail(
          new AuthError({ message: "An authenticator app is already set up on this account" }),
        );
      }

      const secret = yield* Effect.tryPromise({
        try: () => decryptTotpSecret(key, accountId, fromJsonSafe(pending)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const matched = yield* Effect.promise(() => verifyTotpCode({ secret, code }));
      if (!matched) {
        const attempts = pending.attempts + 1;
        if (attempts >= TOTP_MAX_ENROLL_ATTEMPTS) {
          yield* Effect.promise(() => stores.pendingTotpEnrollments.delete(accountId));
        } else {
          yield* Effect.promise(() =>
            stores.pendingTotpEnrollments.set(
              accountId,
              { ...pending, attempts },
              Math.max(0, pending.expiresAt - Date.now()),
            ),
          );
        }
        metricTotpVerified("invalid");
        return yield* Effect.fail(new AuthError({ message: GENERIC_CODE_FAILURE }));
      }

      yield* Effect.promise(() => stores.pendingTotpEnrollments.delete(accountId));

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const stored = fromJsonSafe(pending);
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db.insert(totpCredentials).values({
              id: genId("totp_"),
              accountId,
              secretCiphertext: Buffer.from(stored.secretCiphertext),
              iv: Buffer.from(stored.iv),
              keyVersion: stored.keyVersion,
              label,
              confirmedAt: nowSec,
              lastUsedAt: nowSec,
              // The enrolment code is spent. See the docstring.
              lastUsedStep: matched.step,
              createdAt: nowSec,
            }),
            db.insert(securityEvents).values({
              id: genId("sev_"),
              accountId,
              kind: "totp_enrolled",
              createdAt: nowSec,
              acknowledgedAt: null,
              ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
              uaLabel: eventMeta?.uaLabel ?? null,
            }),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricSecurityEventRecorded("totp_enrolled");
      metricTotpVerified("ok");

      yield* forkBackground(
        securityEventsModule
          .notifySecurityEventByAccountId(accountId, "totp_enrolled", "totp-enrolled")
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.void),
          ),
      );

      return { enrolled: true as const };
    }).pipe(withTotpOp("enroll_complete"));

  /** `DELETE /totp` — remove the credential, audibly. Step-up gated. */
  const disableTotp = (
    accountId: string,
    stepUpToken: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ disabled: boolean }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      yield* verifyStepUpForTotpDisable(accountId, stepUpToken);

      const credential = yield* confirmedCredential(accountId);
      if (!credential) {
        // Idempotent, like /logout and DELETE /sessions/:id: nothing to remove
        // is not an error, and the caller already proved who they are.
        return { disabled: false };
      }

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db.delete(totpCredentials).where(eq(totpCredentials.id, credential.id)),
            db.insert(securityEvents).values({
              id: genId("sev_"),
              accountId,
              kind: "totp_disabled",
              createdAt: nowSec,
              acknowledgedAt: null,
              ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
              uaLabel: eventMeta?.uaLabel ?? null,
            }),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricSecurityEventRecorded("totp_disabled");

      // The pending entry too: an in-flight enrolment must not survive a
      // disable and let a half-finished ceremony re-create the credential.
      yield* Effect.promise(() => stores.pendingTotpEnrollments.delete(accountId));

      yield* forkBackground(
        securityEventsModule
          .notifySecurityEventByAccountId(accountId, "totp_disabled", "totp-disabled")
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catch(() => Effect.void),
          ),
      );

      return { disabled: true };
    }).pipe(withTotpOp("disable"));

  /**
   * `GET /totp/status` — whether the account has a confirmed credential.
   *
   * Explicit projection, no step and no ciphertext: this is a Settings read,
   * and the only thing it may reveal is what the account holder already knows.
   */
  const getTotpStatus = (
    accountId: string,
  ): Effect.Effect<TotpStatus, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const credential = yield* confirmedCredential(accountId);
      return {
        enrolled: credential !== null,
        label: credential?.label ?? null,
        lastUsedAt: credential?.lastUsedAt ?? null,
        createdAt: credential?.createdAt ?? null,
      };
    }).pipe(withTotpOp("status"));

  /**
   * `POST /step-up/totp/complete` — exchange a code for a step-up token.
   *
   * There is no matching `begin`: TOTP is challenge-free, so there is nothing
   * to mint or park, and whether the account can use this route is what
   * `GET /totp/status` answers.
   */
  const completeStepUpTotp = (
    accountId: string,
    code: string,
    purpose?: StepUpPurpose,
  ): Effect.Effect<{ stepUpToken: string; expiresIn: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* checkTotpCode(accountId, code);
      const stepUpToken = yield* issueStepUpToken(accountId, "totp", purpose);
      return { stepUpToken, expiresIn: ctx.stepUpTokenTtl };
    }).pipe(withTotpOp("verify"));

  return {
    beginTotpEnrollment,
    completeTotpEnrollment,
    disableTotp,
    getTotpStatus,
    completeStepUpTotp,
  };
}

export type TotpModule = ReturnType<typeof createTotpModule>;
