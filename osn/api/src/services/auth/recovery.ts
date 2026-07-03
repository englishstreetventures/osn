/**
 * Recovery codes (Copenhagen Book M2): single-use, high-entropy account
 * recovery tokens. Generation replaces the set atomically; consumption is
 * CAS-guarded, revokes every session, and records an audit row. O2 lockout:
 * repeated failures against a real account trip a per-account counter.
 */

import { accounts, recoveryCodes, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  generateRecoveryCodes as cryptoGenerateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@shared/crypto";
import { commitBatch } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import type { SecurityEventKind } from "@shared/observability/metrics";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import { RECOVERY_LOCKOUT_THRESHOLD } from "../../lib/recovery-lockout-store";
import {
  metricRecoveryCodeConsumed,
  metricRecoveryCodesGenerated,
  metricRecoveryLockout,
  metricSecurityEventNotified,
  metricSecurityEventNotifyDuration,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAuthLogin,
  withAuthRecovery,
} from "../../metrics";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError } from "./errors";
import { genId, normaliseIdentifier, probeAccountId } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { TokensModule } from "./tokens";
import type { ProfileWithEmail, PublicProfile, SessionMeta, TokenSet } from "./types";
import { toPublicProfile } from "./types";

export function createRecoveryModule(
  ctx: AuthContext,
  profiles: ProfilesModule,
  tokens: TokensModule,
) {
  const { recoveryLockoutStore, hashIp } = ctx;
  const { resolveIdentifier } = profiles;
  const { issueTokens } = tokens;

  const generateRecoveryCodesForAccount = (
    accountId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ recoveryCodes: string[] }, DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const codes = cryptoGenerateRecoveryCodes(RECOVERY_CODE_COUNT);
      const nowSec = Math.floor(Date.now() / 1000);
      const rows = codes.map((code) => ({
        id: genId("rec_"),
        accountId,
        codeHash: hashRecoveryCode(code),
        usedAt: null,
        createdAt: nowSec,
      }));

      // M-PK1b: the recovery-code swap and the matching security_events row
      // commit together. If the audit write fails, the code swap rolls back
      // too — we never want codes in the DB that the account holder can't
      // see in their security banner.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "recovery_code_generate",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      yield* Effect.tryPromise({
        // Swap the code set + audit row atomically (batch on D1, sequential on
        // bun:sqlite) — never leave codes the account holder can't see.
        try: () =>
          commitBatch(db, [
            db.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
            db.insert(recoveryCodes).values(rows),
            db.insert(securityEvents).values(securityEventRow),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricRecoveryCodesGenerated();
      // S-L3 (symmetric): regenerating the set is a security-relevant event
      // worth surfacing on the session-invalidation dashboard. It doesn't
      // revoke sessions itself, but it does invalidate the previous code set
      // — an out-of-band regen (XSS-triggered, S-M1) is exactly the pattern
      // we want to notice.
      metricSessionSecurityInvalidation("recovery_code_generate");
      metricSecurityEventRecorded("recovery_code_generate");

      // M-PK1b / P-W2: fire-and-forget email notification. The audit row is
      // the primary signal, so user-visible latency must not track mailer
      // health. Fork onto the scheduler with a hard timeout so a slow
      // provider can't tie up the request handler. Failure is logged via
      // the metric branches inside `notifyRecovery`.
      yield* Effect.forkDaemon(
        notifyRecoveryByAccountId(accountId, "recovery_code_generate").pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { recoveryCodes: codes };
    }).pipe(withAuthRecovery("generate"));

  /**
   * Resolves the recipient email for a security-event notification from the
   * accounts table and dispatches via `notifyRecovery`. Used by the
   * fire-and-forget paths in generate/consume which don't already hold the
   * profile row. Stays out of the user's latency path (called inside
   * `Effect.forkDaemon`), so the extra round-trip is harmless.
   */
  const notifyRecoveryByAccountId = (
    accountId: string,
    kind: SecurityEventKind,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const email = rows[0]?.email ?? null;
      yield* notifyRecovery(email, kind);
    });

  /**
   * Sends the out-of-band "your recovery codes were regenerated" OR "your
   * recovery codes were used" email. S-L5 framing ("somebody asked for this
   * on your account") mirrors the email-change ceremony so a misdirected
   * message is clearly junk to the recipient and useless as a phishing
   * template.
   *
   * Never includes the codes themselves — the audit row is the signal, the
   * email is the confirmation.
   *
   * P-I5: accepts the recipient email directly so the common call path
   * doesn't re-fetch the `accounts` row — the caller already has it.
   */
  const notifyRecovery = (
    recipientEmail: string | null,
    kind: SecurityEventKind,
  ): Effect.Effect<void, AuthError, EmailService> =>
    Effect.gen(function* () {
      if (!recipientEmail) {
        // Defensive: account row fully evicted between commit and dispatch.
        metricSecurityEventNotified(kind, "skipped");
        return;
      }

      const template =
        kind === "recovery_code_generate" ? "recovery-generated" : "recovery-consumed";
      const email = yield* EmailService;
      const start = Date.now();
      yield* email
        .send({ template, to: recipientEmail, data: {} })
        // S-L2: bounded error class name in the log annotation; the email
        // provider's response body (which may echo the recipient) is never
        // embedded in the logged message.
        .pipe(
          Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
          Effect.tap(() =>
            Effect.sync(() => {
              metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
              metricSecurityEventNotified(kind, "sent");
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
              metricSecurityEventNotified(kind, "failed");
            }),
          ),
        );
    }).pipe(Effect.withSpan("auth.security_event.notify", { attributes: { kind } }));

  /**
   * O2: write the `recovery_code_lockout` audit row when an account crosses the
   * failed-attempt threshold. Surfaces in the security-events banner so the
   * legitimate owner sees "repeated failed recovery attempts on your account"
   * even though every attempt returned the same generic error over the wire.
   * Best-effort: a write failure is logged but never converts the
   * already-correct generic-error response into a 500.
   */
  const recordRecoveryLockoutEvent = (
    accountId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<void, never, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(securityEvents).values({
            id: genId("sev_"),
            accountId,
            kind: "recovery_code_lockout",
            createdAt: nowSec,
            acknowledgedAt: null,
            ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
            uaLabel: eventMeta?.uaLabel ?? null,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(
        Effect.tap(() => Effect.sync(() => metricSecurityEventRecorded("recovery_code_lockout"))),
        Effect.catchAll((cause) =>
          Effect.logWarning("auth.recovery.lockout: audit write failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("auth.recovery.lockout"));

  /**
   * Consumes a recovery code — returns the profile to establish a fresh
   * session against, and marks the code row as used. Invalidates every
   * existing session for the account before the caller issues the new one.
   *
   * Always fails with the same generic AuthError on unknown identifier,
   * unknown/used code, or expired lookups — does not distinguish between
   * "wrong identifier" and "wrong code" over the wire.
   *
   * S-M2: both branches (unknown identifier vs known identifier + wrong code)
   * execute the same work — identifier lookup, a `hashRecoveryCode` call, and
   * an indexed SELECT against `recovery_codes` — so wall-clock latency does
   * not reveal whether the identifier exists.
   */
  const consumeRecoveryCode = (
    identifier: string,
    code: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ profile: ProfileWithEmail }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);
      const { db } = yield* Db;

      // Compute the hash up front regardless of profile existence so both
      // branches pay the same SHA-256 cost (S-M2).
      const codeHash = hashRecoveryCode(code);

      if (!profile) {
        // Equalise DB work on the unknown-identifier branch with a same-shape
        // no-op lookup (predicate can never match since the accountId is an
        // impossible sentinel). Indexed by `recovery_codes_account_idx`.
        yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(recoveryCodes)
              .where(
                and(
                  // O5: random per-request sentinel — see probeAccountId.
                  eq(recoveryCodes.accountId, probeAccountId()),
                  eq(recoveryCodes.codeHash, codeHash),
                ),
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricRecoveryCodeConsumed("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      // O2: per-account lockout. Keyed on the RESOLVED accountId (never the
      // caller-supplied identifier) so an attacker cannot lock a victim out by
      // spamming their handle, and an unknown identifier — which never reaches
      // this branch — can never trip a lockout. When locked we still run the
      // same indexed SELECT below for latency parity, then return the SAME
      // generic error as any other failure (preserving the no-enumeration
      // oracle: a locked account is indistinguishable from a wrong code).
      const locked = yield* Effect.promise(() => recoveryLockoutStore.isLocked(profile.accountId));

      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(recoveryCodes)
            .where(
              and(
                eq(recoveryCodes.accountId, profile.accountId),
                eq(recoveryCodes.codeHash, codeHash),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (locked) {
        metricRecoveryLockout("locked");
        metricRecoveryCodeConsumed("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const row = result[0];
      if (!row || row.usedAt !== null) {
        // O2: a genuine failed attempt against a real account — record it and
        // trip the lockout (+ audit row) on the attempt that crosses the
        // threshold. Both "wrong code" and "already-used code" count.
        if (row?.usedAt) {
          yield* Effect.logWarning("Used recovery code replayed");
          metricRecoveryCodeConsumed("used");
        } else {
          metricRecoveryCodeConsumed("invalid");
        }
        const attempts = yield* Effect.promise(() =>
          recoveryLockoutStore.recordFailure(profile.accountId),
        );
        if (attempts === RECOVERY_LOCKOUT_THRESHOLD) {
          yield* recordRecoveryLockoutEvent(profile.accountId, eventMeta);
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const nowSec = Math.floor(Date.now() / 1000);
      // S-H1: a recovery-code CONSUME is the actual takeover step in the
      // attacker-burns-codes scenario. Record the audit row in the same
      // transaction as the sessions wipe so the legitimate owner can see
      // "a recovery code was used on your account" even if the attacker
      // suppressed the confirmation email.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId: profile.accountId,
        kind: "recovery_code_consume",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      // S-M1: the SELECT above is check-then-act — two concurrent requests with
      // the same code can both pass `row.usedAt === null` and double-consume.
      // Close the race with a compare-and-swap: mark the code used ONLY while it
      // is still unused (`usedAt IS NULL`), then key the rest of the ceremony off
      // the rows-affected count. Mirrors the passkey-rename CAS in this file.
      const consumeResult = yield* Effect.tryPromise({
        try: () =>
          db
            .update(recoveryCodes)
            .set({ usedAt: nowSec })
            .where(and(eq(recoveryCodes.id, row.id), isNull(recoveryCodes.usedAt))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // better-sqlite3 returns `{ changes }`, libsql/D1 `{ rowsAffected }`.
      const consumed =
        (consumeResult as unknown as { changes?: number; rowsAffected?: number }).changes ??
        (consumeResult as unknown as { changes?: number; rowsAffected?: number }).rowsAffected ??
        0;
      if (consumed === 0) {
        // Lost the CAS — another request consumed this code first. Do NOT wipe
        // sessions or write the audit row. Treat exactly like a replayed used
        // code: count the failed attempt and return the generic error.
        yield* Effect.logWarning("Recovery code consumed concurrently — CAS lost");
        metricRecoveryCodeConsumed("used");
        const attempts = yield* Effect.promise(() =>
          recoveryLockoutStore.recordFailure(profile.accountId),
        );
        if (attempts === RECOVERY_LOCKOUT_THRESHOLD) {
          yield* recordRecoveryLockoutEvent(profile.accountId, eventMeta);
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      yield* Effect.tryPromise({
        // The code is now ours. Wipe sessions + write the audit row atomically
        // (batch on D1, sequential on bun:sqlite). Recovery always revokes
        // existing sessions — the ceremony is "I lost access, log me back in
        // cleanly everywhere".
        try: () =>
          commitBatch(db, [
            db.delete(sessions).where(eq(sessions.accountId, profile.accountId)),
            db.insert(securityEvents).values(securityEventRow),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricRecoveryCodeConsumed("success");
      // O2: a successful consume clears the failed-attempt counter.
      yield* Effect.promise(() => recoveryLockoutStore.reset(profile.accountId));
      metricRecoveryLockout("reset");
      // S-L3: whole-account session wipe is a security-relevant event — emit
      // the canonical invalidation metric so the existing dashboard covers it.
      metricSessionSecurityInvalidation("recovery_code_consume");
      metricSecurityEventRecorded("recovery_code_consume");

      // M-PK1b / P-W2: fire-and-forget consume notification with a timeout
      // so the login latency is decoupled from mailer health. The profile
      // is already loaded so we pass the email directly — no post-commit
      // accounts round-trip.
      yield* Effect.forkDaemon(
        notifyRecovery(profile.email, "recovery_code_consume").pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { profile };
    }).pipe(withAuthRecovery("consume"));

  /**
   * Completes a recovery-code login. Consumes the code, then issues a fresh
   * session + profile in one step so the route can return the same shape as
   * the other first-party `/login/*` completers.
   */
  const completeRecoveryLogin = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError,
    Db | EmailService
  > =>
    Effect.gen(function* () {
      const { profile } = yield* consumeRecoveryCode(identifier, code, sessionMeta);
      const session = yield* issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        sessionMeta,
      );
      return { session, profile: toPublicProfile(profile, profile.email) };
    }).pipe(withAuthLogin("recovery_code"));

  /** Returns the count of unused recovery codes for the account. */
  const countActiveRecoveryCodes = (
    accountId: string,
  ): Effect.Effect<{ active: number; total: number }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const active = rows.filter((r) => r.usedAt === null).length;
      return { active, total: rows.length };
    });

  return {
    generateRecoveryCodesForAccount,
    notifyRecovery,
    notifyRecoveryByAccountId,
    consumeRecoveryCode,
    completeRecoveryLogin,
    countActiveRecoveryCodes,
  };
}

export type RecoveryModule = ReturnType<typeof createRecoveryModule>;
