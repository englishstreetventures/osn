import { it, expect, describe } from "@effect/vitest";
import {
  accounts,
  appEnrollments,
  deletionJobs,
  handleHolds,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  organisationMembers,
  organisations,
  passkeys,
  recoveryCodes,
  rotatedSessions,
  securityEvents,
  sessions,
  totpCredentials,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Fiber, Layer, Logger } from "effect";
import { afterAll, afterEach, vi } from "vitest";

import { makeHeldHandleDigest } from "../../src/lib/handle-hold";
import * as metrics from "../../src/metrics";
import * as accountErasure from "../../src/services/account-erasure";
import * as appEnroll from "../../src/services/app-enrollments";
import { NO_DELETION_APPS } from "../../src/services/deletion-apps";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { appStandIns, everyAppDone } from "../helpers/deletion-apps";
import { holdQueries } from "../helpers/held-query";

/** The digest every route factory's auth service uses when no pepper is set. */
const digest = makeHeldHandleDigest(undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

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
 * Helper — seed a passkey, recovery code, TOTP authenticator and 2 sessions
 * for an account.
 */
const seedCredentials = (
  accountId: string,
): Effect.Effect<{ aliveSessionId: string; aliveFamilyId: string }, never, Db> =>
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
    yield* Effect.promise(() =>
      db.insert(totpCredentials).values({
        id: "totp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        accountId,
        secretCiphertext: Buffer.from(new Uint8Array(36)),
        iv: Buffer.from(new Uint8Array(12)),
        keyVersion: 1,
        confirmedAt: now,
        createdAt: now,
      }),
    );
    const aliveSessionId = "sha_" + crypto.randomUUID().replace(/-/g, "");
    const aliveFamilyId = "sfam_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const otherSessionId = "sha_" + crypto.randomUUID().replace(/-/g, "");
    yield* Effect.promise(() =>
      db.insert(sessions).values([
        {
          id: aliveSessionId,
          accountId,
          familyId: aliveFamilyId,
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
    return { aliveSessionId, aliveFamilyId };
  });

/** Helper — one live rotation record for `accountId` in `familyId`, hash `<prefix>1`. */
const seedRotated = (
  accountId: string,
  familyId: string,
  prefix: string,
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(rotatedSessions).values({
        tokenHash: `${prefix}1`,
        familyId,
        accountId,
        rotatedAt: 0,
        expiresAt: Date.now() + 86_400_000,
      }),
    );
  });

/** The account's credential rows, by kind. */
const credentialCounts = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [pk, rc, totp] = yield* Effect.promise(() =>
      Promise.all([
        db.select().from(passkeys).where(eq(passkeys.accountId, accountId)),
        db.select().from(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
        db.select().from(totpCredentials).where(eq(totpCredentials.accountId, accountId)),
      ]),
    );
    return { passkeys: pk.length, recoveryCodes: rc.length, totp: totp.length };
  });

/** Every `handle_holds` row, ordered by digest. */
const holdRows = Effect.gen(function* () {
  const { db } = yield* Db;
  return yield* Effect.promise(() =>
    db
      .select({
        handle: handleHolds.handle,
        accountId: handleHolds.accountId,
        releaseAt: handleHolds.releaseAt,
      })
      .from(handleHolds)
      .orderBy(handleHolds.handle),
  );
});

/** A test database whose statements can be held ({@link holdQueries}). */
function held() {
  const { db, email } = createTestLayerWithSqlite();
  const queries = holdQueries(db);
  return {
    layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
    hold: queries.hold,
  };
}

/** The account's deletion job, if any. */
const jobRow = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.promise(() =>
      db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
    );
    return rows[0];
  });

/** The account's row, if any. */
const accountRow = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.promise(() =>
      db.select().from(accounts).where(eq(accounts.id, accountId)),
    );
    return rows[0];
  });

