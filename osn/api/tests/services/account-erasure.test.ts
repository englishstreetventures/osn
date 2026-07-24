import { it, expect, describe } from "@effect/vitest";
import {
  accounts,
  appEnrollments,
  deletionJobs,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  passkeys,
  recoveryCodes,
  securityEvents,
  sessions,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import * as accountErasure from "../../src/services/account-erasure";
import * as appEnroll from "../../src/services/app-enrollments";
import { createTestLayer } from "../helpers/db";

/**
 * Helper — seed an account + one profile and return the ids.
 */
const seedAccountAndProfile = (
  email = "alice@example.com",
  handle = "alice",
): Effect.Effect<{ accountId: string; profileId: string }, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const accountId = "acc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const profileId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    yield* Effect.promise(() =>
      db.insert(accounts).values({
        id: accountId,
        email,
        passkeyUserId: crypto.randomUUID(),
        maxProfiles: 5,
        createdAt: now,
        updatedAt: now,
      }),
    );
    yield* Effect.promise(() =>
      db.insert(users).values({
        id: profileId,
        accountId,
        handle,
        displayName: "Alice",
        avatarUrl: null,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return { accountId, profileId };
  });

/**
 * Helper — seed a passkey, recovery code, and 2 sessions for an account.
 */
const seedCredentials = (accountId: string): Effect.Effect<{ aliveSessionId: string }, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);
    yield* Effect.promise(() =>
      db.insert(passkeys).values({
        id: "pk_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        accountId,
        credentialId: crypto.randomUUID(),
        publicKey: "stub",
        counter: 0,
        createdAt: new Date(),
      }),
    );
    yield* Effect.promise(() =>
      db.insert(recoveryCodes).values({
        id: "rec_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        accountId,
        codeHash: crypto.randomUUID(),
        createdAt: now,
      }),
    );
    const aliveSessionId = "sha_" + crypto.randomUUID().replace(/-/g, "");
    const otherSessionId = "sha_" + crypto.randomUUID().replace(/-/g, "");
    yield* Effect.promise(() =>
      db.insert(sessions).values([
        {
          id: aliveSessionId,
          accountId,
          familyId: "sfam_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          expiresAt: now + 86_400,
          createdAt: now,
        },
        {
          id: otherSessionId,
          accountId,
          familyId: "sfam_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          expiresAt: now + 86_400,
          createdAt: now,
        },
      ]),
    );
    return { aliveSessionId };
  });

