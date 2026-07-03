/**
 * Email change (step-up gated): OTP to the NEW address, 2-per-7-days hard
 * cap, atomic swap + audit row + other-session revocation.
 */

import { accounts, emailChanges, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch } from "@shared/db-utils";
import { type EmailError, EmailService } from "@shared/email";
import { and, count as countFn, eq, gte, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { timingSafeEqualString } from "../../lib/timing-safe";
import {
  metricAuthOtpSent,
  metricSessionSecurityInvalidation,
  withEmailChange,
} from "../../metrics";
import { MAX_OTP_ATTEMPTS } from "./constants";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError, ValidationError } from "./errors";
import { EmailSchema, genId, genOtpCode, hashSessionToken, logDevOtp } from "./helpers";
import type { StepUpModule } from "./step-up";

export function createEmailChangeModule(ctx: AuthContext, stepUp: StepUpModule) {
  const { stores, otpTtl, emailChangeBeginCap } = ctx;
  const { verifyStepUpToken } = stepUp;

  const EMAIL_CHANGE_LIMIT = 2;
  const EMAIL_CHANGE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

  const beginEmailChange = (
    accountId: string,
    newEmail: string,
  ): Effect.Effect<
    { sent: boolean },
    AuthError | ValidationError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(EmailSchema)(newEmail).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      const normalised = newEmail.toLowerCase();
      const { db } = yield* Db;

      // S-H3: per-account cap beneath the per-IP rate limit. An attacker
      // with a stolen access token behind a rotating-IP proxy can't pool
      // their allowance to spam the OSN sending domain at arbitrary inboxes.
      // O3: routed through the rate-limiter family (shared across pods); the
      // limiter owns the window + opportunistic eviction.
      const emailChangeAllowed = yield* Effect.promise(() => emailChangeBeginCap.check(accountId));
      if (!emailChangeAllowed) {
        return yield* Effect.fail(new AuthError({ message: "Too many email change attempts" }));
      }

      const currentAccount = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = currentAccount[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      if (account.email === normalised) {
        return yield* Effect.fail(new AuthError({ message: "New email matches current email" }));
      }

      // S-H2: silently succeed on collisions — an authenticated caller
      // must not learn whether another account owns an email. Registration
      // treats this as first-class (see the `beginRegistration` comment);
      // email change must match. The UNIQUE(email) constraint at `complete`
      // is the real defence against a race-winning swap.
      const collision = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.email, normalised)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (collision.length > 0) {
        return { sent: true };
      }

      // P-W3: 2-per-7-days cap uses an indexed aggregate instead of a full
      // history fetch. `email_changes_completed_at_idx` + the account filter
      // serve the predicate.
      const windowStart = Math.floor(Date.now() / 1000) - EMAIL_CHANGE_WINDOW_SECONDS;
      const recentCount = yield* Effect.tryPromise({
        try: async () => {
          const [row] = await db
            .select({ count: countFn() })
            .from(emailChanges)
            .where(
              and(
                eq(emailChanges.accountId, accountId),
                gte(emailChanges.completedAt, windowStart),
              ),
            );
          return Number(row?.count ?? 0);
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (recentCount >= EMAIL_CHANGE_LIMIT) {
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }

      const code = genOtpCode();
      yield* Effect.promise(() =>
        stores.pendingEmailChanges.set(
          accountId,
          {
            newEmail: normalised,
            codeHash: hashSessionToken(code),
            attempts: 0,
            expiresAt: Date.now() + otpTtl * 1000,
          },
          otpTtl * 1000,
        ),
      );

      yield* logDevOtp("email-change", normalised, code);

      // S-L5 framing lives in the template itself
      // (shared/email/src/templates/otp.ts → renderEmailChangeOtp).
      const email = yield* EmailService;
      yield* email
        .send({
          template: "otp-email-change",
          to: normalised,
          data: { code, ttlMinutes: otpTtl / 60 },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) =>
              new AuthError({ message: `Failed to send email: ${cause.reason}` }),
          ),
        );

      metricAuthOtpSent("email_change");
      return { sent: true };
    }).pipe(withEmailChange("begin"));

  /**
   * Finalises an email change. Requires:
   *   - A valid step-up token (passkey or OTP amr) for this account.
   *   - A valid OTP sent to the **new** email address.
   *   - < 2 completed changes in the last 7 days.
   *
   * On success: the accounts row is updated, every OTHER session is
   * revoked (the caller's stays so they don't get kicked out of the
   * Settings flow), and an audit row is inserted — all in one transaction
   * so we cannot leave the system in a half-changed state.
   */
  const completeEmailChange = (
    accountId: string,
    code: string,
    stepUpToken: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ email: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, new Set(["webauthn", "otp"]));

      const pending = yield* Effect.promise(() => stores.pendingEmailChanges.get(accountId));
      if (!pending || Date.now() > pending.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!timingSafeEqualString(pending.codeHash, hashSessionToken(code))) {
        // O3: persist the attempt bump + carry remaining TTL (store doesn't alias).
        const attempts = pending.attempts + 1;
        if (attempts >= MAX_OTP_ATTEMPTS) {
          yield* Effect.promise(() => stores.pendingEmailChanges.delete(accountId));
        } else {
          yield* Effect.promise(() =>
            stores.pendingEmailChanges.set(
              accountId,
              { ...pending, attempts },
              Math.max(0, pending.expiresAt - Date.now()),
            ),
          );
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const windowStart = nowSec - EMAIL_CHANGE_WINDOW_SECONDS;

      // P-W3 + P-I4: rate check + current-account fetch move OUT of the
      // transaction so the write section holds the writer lock as briefly
      // as possible. Race-safety is preserved by the UNIQUE(email)
      // constraint catching concurrent winners at `tx.update`.
      const preflight = yield* Effect.tryPromise({
        try: async () => {
          const [acct] = await db
            .select()
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1);
          if (!acct) return { ok: false as const, reason: "not_found" as const };
          const [row] = await db
            .select({ count: countFn() })
            .from(emailChanges)
            .where(
              and(
                eq(emailChanges.accountId, accountId),
                gte(emailChanges.completedAt, windowStart),
              ),
            );
          if (Number(row?.count ?? 0) >= EMAIL_CHANGE_LIMIT) {
            return { ok: false as const, reason: "rate_limit" as const };
          }
          return { ok: true as const, current: acct };
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (!preflight.ok) {
        if (preflight.reason === "not_found") {
          return yield* Effect.fail(new AuthError({ message: "Account not found" }));
        }
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }
      const currentAccountRow = preflight.current;

      const changed = yield* Effect.tryPromise({
        try: async () => {
          try {
            // Atomic batch on D1, sequential on bun:sqlite. A half-applied
            // change would leave a potentially-compromised session alive with a
            // stale email claim, so the email swap + audit row + session wipe
            // commit together.
            await commitBatch(db, [
              db
                .update(accounts)
                .set({ email: pending.newEmail, updatedAt: new Date(nowSec * 1000) })
                .where(eq(accounts.id, accountId)),

              db.insert(emailChanges).values({
                id: genId("ech_"),
                accountId,
                previousEmail: currentAccountRow.email,
                newEmail: pending.newEmail,
                completedAt: nowSec,
              }),

              currentSessionHash !== null
                ? db
                    .delete(sessions)
                    .where(
                      and(eq(sessions.accountId, accountId), ne(sessions.id, currentSessionHash)),
                    )
                : db.delete(sessions).where(eq(sessions.accountId, accountId)),
            ]);

            return { ok: true as const, email: pending.newEmail };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/UNIQUE|constraint/i.test(msg)) {
              return { ok: false as const, reason: "conflict" as const };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!changed.ok) {
        // Only "conflict" can come out of the narrowed TX (preflight
        // already rejected not_found / rate_limit). Map to a generic
        // error that matches the begin-path enumeration posture.
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      yield* Effect.promise(() => stores.pendingEmailChanges.delete(accountId));
      metricSessionSecurityInvalidation("email_change");
      return { email: changed.email };
    }).pipe(withEmailChange("complete"));

  return {
    beginEmailChange,
    completeEmailChange,
  };
}

export type EmailChangeModule = ReturnType<typeof createEmailChangeModule>;