describe("account-erasure: requestErasure", () => {
  it.effect(
    "soft-deletes the account, redacts identity, keeps credentials and the cancel session",
    () =>
      Effect.gen(function* () {
        const { accountId, profileId } = yield* seedAccountAndProfile();
        const { aliveSessionId, aliveFamilyId } = yield* seedCredentials(accountId);
        yield* appEnroll.joinApp(accountId, "pulse");

        const result = yield* accountErasure.requestErasure({
          accountId,
          cancel: { sessionId: aliveSessionId, familyId: aliveFamilyId },
          heldHandleDigest: digest,
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

        // Every credential stays until the hard delete, so a person who can
        // still sign in can cancel.
        expect(yield* credentialCounts(accountId)).toEqual({
          passkeys: 1,
          recoveryCodes: 1,
          totp: 1,
        });

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
        // Every app is pending, enrolled (Pulse) or not (Zap): the fan-out
        // reaches every app for every account.
        expect(jobs[0].pulseDoneAt).toBeNull();
        expect(jobs[0].zapDoneAt).toBeNull();
        expect(jobs[0].deleteEverything).toBe(false);
        expect(jobs[0].appOutcomes).toBeNull();
        expect(result.profileIds).toEqual([profileId]);
        // What a cancel puts back: the profile as it stood, and the enrolment
        // the soft delete closed.
        expect(JSON.parse(jobs[0].restore!)).toEqual({
          profiles: [{ id: profileId, handle: "alice", displayName: "Alice", avatarUrl: null }],
          enrollments: [enrolled[0].id],
        });
        expect(jobs[0].choices).toBeNull();

        // One hold per profile, by digest, pending until the hard delete.
        expect(yield* holdRows).toEqual([{ handle: digest("alice"), accountId, releaseAt: null }]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("holds every profile's handle and records each in the restore record", () =>
    Effect.gen(function* () {
      const { accountId, profileId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      const secondId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      yield* Effect.promise(() =>
        db.insert(users).values({
          id: secondId,
          accountId,
          handle: "alicework",
          displayName: null,
          avatarUrl: "https://cdn.example.com/a.png",
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });

      const [job] = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      const restore = JSON.parse(job!.restore!) as { profiles: { id: string }[] };
      expect(restore.profiles.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
        [
          { id: profileId, handle: "alice", displayName: "Alice", avatarUrl: null },
          {
            id: secondId,
            handle: "alicework",
            displayName: null,
            avatarUrl: "https://cdn.example.com/a.png",
          },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      );
      expect((yield* holdRows).map((r) => r.handle).toSorted()).toEqual(
        [digest("alice"), digest("alicework")].toSorted(),
      );
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("stores the choices it is given", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const choices = {
        "osn:organisation:org_a": { choice: "successor", successorProfileId: "usr_b" },
        "osn:organisation:org_c": { choice: "delete" },
      };

      yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
        choices,
      });

      const { db } = yield* Db;
      const [job] = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      expect(JSON.parse(job!.choices!)).toEqual(choices);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a released hold on the same handle does not stop the soft delete", () =>
    // Red on inserting the new hold without first removing the old row: the
    // primary key refuses the insert and the deletion can never be requested.
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(handleHolds).values({
          handle: digest("alice"),
          accountId: null,
          releaseAt: Math.floor(Date.now() / 1_000) - 60,
          createdAt: 1_000,
        }),
      );

      const result = yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
      });

      expect(result.newlyScheduled).toBe(true);
      expect(yield* holdRows).toEqual([{ handle: digest("alice"), accountId, releaseAt: null }]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "deletes the account's rotation records except the cancel handle's family, which keeps its reuse detection",
    () =>
      Effect.gen(function* () {
        const { accountId } = yield* seedAccountAndProfile();
        const { aliveSessionId, aliveFamilyId } = yield* seedCredentials(accountId);
        const { accountId: otherAccountId } = yield* seedAccountAndProfile(
          "bob@example.com",
          "bob",
        );
        const { db } = yield* Db;
        const [alive] = yield* Effect.promise(() =>
          db.select().from(sessions).where(eq(sessions.id, aliveSessionId)),
        );
        yield* seedRotated(accountId, alive!.familyId, "kept_");
        yield* seedRotated(accountId, "sfam_revoked", "gone_");
        yield* seedRotated(otherAccountId, "sfam_bob", "bob_");

        yield* accountErasure.requestErasure({
          accountId,
          cancel: { sessionId: aliveSessionId, familyId: aliveFamilyId },
          heldHandleDigest: digest,
        });

        const left = yield* Effect.promise(() => db.select().from(rotatedSessions));
        expect(left.map((r) => r.tokenHash).toSorted()).toEqual(["bob_1", "kept_1"]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "keeps the cancel handle's device when its session was renewed after the route's check",
    () =>
      // Red on sparing by the handle's hash at the delete: another tab's
      // renewal between the check and the sweep leaves that hash naming no row,
      // the sweep spares nothing, and the tombstoned account is left with no
      // session that could cancel the deletion.
      Effect.gen(function* () {
        const { accountId } = yield* seedAccountAndProfile("renewed@example.com", "renewed");
        const { aliveSessionId, aliveFamilyId } = yield* seedCredentials(accountId);
        const { db } = yield* Db;
        const now = Math.floor(Date.now() / 1_000);
        // The renewal: a new row in the same family replaces the checked one.
        const renewedId = "sha_" + crypto.randomUUID().replace(/-/g, "");
        yield* Effect.promise(() =>
          db.insert(sessions).values({
            id: renewedId,
            accountId,
            familyId: aliveFamilyId,
            expiresAt: now + 86_400,
            createdAt: now,
          }),
        );
        yield* Effect.promise(() => db.delete(sessions).where(eq(sessions.id, aliveSessionId)));

        yield* accountErasure.requestErasure({
          accountId,
          cancel: { sessionId: aliveSessionId, familyId: aliveFamilyId },
          heldHandleDigest: digest,
        });

        const left = yield* Effect.promise(() =>
          db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId)),
        );
        expect(left.map((r) => r.id)).toEqual([renewedId]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("deletes every rotation record of the account when there is no cancel handle", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* seedCredentials(accountId);
      yield* seedRotated(accountId, "sfam_a", "a_");
      yield* seedRotated(accountId, "sfam_b", "b_");

      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });

      const { db } = yield* Db;
      const left = yield* Effect.promise(() => db.select().from(rotatedSessions));
      expect(left).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("idempotent — second call returns the original scheduled timestamp", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const first = yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
      });
      const second = yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
      });
      expect(second.newlyScheduled).toBe(false);
      expect(second.scheduledFor).toBe(first.scheduledFor);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails AccountNotFoundError when the account does not exist", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        accountErasure.requestErasure({
          accountId: "acc_nonexistent",
          cancel: null,
          heldHandleDigest: digest,
        }),
      );
      expect(err._tag).toBe("AccountNotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "a soft delete that fails after its job insert answers the failure, not a pending deletion",
    () => {
      // On bun:sqlite the job insert has run when the tombstone fails; the job
      // alone does not mean a deletion was written.
      const { layer, sqlite } = createTestLayerWithSqlite();
      sqlite.run(
        "CREATE TRIGGER refuse_tombstone BEFORE UPDATE OF deleted_at ON accounts BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );
      return Effect.gen(function* () {
        const { accountId } = yield* seedAccountAndProfile();

        const err = yield* Effect.flip(
          accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest }),
        );

        expect(err._tag).toBe("AccountErasureDbError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a soft delete that fails at its redaction answers the failure, and so does a retry",
    () => {
      // Red on tombstoning before the redaction: on bun:sqlite the job and the
      // tombstone stand when the redaction fails, and the re-read answers a
      // deletion already pending while the profiles keep their names.
      const { layer, sqlite } = createTestLayerWithSqlite();
      sqlite.run(
        "CREATE TRIGGER refuse_redaction BEFORE UPDATE OF handle ON users BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );
      return Effect.gen(function* () {
        const { accountId } = yield* seedAccountAndProfile();

        const first = yield* Effect.flip(
          accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest }),
        );
        const retry = yield* Effect.flip(
          accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest }),
        );

        expect(first._tag).toBe("AccountErasureDbError");
        expect(retry._tag).toBe("AccountErasureDbError");
        expect((yield* accountRow(accountId))?.deletedAt).toBeNull();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a profile already holding another's redacted handle does not stop that one's soft delete, and a cancel puts it back",
    () =>
      // Red on redacting to `deleted_<suffix>` alone: the UNIQUE index on
      // `users.handle` refuses it, and the account can never be deleted.
      Effect.gen(function* () {
        const { accountId, profileId } = yield* seedAccountAndProfile();
        const suffix = profileId.replace("usr_", "");
        const squatter = yield* seedAccountAndProfile("squat@example.com", `deleted_${suffix}`);

        const result = yield* accountErasure.requestErasure({
          accountId,
          cancel: null,
          heldHandleDigest: digest,
        });

        expect(result.newlyScheduled).toBe(true);
        const { db } = yield* Db;
        const handleOf = (id: string) =>
          Effect.promise(async () => {
            const [row] = await db
              .select({ handle: users.handle })
              .from(users)
              .where(eq(users.id, id));
            return row?.handle;
          });
        const redacted = yield* handleOf(profileId);
        expect(redacted).toMatch(new RegExp(`^deleted_${suffix}_[0-9a-f]{8}$`));
        expect(redacted).toHaveLength(29);
        expect(yield* handleOf(squatter.profileId)).toBe(`deleted_${suffix}`);

        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
        expect(yield* handleOf(profileId)).toBe("alice");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("stores delete everything on the job", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
        deleteEverything: true,
      });
      const job = yield* jobRow(accountId);
      expect(job?.deleteEverything).toBe(true);
      expect(job?.choices).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "stores no answers when the deletion is of everything, whatever the caller passes",
    () =>
      Effect.gen(function* () {
        const { accountId } = yield* seedAccountAndProfile();
        yield* accountErasure.requestErasure({
          accountId,
          cancel: null,
          heldHandleDigest: digest,
          reason: "admin",
          deleteEverything: true,
          choices: { "osn:organisation:org_1": { choice: "delete" } },
        });
        const job = yield* jobRow(accountId);
        expect(job?.deleteEverything).toBe(true);
        expect(job?.choices).toBeNull();
      }).pipe(Effect.provide(createTestLayer())),
  );

  it("the database refuses a job that deletes everything and holds answers, on insert and on update", () => {
    const { sqlite } = createTestLayerWithSqlite();
    sqlite.run(
      "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES ('acc_pair', 'pair@example.com', 'pku_pair', 1, 1)",
    );
    const refusal = "a deletion job that deletes everything holds no choices";
    const add = sqlite.query(
      "INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at, delete_everything, choices) VALUES ('acc_pair', 1, 2, ?, ?)",
    );
    expect(() => add.run(1, "{}")).toThrow(refusal);
    add.run(1, null);
    expect(() =>
      sqlite.run("UPDATE deletion_jobs SET choices = '{}' WHERE account_id = 'acc_pair'"),
    ).toThrow(refusal);
    sqlite.run(
      "UPDATE deletion_jobs SET delete_everything = 0, choices = '{}' WHERE account_id = 'acc_pair'",
    );
    expect(() =>
      sqlite.run("UPDATE deletion_jobs SET delete_everything = 1 WHERE account_id = 'acc_pair'"),
    ).toThrow(refusal);
  });
});

describe("account-erasure: cancelErasure", () => {
  it.effect("clears the deletion job and accounts.deletedAt", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });

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

  /** The profile's handle, display name and avatar. */
  const profileOf = (profileId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [row] = yield* Effect.promise(() =>
        db
          .select({
            handle: users.handle,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(eq(users.id, profileId)),
      );
      return row;
    });

  /** The account's enrolments, by app: open (`null`) or the time they closed. */
  const enrolmentsOf = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db
          .select({ id: appEnrollments.id, app: appEnrollments.app, leftAt: appEnrollments.leftAt })
          .from(appEnrollments)
          .where(eq(appEnrollments.accountId, accountId)),
      );
      return rows.toSorted((a, b) => a.id.localeCompare(b.id));
    });

  /** A profile row on `accountId`, inserted directly. */
  const insertProfile = (accountId: string, handle: string, displayName: string | null = null) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const id = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      yield* Effect.promise(() =>
        db.insert(users).values({
          id,
          accountId,
          handle,
          displayName,
          avatarUrl: null,
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      return id;
    });

  it.effect(
    "puts back each profile's handle, display name and avatar, reopens the enrolments the deletion closed, and releases the holds",
    () =>
      Effect.gen(function* () {
        const { accountId, profileId } = yield* seedAccountAndProfile();
        yield* seedCredentials(accountId);
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .update(users)
            .set({ avatarUrl: "https://cdn.example.com/alice.png" })
            .where(eq(users.id, profileId)),
        );
        // Zap was left before the deletion; only Pulse was open.
        yield* appEnroll.joinApp(accountId, "zap");
        yield* appEnroll.leaveApp(accountId, "zap");
        yield* appEnroll.joinApp(accountId, "pulse");
        const before = yield* enrolmentsOf(accountId);
        yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });

        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

        expect(yield* profileOf(profileId)).toEqual({
          handle: "alice",
          displayName: "Alice",
          avatarUrl: "https://cdn.example.com/alice.png",
        });
        expect(yield* enrolmentsOf(accountId)).toEqual(before);
        expect(yield* holdRows).toEqual([]);
        // The credentials the deletion kept still belong to the account.
        expect(yield* credentialCounts(accountId)).toEqual({
          passkeys: 1,
          recoveryCodes: 1,
          totp: 1,
        });
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a job written before the restore record existed cancels as before", () =>
    Effect.gen(function* () {
      const { accountId, profileId } = yield* seedAccountAndProfile();
      yield* appEnroll.joinApp(accountId, "pulse");
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.update(deletionJobs).set({ restore: null }).where(eq(deletionJobs.accountId, accountId)),
      );

      expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

      const [acct] = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, accountId)),
      );
      expect(acct!.deletedAt).toBeNull();
      // Nothing to put back from: the profile keeps its redacted form and the
      // enrolment stays closed.
      expect((yield* profileOf(profileId))!.handle).toBe(
        `deleted_${profileId.replace("usr_", "")}`,
      );
      expect((yield* enrolmentsOf(accountId))[0]!.leftAt).not.toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "a handle taken by a profile or an organisation since stays redacted, and the rest come back",
    () =>
      Effect.gen(function* () {
        const { accountId, profileId } = yield* seedAccountAndProfile();
        const secondId = yield* insertProfile(accountId, "alicetwo", "Two");
        const thirdId = yield* insertProfile(accountId, "alicethree", "Three");
        yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
        // Taken past the holds, as a profile made between the soft delete's
        // read and its batch would be.
        const other = yield* seedAccountAndProfile("bob@example.com", "alice");
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db.insert(organisations).values({
            id: "org_takentwo",
            handle: "alicetwo",
            name: "Two Org",
            ownerId: other.profileId,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );

        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

        expect((yield* profileOf(profileId))!.handle).toBe(
          `deleted_${profileId.replace("usr_", "")}`,
        );
        expect((yield* profileOf(secondId))!.handle).toBe(
          `deleted_${secondId.replace("usr_", "")}`,
        );
        expect(yield* profileOf(thirdId)).toEqual({
          handle: "alicethree",
          displayName: "Three",
          avatarUrl: null,
        });
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "leaves a profile the record does not name, and one whose handle is no longer the redacted one",
    () =>
      Effect.gen(function* () {
        const { accountId, profileId } = yield* seedAccountAndProfile();
        const unnamedId = yield* insertProfile(accountId, "aliceunnamed", "Unnamed");
        const renamedId = yield* insertProfile(accountId, "alicerenamed", "Renamed");
        yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
        const { db } = yield* Db;
        const [job] = yield* Effect.promise(() =>
          db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
        );
        const record = JSON.parse(job!.restore!) as { profiles: { id: string }[] };
        record.profiles = record.profiles.filter((p) => p.id !== unnamedId);
        yield* Effect.promise(() =>
          db
            .update(deletionJobs)
            .set({ restore: JSON.stringify(record) })
            .where(eq(deletionJobs.accountId, accountId)),
        );
        yield* Effect.promise(() =>
          db.update(users).set({ handle: "someoneelse" }).where(eq(users.id, renamedId)),
        );

        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

        expect((yield* profileOf(unnamedId))!.handle).toBe(
          `deleted_${unnamedId.replace("usr_", "")}`,
        );
        expect(yield* profileOf(renamedId)).toEqual({
          handle: "someoneelse",
          displayName: null,
          avatarUrl: null,
        });
        expect((yield* profileOf(profileId))!.handle).toBe("alice");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "reopens only an enrolment still closed at the deletion's time, with no other open row in its app",
    () =>
      Effect.gen(function* () {
        const { accountId } = yield* seedAccountAndProfile();
        yield* appEnroll.joinApp(accountId, "pulse");
        yield* appEnroll.joinApp(accountId, "zap");
        yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
        const { db } = yield* Db;
        const closed = yield* enrolmentsOf(accountId);
        const zap = closed.find((e) => e.app === "zap")!;
        // Zap's row closed again at another time; Pulse opened a new row.
        yield* Effect.promise(() =>
          db.update(appEnrollments).set({ leftAt: 1 }).where(eq(appEnrollments.id, zap.id)),
        );
        yield* appEnroll.joinApp(accountId, "pulse");

        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

        const after = yield* enrolmentsOf(accountId);
        expect(after.filter((e) => e.app === "pulse" && e.leftAt === null)).toHaveLength(1);
        expect(after.find((e) => e.id === zap.id)!.leftAt).toBe(1);
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
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
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
          cireDoneAt: 1_500,
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
          cireDoneAt: 1_500,
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
          cireDoneAt: 1_500,
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

  it.effect("deletes the account's rotation records with the account, and no one else's", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      const { accountId: otherAccountId } = yield* seedAccountAndProfile("bob@example.com", "bob");
      const { db } = yield* Db;
      yield* seedRotated(accountId, "sfam_a", "a_");
      yield* seedRotated(accountId, "sfam_b", "b_");
      yield* seedRotated(otherAccountId, "sfam_bob", "bob_");
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          cireDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
        }),
      );

      // The account row goes in the same batch: a rotation record left behind
      // would fail it on the foreign key.
      const result = yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });

      expect(result.purged).toBe(1);
      const acct = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, accountId)),
      );
      expect(acct).toHaveLength(0);
      const left = yield* Effect.promise(() => db.select().from(rotatedSessions));
      expect(left.map((r) => r.tokenHash)).toEqual(["bob_1"]);
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
          cireDoneAt: 1_500,
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
          cireDoneAt: 1_500,
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

/**
 * The organisations an erased account owns, at its hard delete. Each passes to
 * the named successor while that profile is still a member from another
 * account, else to the longest-standing other admin, else to the
 * longest-standing other member (promoted to admin), else it is deleted with
 * its memberships; a `delete` choice deletes it whoever is left. The
 * account's own other profiles are never chosen. Each case goes through the
 * soft delete, so the choices are the ones it stored.
 */
describe("account-erasure: owned organisations at hard delete", () => {
  type Member = { profileId: string; role: "admin" | "member"; joined: number };

  /** An organisation owned by `ownerId`: the owner's admin row, joined at second 1, then `members`. */
  const seedOrganisation = (ownerId: string, handle: string, members: ReadonlyArray<Member>) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const orgId = "org_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      yield* Effect.promise(() =>
        db.insert(organisations).values({
          id: orgId,
          handle,
          name: `Org ${handle}`,
          ownerId,
          createdAt: new Date(1_000),
          updatedAt: new Date(1_000),
        }),
      );
      for (const m of [{ profileId: ownerId, role: "admin" as const, joined: 1 }, ...members]) {
        yield* Effect.promise(() =>
          db.insert(organisationMembers).values({
            id: "orgm_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
            organisationId: orgId,
            profileId: m.profileId,
            role: m.role,
            createdAt: new Date(m.joined * 1_000),
          }),
        );
      }
      return orgId;
    });

  /** A second profile on `accountId`. */
  const secondProfile = (accountId: string, handle: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const id = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      yield* Effect.promise(() =>
        db.insert(users).values({
          id,
          accountId,
          handle,
          displayName: null,
          avatarUrl: null,
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      return id;
    });

  /** The organisation's owner and members, or `null` once it is gone. */
  const orgState = (orgId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [org] = yield* Effect.promise(() =>
        db
          .select({ ownerId: organisations.ownerId })
          .from(organisations)
          .where(eq(organisations.id, orgId)),
      );
      const members = yield* Effect.promise(() =>
        db
          .select({ profileId: organisationMembers.profileId, role: organisationMembers.role })
          .from(organisationMembers)
          .where(eq(organisationMembers.organisationId, orgId)),
      );
      if (!org) return { gone: true, members: members.length };
      return {
        ownerId: org.ownerId,
        members: members.toSorted((a, b) => a.profileId.localeCompare(b.profileId)),
      };
    });

  const membersOf = (...members: Array<{ profileId: string; role: "admin" | "member" }>) =>
    members.toSorted((a, b) => a.profileId.localeCompare(b.profileId));

  /**
   * Soft-deletes the account with `choices`, then hard-deletes it once its
   * window closes. The account holds a passkey, a recovery code and an
   * authenticator, as a real one does; the soft delete keeps them, and the
   * hard delete leaves none.
   */
  const purge = (accountId: string, choices?: accountErasure.ErasureChoices) =>
    Effect.gen(function* () {
      yield* seedCredentials(accountId);
      yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
        choices,
      });
      yield* everyAppDone(accountId);
      const { db } = yield* Db;
      const [job] = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      );
      const result = yield* accountErasure.hardDeleteAccount(job!, job!.hardDeleteAt);
      expect(yield* credentialCounts(accountId)).toEqual({
        passkeys: 0,
        recoveryCodes: 0,
        totp: 0,
      });
      return result;
    });

  const action = (orgId: string) => `osn:organisation:${orgId}`;

  it.effect("passes to the longest-standing other admin, with no choice needed", () =>
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      const carol = yield* seedAccountAndProfile("carol@example.com", "carol");
      const dave = yield* seedAccountAndProfile("dave@example.com", "dave");
      const eve = yield* seedAccountAndProfile("eve@example.com", "eve");
      const orgId = yield* seedOrganisation(alice.profileId, "acme", [
        // The longest-standing member is passed over for an admin.
        { profileId: bob.profileId, role: "member", joined: 10 },
        { profileId: carol.profileId, role: "admin", joined: 30 },
        { profileId: dave.profileId, role: "admin", joined: 20 },
      ]);
      // An organisation alice only belongs to keeps its owner.
      const evesOrg = yield* seedOrganisation(eve.profileId, "evecorp", [
        { profileId: alice.profileId, role: "admin", joined: 5 },
      ]);

      const result = yield* purge(alice.accountId);

      expect(result).toEqual({
        deleted: true,
        transfers: [{ orgId, ownerProfileId: dave.profileId }],
        orgsDeleted: 0,
      });
      expect(yield* orgState(orgId)).toEqual({
        ownerId: dave.profileId,
        members: membersOf(
          { profileId: bob.profileId, role: "member" },
          { profileId: carol.profileId, role: "admin" },
          { profileId: dave.profileId, role: "admin" },
        ),
      });
      expect(yield* orgState(evesOrg)).toEqual({
        ownerId: eve.profileId,
        members: [{ profileId: eve.profileId, role: "admin" }],
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "with no other admin and a confirmed transfer, passes to the longest-standing member, made admin",
    () =>
      Effect.gen(function* () {
        const alice = yield* seedAccountAndProfile();
        const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
        const carol = yield* seedAccountAndProfile("carol@example.com", "carol");
        const orgId = yield* seedOrganisation(alice.profileId, "acme", [
          { profileId: bob.profileId, role: "member", joined: 20 },
          { profileId: carol.profileId, role: "member", joined: 10 },
        ]);

        const result = yield* purge(alice.accountId, { [action(orgId)]: { choice: "transfer" } });

        expect(result.transfers).toEqual([{ orgId, ownerProfileId: carol.profileId }]);
        expect(yield* orgState(orgId)).toEqual({
          ownerId: carol.profileId,
          members: membersOf(
            { profileId: bob.profileId, role: "member" },
            { profileId: carol.profileId, role: "admin" },
          ),
        });
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("with no choice stored, still passes to the longest-standing member", () =>
    // The admins who made a choice unnecessary can leave during the window;
    // the hard delete then applies the same rules, with no one left to ask.
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      const orgId = yield* seedOrganisation(alice.profileId, "acme", [
        { profileId: bob.profileId, role: "member", joined: 20 },
      ]);

      const result = yield* purge(alice.accountId);

      expect(result.transfers).toEqual([{ orgId, ownerProfileId: bob.profileId }]);
      expect(yield* orgState(orgId)).toEqual({
        ownerId: bob.profileId,
        members: [{ profileId: bob.profileId, role: "admin" }],
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("with no other member, is deleted with its memberships", () =>
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const orgId = yield* seedOrganisation(alice.profileId, "acme", []);

      const result = yield* purge(alice.accountId, { [action(orgId)]: { choice: "delete" } });

      expect(result).toEqual({ deleted: true, transfers: [], orgsDeleted: 1 });
      expect(yield* orgState(orgId)).toEqual({ gone: true, members: 0 });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("passes to a named successor who is still a member, ahead of an admin", () =>
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      const carol = yield* seedAccountAndProfile("carol@example.com", "carol");
      const orgId = yield* seedOrganisation(alice.profileId, "acme", [
        { profileId: bob.profileId, role: "admin", joined: 10 },
        { profileId: carol.profileId, role: "member", joined: 20 },
      ]);

      const result = yield* purge(alice.accountId, {
        [action(orgId)]: { choice: "successor", successorProfileId: carol.profileId },
      });

      expect(result.transfers).toEqual([{ orgId, ownerProfileId: carol.profileId }]);
      expect(yield* orgState(orgId)).toEqual({
        ownerId: carol.profileId,
        members: membersOf(
          { profileId: bob.profileId, role: "admin" },
          { profileId: carol.profileId, role: "admin" },
        ),
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a named successor who has left gives way to the longest-standing other admin", () =>
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      const carol = yield* seedAccountAndProfile("carol@example.com", "carol");
      const orgId = yield* seedOrganisation(alice.profileId, "acme", [
        { profileId: bob.profileId, role: "admin", joined: 10 },
        { profileId: carol.profileId, role: "member", joined: 20 },
      ]);
      yield* accountErasure.requestErasure({
        accountId: alice.accountId,
        cancel: null,
        heldHandleDigest: digest,
        choices: {
          [action(orgId)]: { choice: "successor", successorProfileId: carol.profileId },
        },
      });
      yield* everyAppDone(alice.accountId);
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db
          .delete(organisationMembers)
          .where(
            and(
              eq(organisationMembers.organisationId, orgId),
              eq(organisationMembers.profileId, carol.profileId),
            ),
          ),
      );
      const [job] = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, alice.accountId)),
      );

      const result = yield* accountErasure.hardDeleteAccount(job!, job!.hardDeleteAt);

      expect(result.transfers).toEqual([{ orgId, ownerProfileId: bob.profileId }]);
      expect((yield* orgState(orgId)).ownerId).toBe(bob.profileId);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a delete choice deletes it even with another admin", () =>
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      const orgId = yield* seedOrganisation(alice.profileId, "acme", [
        { profileId: bob.profileId, role: "admin", joined: 10 },
      ]);

      const result = yield* purge(alice.accountId, { [action(orgId)]: { choice: "delete" } });

      expect(result).toEqual({ deleted: true, transfers: [], orgsDeleted: 1 });
      expect(yield* orgState(orgId)).toEqual({ gone: true, members: 0 });
      const { db } = yield* Db;
      const bobRows = yield* Effect.promise(() =>
        db.select().from(users).where(eq(users.id, bob.profileId)),
      );
      expect(bobRows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("never chooses another profile of the same account", () =>
    Effect.gen(function* () {
      const alice = yield* seedAccountAndProfile();
      const aliceWork = yield* secondProfile(alice.accountId, "alicework");
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      // alice's other profile is the longest-standing admin; bob is the only
      // member from another account.
      const shared = yield* seedOrganisation(alice.profileId, "acme", [
        { profileId: aliceWork, role: "admin", joined: 5 },
        { profileId: bob.profileId, role: "member", joined: 50 },
      ]);
      // Owned by the other profile, with no one from another account in it.
      const solo = yield* seedOrganisation(aliceWork, "solo", [
        { profileId: alice.profileId, role: "admin", joined: 5 },
      ]);

      // Named as successor too, past the route's check, and still passed over.
      const result = yield* purge(alice.accountId, {
        [action(shared)]: { choice: "successor", successorProfileId: aliceWork },
      });

      expect(result).toEqual({
        deleted: true,
        transfers: [{ orgId: shared, ownerProfileId: bob.profileId }],
        orgsDeleted: 1,
      });
      expect(yield* orgState(shared)).toEqual({
        ownerId: bob.profileId,
        members: [{ profileId: bob.profileId, role: "admin" }],
      });
      expect(yield* orgState(solo)).toEqual({ gone: true, members: 0 });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("counts each organisation passed on and each deleted", () =>
    Effect.gen(function* () {
      const organisation = vi.spyOn(metrics, "metricAccountDeletionOrganisation");
      const alice = yield* seedAccountAndProfile();
      const bob = yield* seedAccountAndProfile("bob@example.com", "bob");
      yield* seedOrganisation(alice.profileId, "kept", [
        { profileId: bob.profileId, role: "admin", joined: 10 },
      ]);
      yield* seedOrganisation(alice.profileId, "gone", []);
      yield* accountErasure.requestErasure({
        accountId: alice.accountId,
        cancel: null,
        heldHandleDigest: digest,
      });
      yield* everyAppDone(alice.accountId);
      const { db } = yield* Db;
      const [job] = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, alice.accountId)),
      );

      yield* accountErasure.runHardDeleteSweep({ nowMs: (job!.hardDeleteAt + 1) * 1_000 });

      expect(organisation.mock.calls.toSorted()).toEqual([
        ["deleted", 1],
        ["transferred", 1],
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

/**
 * One account whose hard delete fails does not hold up the rest: the sweep
 * counts and logs the failure, stamps the job, and carries on; the next pass
 * reads jobs that never failed before it.
 */
describe("account-erasure: hard-delete sweep isolation", () => {
  const capture = () => {
    const lines: { level: string; message: unknown }[] = [];
    const layer = Logger.layer([
      Logger.map(Logger.formatStructured, (line) => {
        lines.push(line);
      }),
    ]);
    return { lines, layer };
  };

  /** A job past its window with both bridges done, and `choices` as stored. */
  const dueJob = (accountId: string, hardDeleteAt: number, choices: string | null = null) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId,
          softDeletedAt: 1_000,
          hardDeleteAt,
          pulseDoneAt: 1_500,
          zapDoneAt: 1_500,
          cireDoneAt: 1_500,
          reason: "user_request",
          cancelSessionId: null,
          choices,
        }),
      );
    });

  const accountExists = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)),
      );
      return rows.length === 1;
    });

  it.effect(
    "a failed account is counted, logged without ids and stamped, the next is purged, and the next pass reads it last",
    () => {
      const log = capture();
      return Effect.gen(function* () {
        const completed = vi.spyOn(metrics, "metricAccountDeletionCompleted");
        // Its window closed first, so a read by window alone meets it first.
        const broken = yield* seedAccountAndProfile("broken@example.com", "broken");
        yield* dueJob(broken.accountId, 2_000, "{not json");
        const fine = yield* seedAccountAndProfile("fine@example.com", "fine");
        yield* dueJob(fine.accountId, 3_000);

        expect(yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 })).toEqual({
          purged: 1,
        });

        expect(yield* accountExists(fine.accountId)).toBe(false);
        expect(yield* accountExists(broken.accountId)).toBe(true);
        expect(completed.mock.calls).toEqual([
          ["hard_failed", "sweeper"],
          ["hard", "sweeper"],
        ]);
        const { db } = yield* Db;
        const [job] = yield* Effect.promise(() =>
          db.select().from(deletionJobs).where(eq(deletionJobs.accountId, broken.accountId)),
        );
        expect(job!.hardDeleteFailedAt).toBe(5_000);
        expect(job!.purgeStartedAt).toBeNull();
        const failures = log.lines.filter((line) =>
          JSON.stringify(line.message).includes("account.deletion hard delete failed"),
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]!.level).toBe("ERROR");
        const written = JSON.stringify(log.lines);
        for (const id of [broken.accountId, broken.profileId, fine.accountId]) {
          expect(written).not.toContain(id);
        }

        // A job that never failed, whose window closed after the failed one's.
        const later = yield* seedAccountAndProfile("later@example.com", "later");
        yield* dueJob(later.accountId, 4_000);

        expect(
          yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000, batchSize: 1 }),
        ).toEqual({ purged: 1 });
        expect(yield* accountExists(later.accountId)).toBe(false);
        expect(yield* accountExists(broken.accountId)).toBe(true);
      }).pipe(Effect.provide(createTestLayer()), Effect.provide(log.layer));
    },
  );

  it.effect(
    "a pass stops after three hard deletes fail in a row, and says so once, at warning, with no ids",
    () => {
      // Red on going on after every failure: a cap or an outage would spend a
      // claim, a stamp and a false failure count on every job left.
      const log = capture();
      return Effect.gen(function* () {
        const completed = vi.spyOn(metrics, "metricAccountDeletionCompleted");
        const broken = [];
        for (const n of [1, 2, 3, 4]) {
          const account = yield* seedAccountAndProfile(`broken${n}@example.com`, `broken${n}`);
          yield* dueJob(account.accountId, 2_000 + n, "{not json");
          broken.push(account);
        }
        const fine = yield* seedAccountAndProfile("fine@example.com", "fine");
        yield* dueJob(fine.accountId, 3_000);

        expect(yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 })).toEqual({
          purged: 0,
        });

        expect(completed.mock.calls).toEqual([
          ["hard_failed", "sweeper"],
          ["hard_failed", "sweeper"],
          ["hard_failed", "sweeper"],
        ]);
        expect(yield* accountExists(fine.accountId)).toBe(true);
        expect((yield* jobRow(broken[3]!.accountId))?.hardDeleteFailedAt).toBeNull();
        const stopped = log.lines.filter((line) =>
          JSON.stringify(line.message).includes("account.deletion hard delete sweep stopped"),
        );
        expect(stopped).toHaveLength(1);
        expect(stopped[0]!.level).toBe("WARN");
        const written = JSON.stringify(log.lines);
        for (const account of [...broken, fine]) {
          expect(written).not.toContain(account.accountId);
        }
      }).pipe(Effect.provide(createTestLayer()), Effect.provide(log.layer));
    },
  );

  it.effect("a failure to stamp the failed job is logged, and the pass goes on", () => {
    const log = capture();
    const { layer, sqlite } = createTestLayerWithSqlite();
    sqlite.run(
      "CREATE TRIGGER refuse_stamp BEFORE UPDATE OF hard_delete_failed_at ON deletion_jobs BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    return Effect.gen(function* () {
      const broken = yield* seedAccountAndProfile("broken@example.com", "broken");
      yield* dueJob(broken.accountId, 2_000, "{not json");
      const fine = yield* seedAccountAndProfile("fine@example.com", "fine");
      yield* dueJob(fine.accountId, 3_000);

      expect(yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 })).toEqual({
        purged: 1,
      });

      expect(yield* accountExists(fine.accountId)).toBe(false);
      expect(
        log.lines.filter((line) =>
          JSON.stringify(line.message).includes(
            "account.deletion hard delete failure not recorded",
          ),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provide(log.layer));
  });
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
      const result = yield* accountErasure.runFanOutRetrySweep({
        nowMs,
        config: NO_DELETION_APPS,
      });
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
  /** The apps `accountId` has an open enrolment in. */
  const openApps = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db
          .select({ app: appEnrollments.app })
          .from(appEnrollments)
          .where(and(eq(appEnrollments.accountId, accountId), isNull(appEnrollments.leftAt))),
      );
      return rows.map((row) => row.app);
    });

  it.effect("joinApp + leaveApp lifecycle", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      // Initially nothing.
      expect(yield* openApps(accountId)).toEqual([]);
      // Join Pulse (idempotent on second call).
      const r1 = yield* appEnroll.joinApp(accountId, "pulse");
      expect(r1.enrolled).toBe(true);
      const r2 = yield* appEnroll.joinApp(accountId, "pulse");
      expect(r2.enrolled).toBe(false);
      expect(yield* openApps(accountId)).toEqual(["pulse"]);
      // Leave.
      const left = yield* appEnroll.leaveApp(accountId, "pulse");
      expect(left.closed).toBe(true);
      expect(yield* openApps(accountId)).toEqual([]);
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

  it.effect("joinApp writes nothing for an account whose deletion is pending", () =>
    // Red on inserting with no look at the account: the open row lands after
    // the soft delete closed the enrolments and marked the bridges, so
    // neither the job nor a cancel knows of it.
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });

      expect(yield* appEnroll.joinApp(accountId, "pulse")).toEqual({ enrolled: false });

      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select().from(appEnrollments).where(eq(appEnrollments.accountId, accountId)),
      );
      expect(rows).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a join refused during the window leaves the job as it is", () =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile();
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
      const before = yield* jobRow(accountId);
      expect(yield* appEnroll.joinApp(accountId, "pulse")).toEqual({ enrolled: false });
      expect(yield* jobRow(accountId)).toEqual(before);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

