/**
 * Email change (step-up gated): OTP to the NEW address, 2-per-7-days hard
 * cap, atomic swap + audit row + other-session revocation.
 */

import { accounts, emailChanges, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import { driverErrorText, rowsChanged } from "@shared/db-utils";
import { type EmailError, EmailService } from "@shared/email";
import { and, count as countFn, eq, exists, gte, lt, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { canBatch } from "../../lib/batch";
import { bound } from "../../lib/bound";
import { UNIQUE_CONSTRAINT_ERROR } from "../../lib/unique-constraint";
import {
  metricAuthOtpSent,
  metricSessionSecurityInvalidation,
  withEmailChange,
} from "../../metrics";
import { claimEntry, guessEntry } from "./attempts";
import { MAX_OTP_ATTEMPTS } from "./constants";
import type { AuthContext } from "./context";
import { AuthError, type CoordinationError, DatabaseError, ValidationError } from "./errors";
import { EmailSchema, genId, genOtpCode, hashSessionToken, logDevOtp } from "./helpers";
import { outsideFamilyOf } from "./sessions";
import type { StepUpModule } from "./step-up";
import { storeCall } from "./store-call";
import type { PendingEmailChange } from "./stores";

export function createEmailChangeModule(ctx: AuthContext, stepUp: StepUpModule) {
  const { config, stores, otpTtl, emailChangeBeginCap } = ctx;
  const { verifyStepUpForEmailChange } = stepUp;

  const EMAIL_CHANGE_LIMIT = 2;
  const EMAIL_CHANGE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

  /**
   * Drop the pending change `entry` — the one this request's guess read — when
   * the guess that reached the cap was wrong. Only that entry goes: `begin`
   * overwrites the entry at the account's key, so a change begun since keeps
   * its own. The store is a network hop in production, and a blip there must
   * not replace the refusal the caller has earned, nor the outcome bucket it
   * was meant to record. The entry carries a TTL, so losing the delete costs
   * nothing but the wait.
   */
  const dropPending = (accountId: string, entry: PendingEmailChange) =>
    Effect.tryPromise(() => stores.pendingEmailChanges.delete(accountId, entry)).pipe(
      Effect.ignore,
    );

  const beginEmailChange = (
    accountId: string,
    newEmail: string,
  ): Effect.Effect<
    { sent: boolean },
    AuthError | ValidationError | DatabaseError | CoordinationError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(EmailSchema)(newEmail).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      const normalised = newEmail.toLowerCase();
      const { db } = yield* Db;

      // Per-account cap beneath the per-IP rate limit. An attacker
      // with a stolen access token behind a rotating-IP proxy can't pool
      // their allowance to spam the OSN sending domain at arbitrary inboxes.
      // Routed through the rate-limiter family (shared across pods); the
      // limiter owns the window + opportunistic eviction.
      const emailChangeAllowed = yield* Effect.promise(() => emailChangeBeginCap.check(accountId));
      if (!emailChangeAllowed) {
        return yield* Effect.fail(new AuthError({ message: "Too many email change attempts" }));
      }

      const currentAccount = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ email: accounts.email })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = currentAccount[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      if (account.email === normalised) {
        return yield* Effect.fail(new AuthError({ message: "New email matches current email" }));
      }

      // The 2-per-7-days cap uses an indexed aggregate instead of a full
      // history fetch. `email_changes_account_completed_at_idx` serves the
      // predicate (accountId + completedAt range) in one scan. This runs
      // BEFORE the collision probe below: a capped caller must not be
      // able to tell a taken address from a free one by watching which check
      // fails first.
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

      // Silently succeed on collisions — an authenticated caller
      // must not learn whether another account owns an email. Registration
      // treats this as first-class (see the `beginRegistration` comment);
      // email change must match. The UNIQUE(email) constraint at `complete`
      // is the real defence against a race-winning swap.
      const collision = yield* Effect.tryPromise({
        // Projecting the indexed column alone lets UNIQUE(email) answer
        // the probe from the index without reading the account row.
        try: () =>
          db
            .select({ email: accounts.email })
            .from(accounts)
            .where(eq(accounts.email, normalised))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (collision.length > 0) {
        return { sent: true };
      }

      const code = genOtpCode();
      yield* storeCall(stores.pendingEmailChanges, "set", () =>
        stores.pendingEmailChanges.set(
          accountId,
          {
            newEmail: normalised,
            codeHash: hashSessionToken(code),
            expiresAt: Date.now() + otpTtl * 1000,
          },
          otpTtl * 1000,
        ),
      );

      yield* logDevOtp("email-change", code);

      // The email's anti-enumeration framing lives in the template itself
      // (shared/email/src/templates/otp.ts → renderEmailChangeOtp).
      const email = yield* EmailService;
      yield* email
        .send({
          template: "otp-email-change",
          to: normalised,
          data: { code, ttlMinutes: otpTtl / 60, instanceName: config.instanceName },
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
   *   - < 2 completed changes in the last 7 days, counted at the preflight
   *     and again inside every statement of the commit.
   *
   * On success: the accounts row is updated, every OTHER session is
   * revoked (the caller's stays so they don't get kicked out of the
   * Settings flow), and an audit row is inserted — one D1 batch. One code
   * commits one change: the code's entry is claimed before the commit.
   */
  const completeEmailChange = (
    accountId: string,
    code: string,
    stepUpToken: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ email: string }, AuthError | DatabaseError | CoordinationError, Db> =>
    Effect.gen(function* () {
      // Purpose-bound: a token minted for another ceremony (recovery generate,
      // passkey delete) cannot be replayed to complete an email swap. The
      // verifier also applies the post-recovery cooldown — email change is the
      // pivot to a permanent, mailbox-independent takeover, so it is the gate
      // the whole rule exists to hold.
      yield* verifyStepUpForEmailChange(accountId, stepUpToken);

      // Read and counted in one call, before the code is compared; see
      // `attempts.ts`.
      const guessed = yield* guessEntry(stores.pendingEmailChanges, accountId, MAX_OTP_ATTEMPTS);
      if (!guessed) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      const { entry: pending, standing } = guessed;
      if (standing === "spent") {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!timingSafeEqualString(pending.codeHash, hashSessionToken(code))) {
        if (standing === "last") yield* dropPending(accountId, pending);
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const windowStart = nowSec - EMAIL_CHANGE_WINDOW_SECONDS;

      // The rate check + current-account fetch move OUT of the
      // transaction so the write section holds the writer lock as briefly
      // as possible. The UNIQUE(email) constraint catches another account
      // that commits the same address at `tx.update`.
      const readPreflight = Effect.tryPromise({
        try: async () => {
          const [acct] = await db
            .select({ email: accounts.email })
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

      // Single use: the right code claims its entry, beside the preflight
      // reads, before anything commits. Of two right codes sent at once, each
      // with its own step-up token, exactly one claims it and goes on to the
      // commit; the other is refused as a wrong code would be, whatever the
      // preflight found. None claims an entry a new `begin` has replaced. The
      // claim spends the code even when the preflight or the commit then
      // fails: the caller steps up and begins again. The entry is not put
      // back after a failed commit, since D1 can fail a batch it has
      // committed, and a code put back then would commit the change twice.
      const [claimed, preflight] = yield* Effect.all(
        [claimEntry(stores.pendingEmailChanges, accountId, pending), readPreflight],
        { concurrency: "unbounded" },
      );
      if (!claimed) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!preflight.ok) {
        if (preflight.reason === "not_found") {
          return yield* Effect.fail(new AuthError({ message: "Account not found" }));
        }
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }
      const currentAccountRow = preflight.current;

      // The cap holds at the commit as well as at the preflight: two
      // different codes — one claimed, then a second begun and completed —
      // each pass a preflight that counted one change. Every statement below
      // re-counts the changes in the window inside itself, and SQLite runs
      // each statement atomically, so once two are on record no statement
      // writes, whether or not D1 keeps one batch apart from another.
      const changeId = genId("ech_");
      const recentChanges = sql`(${db
        .select({ n: countFn() })
        .from(emailChanges)
        .where(
          and(eq(emailChanges.accountId, accountId), gte(emailChanges.completedAt, windowStart)),
        )})`;
      const ownChangeRecorded = exists(
        db
          .select({ one: sql`1` })
          .from(emailChanges)
          .where(eq(emailChanges.id, changeId)),
      );
      // Every session but the caller's device, which stays across a refresh
      // of its own session (`outsideFamilyOf`).
      const otherSessions =
        currentSessionHash !== null
          ? and(
              eq(sessions.accountId, accountId),
              outsideFamilyOf(db, sessions.familyId, currentSessionHash),
            )
          : eq(sessions.accountId, accountId);
      const swap = db
        .update(accounts)
        .set({ email: pending.newEmail, updatedAt: new Date(nowSec * 1000) })
        .where(and(eq(accounts.id, accountId), lt(recentChanges, EMAIL_CHANGE_LIMIT)));
      // Records the change only while the account holds the address this
      // request wrote. Where two requests' statements interleave (bun:sqlite
      // runs them one at a time; D1 might), only the one whose address landed
      // last finds it here, so the change on record is the address that
      // stands. The other is refused with the cap's error even when it found
      // fewer than two changes, since the one that stands records next.
      const record = db.insert(emailChanges).select(
        db
          .select({
            id: bound(changeId, emailChanges.id),
            accountId: bound(accountId, emailChanges.accountId),
            previousEmail: bound(currentAccountRow.email, emailChanges.previousEmail),
            newEmail: bound(pending.newEmail, emailChanges.newEmail),
            completedAt: bound(nowSec, emailChanges.completedAt),
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, accountId),
              eq(accounts.email, pending.newEmail),
              lt(recentChanges, EMAIL_CHANGE_LIMIT),
            ),
          ),
      );
      // A refused request's sessions stay: the wipe runs only once its own
      // change is on record.
      const wipe = db.delete(sessions).where(and(otherSessions, ownChangeRecorded));

      const changed = yield* Effect.tryPromise({
        try: async () => {
          try {
            // One batch on D1, one statement at a time on bun:sqlite. The
            // swap goes first, so a UNIQUE(email) conflict throws before
            // anything is written on either driver. A refused request's swap
            // can land on bun:sqlite (or on D1, should it interleave batches)
            // and be overwritten by the swap that stands; its change and its
            // wipe never run. `previous_email` is the preflight's read, so
            // with two changes committing together it can name the address
            // before the other one.
            const [, recorded] = canBatch(db)
              ? await db.batch([swap, record, wipe])
              : ([await swap, await record, await wipe] as const);
            if (rowsChanged(recorded) !== 1)
              return { ok: false as const, reason: "capped" as const };
            return { ok: true as const, email: pending.newEmail };
          } catch (e) {
            const msg = driverErrorText(e);
            // Only a uniqueness violation is a genuine caller-facing conflict
            // (another account already claimed the address); see
            // `UNIQUE_CONSTRAINT_ERROR` for the full justification, shared
            // with `registration.ts`.
            if (UNIQUE_CONSTRAINT_ERROR.test(msg)) {
              return { ok: false as const, reason: "conflict" as const };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!changed.ok && changed.reason === "capped") {
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }
      if (!changed.ok) {
        // A UNIQUE(email) conflict: another account holds the address. Map to
        // a generic error that matches the begin-path enumeration posture.
        //
        // The claim above has already spent the code, so a retry finds no
        // pending change: the address is held by another account, and a fresh
        // `begin` is the honest way back in should it ever come free.
        return yield* Effect.fail(
          new AuthError({ message: "Invalid or expired code", metricResult: "conflict" }),
        );
      }

      metricSessionSecurityInvalidation("email_change");
      return { email: changed.email };
    }).pipe(withEmailChange("complete"));

  return {
    beginEmailChange,
    completeEmailChange,
  };
}

export type EmailChangeModule = ReturnType<typeof createEmailChangeModule>;