describe("account-erasure: requestErasure", () => {
  it.effect(
    "soft-deletes the account, redacts identity, nukes credentials, keeps cancel session",
    () =>
      Effect.gen(function* () {
        const { accountId, profileId } = yield* seedAccountAndProfile();
        const { aliveSessionId } = yield* seedCredentials(accountId);
        yield* appEnroll.joinApp(accountId, "pulse");

        const result = yield* accountErasure.requestErasure({
          accountId,
          cancelSessionId: aliveSessionId,
        });

        expect(result.newlyScheduled).toBe(true);
        expect(result.scheduledFor).toBeGreaterThan(Math.floor(Date.now() / 1_000));

        const { db } = yield* Db;
        // Account row tombstoned.
        const acct = yield* Effect.promise(() =>
          db.select().from(accounts).where(eq(accounts.id, accountId)),
        );
        expect(acct[0].deletedAt).not.toBeNull();

        // Handle redacted.
        const userRows = yield* Effect.promise(() =>
          db.select().from(users).where(eq(users.id, profileId)),
        );
        expect(userRows[0].handle).toMatch(/^deleted_/);
        expect(userRows[0].displayName).toBeNull();

        // Passkeys + recovery codes nuked.
        const remainingPk = yield* Effect.promise(() =>
          db.select().from(passkeys).where(eq(passkeys.accountId, accountId)),
        );
        expect(remainingPk).toHaveLength(0);
        const remainingRc = yield* Effect.promise(() =>
          db.select().from(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
        );
        expect(remainingRc).toHaveLength(0);

        // Sessions: only the cancel handle survives.
        const remainingSessions = yield* Effect.promise(() =>
          db.select().from(sessions).where(eq(sessions.accountId, accountId)),
        );
        expect(remainingSessions).toHaveLength(1);
        expect(remainingSessions[0].id).toBe(aliveSessionId);

        // Audit row created.
        const events = yield* Effect.promise(() =>
          db.select().from(securityEvents).where(eq(securityEvents.accountId, accountId)),
        );
        expect(events.map((e) => e.kind)).toContain("account_deletion_scheduled");

        // App enrollments closed.
        const enrolled = yield* Effect.promise(() =>
          db.select().from(appEnrollments).where(eq(appEnrollments.accountId, accountId)),
        );
        expect(enrolled[0].leftAt).not.toBeNull();

        // Deletion job persisted with grace window.
        const jobs = yield* Effect.promise(() =>
          db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
        );
        expect(jobs).toHaveLength(1);
        expect(jobs[0].cancelSessionId).toBe(aliveSessionId);
        // Pulse was enrolled — bridge column NULL pending fan-out.
        expect(jobs[0].pulseDoneAt).toBeNull();
        // Zap was NOT enrolled — pre-marked done with sentinel.
        expect(jobs[0].zapDoneAt).toBe(-1);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("idempotent — second call returns the original scheduled timestamp", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const first = yield* accountErasure.requestErasure({
        accountId,
        cancelSessionId: null,
      });
      const second = yield* accountErasure.requestErasure({
        accountId,
        cancelSessionId: null,
      });
      expect(second.newlyScheduled).toBe(false);
      expect(second.scheduledFor).toBe(first.scheduledFor);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails AccountNotFoundError when the account does not exist", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        accountErasure.requestErasure({ accountId: "acc_nonexistent", cancelSessionId: null }),
      );
      expect(err._tag).toBe("AccountNotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("account-erasure: cancelErasure", () => {
  it.effect("clears the deletion job and accounts.deletedAt", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* accountErasure.requestErasure({ accountId, cancelSessionId: null });

      const result = yield* accountErasure.cancelErasure(accountId);
      expect(result.cancelled).toBe(true);

      const { db } = yield* Db;
      const acct = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, accountId)),
      );
      expect(acct[0].deletedAt).toBeNull();
      const jobs = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      expect(jobs).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("idempotent on no-op", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const result = yield* accountErasure.cancelErasure(accountId);
      expect(result.cancelled).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses cancellation once the grace window has expired (S-H1)", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      // Job whose grace window is already over — fan-out may be in flight.
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000, // long past
          pulseDoneAt: null,
          zapDoneAt: null,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      const result = yield* accountErasure.cancelErasure(accountId);
      expect(result.cancelled).toBe(false);
      // Job row untouched — the sweeper still owns it.
      const jobs = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      expect(jobs).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("account-erasure: getDeletionStatus", () => {
  it.effect("returns scheduled false when no job exists", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const status = yield* accountErasure.getDeletionStatus(accountId);
      expect(status.scheduled).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns scheduled true with the hard-delete deadline", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* accountErasure.requestErasure({ accountId, cancelSessionId: null });
      const status = yield* accountErasure.getDeletionStatus(accountId);
      expect(status.scheduled).toBe(true);
      if (status.scheduled) {
        expect(status.scheduledFor).toBeGreaterThan(Math.floor(Date.now() / 1_000));
      }
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("account-erasure: hard-delete sweeper", () => {
  it.effect("hard-deletes accounts whose grace window has elapsed AND fan-out is complete", () =>
    Effect.gen(function* () {
      const { accountId, profileId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      // Insert a job that is past hard_delete_at AND has both bridges done.
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      yield* Effect.promise(() =>
        db.update(accounts).set({ deletedAt: 1_000 }).where(eq(accounts.id, accountId)),
      );

      const result = yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });
      expect(result.purged).toBe(1);

      const remainingAcc = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, accountId)),
      );
      expect(remainingAcc).toHaveLength(0);
      const remainingUsers = yield* Effect.promise(() =>
        db.select().from(users).where(eq(users.id, profileId)),
      );
      expect(remainingUsers).toHaveLength(0);
      const remainingJobs = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      expect(remainingJobs).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does NOT hard-delete when fan-out is still pending", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: null, // pending
          zapDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      const result = yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });
      expect(result.purged).toBe(0);
      const remaining = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      expect(remaining).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("preserves security_events at hard-delete (Art. 6(1)(c) retention)", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(securityEvents).values({
          id: "sev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          accountId,
          kind: "recovery_code_generate",
          createdAt: 900,
          acknowledgedAt: null,
        }),
      );
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });
      // Account row gone, audit row survives.
      const acct = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, accountId)),
      );
      expect(acct).toHaveLength(0);
      const audit = yield* Effect.promise(() =>
        db.select().from(securityEvents).where(eq(securityEvents.accountId, accountId)),
      );
      expect(audit).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("erases OIDC consents and authorization codes at hard-delete (Art. 17)", () =>
    Effect.gen(function* () {
      const { accountId, profileId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      // Consent record + a live authorization code, both account-scoped PII.
      yield* Effect.promise(() =>
        db.insert(oauthConsents).values({
          id: "ocon_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          accountId,
          clientId: "cli_pulse",
          profileId,
          scope: "openid profile email",
          grantedAt: 900,
          revokedAt: null,
        }),
      );
      yield* Effect.promise(() =>
        db.insert(oauthAuthorizationCodes).values({
          id: "ocode_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          clientId: "cli_pulse",
          accountId,
          profileId,
          redirectUri: "https://pulse.example/callback",
          scope: "openid profile email",
          codeChallenge: crypto.randomUUID(),
          nonce: null,
          authTime: 900,
          expiresAt: 5_000_960,
          createdAt: 900,
        }),
      );
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });

      const remainingConsents = yield* Effect.promise(() =>
        db.select().from(oauthConsents).where(eq(oauthConsents.accountId, accountId)),
      );
      expect(remainingConsents).toHaveLength(0);
      const remainingCodes = yield* Effect.promise(() =>
        db
          .select()
          .from(oauthAuthorizationCodes)
          .where(eq(oauthAuthorizationCodes.accountId, accountId)),
      );
      expect(remainingCodes).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("disables and unlinks OIDC clients the erased account registered", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(oauthClients).values({
          id: "oc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          clientId: "cid_owned_by_erased",
          name: "Erased Founder's App",
          redirectUris: ["https://app.example/cb"],
          sectorIdentifier: "app.example",
          ownerAccountId: accountId,
          createdAt: 900,
        }),
      );
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });

      // The row survives (other users' consents may reference it) but is
      // disabled — so it stops authorising — and the ownership link is gone.
      const rows = yield* Effect.promise(() =>
        db.select().from(oauthClients).where(eq(oauthClients.clientId, "cid_owned_by_erased")),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.disabledAt).not.toBeNull();
      expect(rows[0]!.ownerAccountId).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("account-erasure: fan-out sweep grace gating (S-H1)", () => {
  it.effect("skips rows whose grace window has not yet elapsed", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      const nowMs = 5_000_000;
      // Pending fan-out but grace not over: must NOT be dispatched.
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: Math.floor(nowMs / 1_000) - 100,
          hardDeleteAt: Math.floor(nowMs / 1_000) + 600_000, // grace still running
          pulseDoneAt: null,
          zapDoneAt: null,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );
      const result = yield* accountErasure.runFanOutRetrySweep({ nowMs });
      expect(result.retried).toBe(0);
      // Bridge columns untouched.
      const job = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      expect(job[0].pulseDoneAt).toBeNull();
      expect(job[0].zapDoneAt).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("app-enrollments service", () => {
  it.effect("joinApp + listActiveApps + leaveApp lifecycle", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      // Initially nothing.
      let active = yield* appEnroll.listActiveApps(accountId);
      expect(active).toEqual([]);
      // Join Pulse (idempotent on second call).
      const r1 = yield* appEnroll.joinApp(accountId, "pulse");
      expect(r1.enrolled).toBe(true);
      const r2 = yield* appEnroll.joinApp(accountId, "pulse");
      expect(r2.enrolled).toBe(false);
      active = yield* appEnroll.listActiveApps(accountId);
      expect(active).toEqual(["pulse"]);
      // Leave.
      const left = yield* appEnroll.leaveApp(accountId, "pulse");
      expect(left.closed).toBe(true);
      active = yield* appEnroll.listActiveApps(accountId);
      expect(active).toEqual([]);
      // Re-join writes a fresh row (history preserved).
      const r3 = yield* appEnroll.joinApp(accountId, "pulse");
      expect(r3.enrolled).toBe(true);
      const { db } = yield* Db;
      const allRows = yield* Effect.promise(() =>
        db.select().from(appEnrollments).where(eq(appEnrollments.accountId, accountId)),
      );
      expect(allRows).toHaveLength(2);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// Module-suppression: avoid an unused-binding warning for the Layer import
// when @effect/vitest's `provide(...)` is the only consumer.
void Layer;