/**
 * A cancel and a purge sweep that meet at the end of the grace window. Once a
 * sweep has claimed the account the cancel is refused, as one past the window
 * is; a cancel that lands first leaves the sweep nothing to purge. The bridges
 * answer from a local server that counts the purges it is sent.
 */
describe("account-erasure: a cancel and a purge", () => {
  const apps = appStandIns();
  const config = apps.config();

  afterAll(() => apps.stop());

  const purgesOf = (accountId: string) =>
    apps.calls.filter(
      (call) => call.path === "/internal/account-deleted" && call.body.accountId === accountId,
    ).length;

  /**
   * An account scheduled for erasure: every app still pending when
   * `appsPending`, else every app done, so the hard delete may claim it.
   */
  const scheduled = (handle: string, appsPending: boolean) =>
    Effect.gen(function* () {
      const { accountId } = yield* seedAccountAndProfile(`${handle}@example.com`, handle);
      const { scheduledFor } = yield* accountErasure.requestErasure({
        accountId,
        cancel: null,
        heldHandleDigest: digest,
      });
      if (!appsPending) {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .update(deletionJobs)
            .set({
              pulseDoneAt: 1_700_000_000,
              zapDoneAt: 1_700_000_000,
              cireDoneAt: 1_700_000_000,
            })
            .where(eq(deletionJobs.accountId, accountId)),
        );
      }
      return { accountId, pastWindowMs: (scheduledFor + 1) * 1_000 };
    });

  const cancelEvents = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      return yield* Effect.promise(() =>
        db
          .select()
          .from(securityEvents)
          .where(
            and(
              eq(securityEvents.accountId, accountId),
              eq(securityEvents.kind, "account_deletion_cancelled"),
            ),
          ),
      );
    });

  it.live("a cancel held at its delete while the fan-out claims and purges is refused", () => {
    const h = held();
    return Effect.gen(function* () {
      const { accountId, pastWindowMs } = yield* scheduled("ce1", true);

      const remove = h.hold(/^delete from "deletion_jobs"/);
      const cancel = yield* Effect.forkChild(
        Effect.result(accountErasure.cancelErasure(accountId)),
      );
      yield* Effect.promise(() => remove.reached);
      yield* accountErasure.runFanOutRetrySweep({ nowMs: pastWindowMs, config });
      expect(purgesOf(accountId)).toBe(3);
      remove.release();

      expect(yield* Fiber.join(cancel)).toMatchObject({
        _tag: "Success",
        success: { cancelled: false },
      });
      expect((yield* accountRow(accountId))?.deletedAt).not.toBeNull();
      expect((yield* jobRow(accountId))?.purgeStartedAt).toBeGreaterThan(0);
      expect(yield* cancelEvents(accountId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a cancel that lands while the fan-out is held before its claim stops the purge", () => {
    const h = held();
    return Effect.gen(function* () {
      const { accountId, pastWindowMs } = yield* scheduled("ce2", true);

      // The fan-out reads the job, then claims it: held at the claim.
      const claim = h.hold(/^update "deletion_jobs" set "purge_started_at"/);
      const sweep = yield* Effect.forkChild(
        accountErasure.runFanOutRetrySweep({ nowMs: pastWindowMs, config }),
      );
      yield* Effect.promise(() => claim.reached);
      expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
      claim.release();
      yield* Fiber.join(sweep);

      expect(purgesOf(accountId)).toBe(0);
      expect((yield* accountRow(accountId))?.deletedAt).toBeNull();
      expect(yield* jobRow(accountId)).toBeUndefined();
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a cancel held at its delete while the hard delete runs is refused", () => {
    const h = held();
    return Effect.gen(function* () {
      const { accountId, pastWindowMs } = yield* scheduled("ce3", false);

      const remove = h.hold(/^delete from "deletion_jobs"/);
      const cancel = yield* Effect.forkChild(
        Effect.result(accountErasure.cancelErasure(accountId)),
      );
      yield* Effect.promise(() => remove.reached);
      expect(yield* accountErasure.runHardDeleteSweep({ nowMs: pastWindowMs })).toEqual({
        purged: 1,
      });
      remove.release();

      expect(yield* Fiber.join(cancel)).toMatchObject({
        _tag: "Success",
        success: { cancelled: false },
      });
      expect(yield* accountRow(accountId)).toBeUndefined();
      expect(yield* cancelEvents(accountId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "a cancel that lands while the hard delete is held before its claim keeps the account",
    () => {
      const h = held();
      return Effect.gen(function* () {
        const { accountId, pastWindowMs } = yield* scheduled("ce4", false);

        // The hard delete reads nothing before its claim: held at the claim.
        const claim = h.hold(/^update "deletion_jobs" set "purge_started_at"/);
        const sweep = yield* Effect.forkChild(
          accountErasure.runHardDeleteSweep({ nowMs: pastWindowMs }),
        );
        yield* Effect.promise(() => claim.reached);
        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
        claim.release();

        expect(yield* Fiber.join(sweep)).toEqual({ purged: 0 });
        expect((yield* accountRow(accountId))?.deletedAt).toBeNull();
      }).pipe(Effect.provide(h.layer));
    },
  );

  /** The account's job as a request one second after this one would have written it. */
  const asIfRequestedLater = (accountId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const job = (yield* jobRow(accountId))!;
      yield* Effect.promise(() =>
        db
          .update(deletionJobs)
          .set({ softDeletedAt: job.softDeletedAt + 1 })
          .where(eq(deletionJobs.accountId, accountId)),
      );
    });

  const EVENT_ID = /^sev_[a-f0-9]{12}$/;

  it.live("of two cancels of one job, the second writes nothing", () => {
    const h = held();
    return Effect.gen(function* () {
      const { accountId } = yield* scheduled("ce5", false);

      const remove = h.hold(/^delete from "deletion_jobs"/);
      const second = yield* Effect.forkChild(
        Effect.result(accountErasure.cancelErasure(accountId)),
      );
      yield* Effect.promise(() => remove.reached);
      expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
      remove.release();

      expect(yield* Fiber.join(second)).toMatchObject({
        _tag: "Success",
        success: { cancelled: false },
      });
      const events = yield* cancelEvents(accountId);
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toMatch(EVENT_ID);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a cancel that read a job since cancelled and asked for again leaves the new one", () => {
    const h = held();
    return Effect.gen(function* () {
      const { accountId } = yield* scheduled("ce6", false);

      const remove = h.hold(/^delete from "deletion_jobs"/);
      const stale = yield* Effect.forkChild(Effect.result(accountErasure.cancelErasure(accountId)));
      yield* Effect.promise(() => remove.reached);
      expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
      yield* asIfRequestedLater(accountId);
      remove.release();

      expect(yield* Fiber.join(stale)).toMatchObject({
        _tag: "Success",
        success: { cancelled: false },
      });
      expect(yield* jobRow(accountId)).toBeDefined();
      expect((yield* accountRow(accountId))?.deletedAt).not.toBeNull();
      expect(yield* cancelEvents(accountId)).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "a cancel of a job replaced since puts back no profile, releases no hold and reopens nothing",
    () => {
      const h = held();
      return Effect.gen(function* () {
        const { accountId } = yield* scheduled("ce8", true);

        const remove = h.hold(/^delete from "deletion_jobs"/);
        const stale = yield* Effect.forkChild(
          Effect.result(accountErasure.cancelErasure(accountId)),
        );
        yield* Effect.promise(() => remove.reached);
        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
        yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
        yield* asIfRequestedLater(accountId);
        const { db } = yield* Db;
        const snapshot = () =>
          Effect.promise(async () => ({
            profiles: await db
              .select({ handle: users.handle, displayName: users.displayName })
              .from(users)
              .where(eq(users.accountId, accountId)),
            holds: await db
              .select({ accountId: handleHolds.accountId })
              .from(handleHolds)
              .where(eq(handleHolds.accountId, accountId)),
            open: await db
              .select({ id: appEnrollments.id })
              .from(appEnrollments)
              .where(and(eq(appEnrollments.accountId, accountId), isNull(appEnrollments.leftAt))),
          }));
        const replaced = yield* snapshot();
        expect(replaced.profiles[0]!.handle).toMatch(/^deleted_/);
        expect(replaced.holds).toHaveLength(1);
        expect(replaced.open).toEqual([]);
        remove.release();

        expect(yield* Fiber.join(stale)).toMatchObject({
          _tag: "Success",
          success: { cancelled: false },
        });
        expect(yield* snapshot()).toEqual(replaced);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("each job's cancel writes its own event", () => {
    const h = held();
    return Effect.gen(function* () {
      const { accountId } = yield* scheduled("ce7", false);
      expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
      yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
      yield* asIfRequestedLater(accountId);
      expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

      const ids = (yield* cancelEvents(accountId)).map((event) => event.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) expect(id).toMatch(EVENT_ID);
    }).pipe(Effect.provide(h.layer));
  });

  /** Runs `effect` with `Date` frozen at one instant, so every write lands in one second. */
  const inOneSecond = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
      }),
      () => effect,
      () => Effect.sync(() => vi.useRealTimers()),
    );

  it.live(
    "a cancel that read a job since cancelled and asked for again in the same second leaves the new one",
    () => {
      // Red on naming the job by its `soft_deleted_at`: the new job shares the
      // second, so the stale cancel's delete removes it and clears the
      // tombstone of a deletion the person asked for after that cancel.
      const h = held();
      return inOneSecond(
        Effect.gen(function* () {
          const { accountId } = yield* scheduled("ce9", false);

          const remove = h.hold(/^delete from "deletion_jobs"/);
          const stale = yield* Effect.forkChild(
            Effect.result(accountErasure.cancelErasure(accountId)),
          );
          yield* Effect.promise(() => remove.reached);
          expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
          yield* accountErasure.requestErasure({
            accountId,
            cancel: null,
            heldHandleDigest: digest,
          });
          remove.release();

          expect(yield* Fiber.join(stale)).toMatchObject({
            _tag: "Success",
            success: { cancelled: false },
          });
          expect(yield* jobRow(accountId)).toBeDefined();
          expect((yield* accountRow(accountId))?.deletedAt).not.toBeNull();
          expect(yield* cancelEvents(accountId)).toHaveLength(1);
        }),
      ).pipe(Effect.provide(h.layer));
    },
  );

  it.live("the cancels of two jobs asked for in the same second each write an event", () => {
    // Red on deriving the event's id from `soft_deleted_at`: the second job's
    // cancel finds the first's id taken and records nothing.
    const h = held();
    return inOneSecond(
      Effect.gen(function* () {
        const { accountId } = yield* scheduled("ce10", false);
        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });
        yield* accountErasure.requestErasure({ accountId, cancel: null, heldHandleDigest: digest });
        expect(yield* accountErasure.cancelErasure(accountId)).toEqual({ cancelled: true });

        const ids = (yield* cancelEvents(accountId)).map((event) => event.id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
      }),
    ).pipe(Effect.provide(h.layer));
  });
});
