/**
 * Passkey management (M-PK) — the Settings surface over an account's
 * existing credentials: list (public-safe summary), rename (label only),
 * delete (last-passkey guarded, revokes other sessions, audited). None of
 * these methods accept or emit secret material.
 */

import { passkeys, securityEvents, sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withPasskeyOp,
} from "../../metrics";
import type { AuthContext } from "./context";
import { AuthError, DatabaseError, ValidationError } from "./errors";
import { genId, PasskeyLabelSchema } from "./helpers";
import type { SecurityEventsModule } from "./security-events";
import type { SessionsModule } from "./sessions";
import type { PasskeySummary, SessionMeta } from "./types";

export function createPasskeyManagementModule(
  ctx: AuthContext,
  sessions_: SessionsModule,
  securityEventsModule: SecurityEventsModule,
) {
  const { hashIp } = ctx;
  const { invalidateOtherAccountSessions } = sessions_;
  /** See {@link SecurityEventsModule.notifySecurityEventByAccountId}. */
  const notifyPasskeyDeletedByAccountId = (accountId: string) =>
    securityEventsModule.notifySecurityEventByAccountId(
      accountId,
      "passkey_delete",
      "passkey-removed",
    );

  const listPasskeys = (
    accountId: string,
  ): Effect.Effect<{ passkeys: PasskeySummary[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // Explicit projection so the public type never widens by accident —
      // adding publicKey / counter later must be an intentional edit here.
      // S-L2: `credentialId` is intentionally excluded from the projection.
      // The Settings UI only needs the opaque `pk_<hex>` `id` to drive
      // rename/delete; emitting credentialIds would let a malicious bundled
      // dependency exfiltrate authenticator-model fingerprints for targeted
      // phishing.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: passkeys.id,
              label: passkeys.label,
              aaguid: passkeys.aaguid,
              transports: passkeys.transports,
              backupEligible: passkeys.backupEligible,
              backupState: passkeys.backupState,
              createdAt: passkeys.createdAt,
              lastUsedAt: passkeys.lastUsedAt,
            })
            .from(passkeys)
            .where(eq(passkeys.accountId, accountId))
            .orderBy(desc(passkeys.lastUsedAt), desc(passkeys.createdAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return {
        passkeys: rows.map((row) => ({
          id: row.id,
          label: row.label,
          aaguid: row.aaguid,
          transports: row.transports ? (JSON.parse(row.transports) as string[]) : null,
          backupEligible: row.backupEligible,
          backupState: row.backupState,
          createdAt: Math.floor(row.createdAt.getTime() / 1000),
          lastUsedAt: row.lastUsedAt,
        })),
      };
    }).pipe(withPasskeyOp("list"));

  const renamePasskey = (
    accountId: string,
    passkeyId: string,
    label: string,
  ): Effect.Effect<void, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const trimmed = label.trim();
      yield* Schema.decodeUnknown(PasskeyLabelSchema)(trimmed).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (!/^pk_[a-f0-9]{12}$/.test(passkeyId)) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .update(passkeys)
            .set({ label: trimmed, updatedAt: nowSec })
            .where(and(eq(passkeys.id, passkeyId), eq(passkeys.accountId, accountId))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // better-sqlite3 returns `{ changes }`, libsql returns `{ rowsAffected }`.
      // Treat 0 rows updated as not-found without leaking whether another
      // account owns the id.
      const affected =
        (result as unknown as { changes?: number; rowsAffected?: number }).changes ??
        (result as unknown as { changes?: number; rowsAffected?: number }).rowsAffected ??
        0;
      if (affected === 0) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }
    }).pipe(withPasskeyOp("rename"));

  /**
   * Deletes a single passkey, records a security event, and revokes every
   * OTHER session so an attacker who stole one passkey cannot piggyback on
   * a stale access token to keep working after the legitimate user
   * remediates.
   *
   * Last-passkey guard: refuses unconditionally if this would leave the
   * account with zero passkeys. The account-level invariant is "every
   * account always has ≥1 WebAuthn credential"; recovery codes are the
   * "my device is gone" escape hatch, not a substitute credential. Users
   * who want to rotate a compromised passkey enroll the replacement
   * first, then delete the old one.
   */
  const deletePasskey = (
    accountId: string,
    passkeyId: string,
    currentSessionHash: string | null,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ remaining: number }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      if (!/^pk_[a-f0-9]{12}$/.test(passkeyId)) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }
      const { db } = yield* Db;

      const nowSec = Math.floor(Date.now() / 1000);
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "passkey_delete",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      // S-M1 / P-W1: gate-then-delete inside one transaction so two concurrent
      // DELETEs cannot race past the last-passkey guard.
      type TxResult =
        | { ok: true; remaining: number }
        | { ok: false; reason: "not_found" | "lockout" };
      // D1 has no interactive transaction, so the gate is split: read the set
      // for the not-found / lockout decisions, then issue a COUNT-GUARDED delete
      // whose WHERE clause re-asserts ">1 passkey" in the same statement. That
      // guard is what keeps the last-passkey invariant race-safe on D1 — two
      // concurrent deletes can't both succeed, because the second's subquery
      // sees the count would drop to 1 and deletes nothing. (A losing racer may
      // still write a redundant audit row; harmless.)
      const accountPasskeys = yield* Effect.tryPromise({
        try: () =>
          db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const exists = accountPasskeys.some((r) => r.id === passkeyId);
      const txResult: TxResult = !exists
        ? { ok: false, reason: "not_found" }
        : accountPasskeys.length <= 1
          ? { ok: false, reason: "lockout" }
          : { ok: true, remaining: accountPasskeys.length - 1 };

      if (txResult.ok) {
        yield* Effect.tryPromise({
          try: () =>
            commitBatch(db, [
              db
                .delete(passkeys)
                .where(
                  and(
                    eq(passkeys.id, passkeyId),
                    eq(passkeys.accountId, accountId),
                    sql`(select count(*) from ${passkeys} where ${passkeys.accountId} = ${accountId}) > 1`,
                  ),
                ),
              db.insert(securityEvents).values(securityEventRow),
            ]),
          catch: (cause) => new DatabaseError({ cause }),
        });
      }

      if (!txResult.ok) {
        if (txResult.reason === "not_found") {
          return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
        }
        return yield* Effect.fail(
          new AuthError({
            message: "Enroll another passkey before removing this one",
          }),
        );
      }

      metricSecurityEventRecorded("passkey_delete");

      // H1: revoke other sessions. An attacker who stole a session + the
      // passkey shouldn't keep working after the credential goes away.
      if (currentSessionHash) {
        yield* invalidateOtherAccountSessions(accountId, currentSessionHash, "passkey_delete");
      } else {
        // S-L3: caller has no session cookie (e.g. the delete came in via an
        // enrollment-token path or the cookie was stripped by a proxy). We
        // nuke every session on the account because there's no "self" to
        // preserve. This branch is rare and forensically distinct, so log it
        // out-of-band and emit the security-invalidation metric explicitly.
        yield* Effect.logWarning("auth.passkey.delete: nuking all sessions (no caller session)");
        yield* Effect.tryPromise({
          try: () => db.delete(sessions).where(eq(sessions.accountId, accountId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricSessionSecurityInvalidation("passkey_delete");
      }

      // M-PK1b: fire-and-forget email notification (codes never included).
      yield* Effect.forkDaemon(
        notifyPasskeyDeletedByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { remaining: txResult.remaining };
    }).pipe(withPasskeyOp("delete"));

  return {
    listPasskeys,
    renamePasskey,
    deletePasskey,
  };
}

export type PasskeyManagementModule = ReturnType<typeof createPasskeyManagementModule>;
