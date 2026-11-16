import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import {
  accounts,
  appEnrollments,
  deletionJobs,
  handleHolds,
  organisationMembers,
  organisations,
  passkeys,
  recoveryCodes,
  totpCredentials,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { makeHeldHandleDigest } from "../../src/lib/handle-hold";
import {
  type ErasureChoices,
  hardDeleteAccount,
  requestErasure,
} from "../../src/services/account-erasure";
import { joinApp } from "../../src/services/app-enrollments";
import { holdQueries } from "../helpers/held-query";

/**
 * The account hard delete on real D1 (Miniflare), which enforces foreign keys
 * as production does: an account that is enrolled in an app, or owns an
 * organisation, is deleted in one batch without a foreign-key failure, and
 * each owned organisation passes on or is deleted as the rules say. Also the
 * soft delete's answer to two requests at once, which rests on D1 rolling
 * back a whole batch.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const digest = makeHeldHandleDigest(undefined);

let mf: Miniflare;
let d1: DrizzleD1;
let db: ReturnType<typeof createD1Db>;
let hold: ReturnType<typeof holdQueries>["hold"];
let layer: Layer.Layer<Db>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  db = createD1Db(d1);
  const held = holdQueries(db);
  hold = held.hold;
  layer = Layer.succeed(Db, { db: held.db });
});

afterAll(async () => {
  await mf?.dispose();
});

const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** An account with one profile on `handle`. */
async function person(handle: string) {
  const accountId = newId("acc_");
  const profileId = newId("usr_");
  const now = new Date();
  await db.insert(accounts).values({
    id: accountId,
    email: `${handle}@example.com`,
    passkeyUserId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(users).values({
    id: profileId,
    accountId,
    handle,
    displayName: null,
    avatarUrl: null,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  });
  return { accountId, profileId };
}

type Member = { profileId: string; role: "admin" | "member"; joined: number };

/** An organisation owned by `ownerId`: the owner's admin row, joined at second 1, then `members`. */
async function organisation(ownerId: string, handle: string, members: ReadonlyArray<Member>) {
  const orgId = newId("org_");
  await db.insert(organisations).values({
    id: orgId,
    handle,
    name: `Org ${handle}`,
    ownerId,
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  for (const m of [{ profileId: ownerId, role: "admin" as const, joined: 1 }, ...members]) {
    await db.insert(organisationMembers).values({
      id: newId("orgm_"),
      organisationId: orgId,
      profileId: m.profileId,
      role: m.role,
      createdAt: new Date(m.joined * 1_000),
    });
  }
  return orgId;
}

/** The hard delete's clock: Unix seconds, past every window these tests open. */
const HARD_DELETE_AT = 2_000_000_000;

/** Marks every app done on the account's job, as the fan-out does once each has answered. */
async function everyAppDone(accountId: string) {
  await db
    .update(deletionJobs)
    .set({
      pulseDoneAt: HARD_DELETE_AT - 1,
      zapDoneAt: HARD_DELETE_AT - 1,
      cireDoneAt: HARD_DELETE_AT - 1,
    })
    .where(eq(deletionJobs.accountId, accountId));
}

/**
 * Soft-deletes the account with `choices`, marks every app done, then
 * hard-deletes it at {@link HARD_DELETE_AT}.
 */
async function purge(accountId: string, choices?: ErasureChoices) {
  await run(requestErasure({ accountId, cancel: null, heldHandleDigest: digest, choices }));
  await everyAppDone(accountId);
  const [job] = await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId));
  return run(hardDeleteAccount(job!, HARD_DELETE_AT));
}

async function orgState(orgId: string) {
  const [org] = await db
    .select({ ownerId: organisations.ownerId })
    .from(organisations)
    .where(eq(organisations.id, orgId));
  const members = await db
    .select({ profileId: organisationMembers.profileId, role: organisationMembers.role })
    .from(organisationMembers)
    .where(eq(organisationMembers.organisationId, orgId));
  if (!org) return { gone: true, members: members.length };
  return {
    ownerId: org.ownerId,
    members: members.toSorted((a, b) => a.profileId.localeCompare(b.profileId)),
  };
}

const membersOf = (...members: Array<{ profileId: string; role: "admin" | "member" }>) =>
  members.toSorted((a, b) => a.profileId.localeCompare(b.profileId));

const accountGone = async (accountId: string) =>
  (await db.select().from(accounts).where(eq(accounts.id, accountId))).length === 0;

const action = (orgId: string) => `osn:organisation:${orgId}`;

describe("an account enrolled in an app, hard-deleted on D1", () => {
  it("D1 refuses to delete an account while an app enrolment row names it", async () => {
    const { accountId, profileId } = await person("fkenrolled");
    await db.delete(users).where(eq(users.id, profileId));
    await db.insert(appEnrollments).values({
      id: newId("aenr_"),
      accountId,
      app: "pulse",
      joinedAt: 1_000,
      leftAt: 2_000,
    });

    let failure: unknown = null;
    try {
      await d1.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId).run();
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("FOREIGN KEY constraint failed");
    expect(await accountGone(accountId)).toBe(false);
  });

  it("is deleted with its enrolments, open and closed", async () => {
    const { accountId } = await person("enrolled");
    await db.insert(appEnrollments).values([
      { id: newId("aenr_"), accountId, app: "zap", joinedAt: 1_000, leftAt: 2_000 },
      { id: newId("aenr_"), accountId, app: "pulse", joinedAt: 1_000, leftAt: null },
    ]);
    await run(requestErasure({ accountId, cancel: null, heldHandleDigest: digest }));
    // The job waits on every app; the fan-out marks each.
    await everyAppDone(accountId);
    const [job] = await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId));

    const result = await run(hardDeleteAccount(job!, HARD_DELETE_AT));

    expect(result.deleted).toBe(true);
    expect(await accountGone(accountId)).toBe(true);
    expect(
      await db.select().from(appEnrollments).where(eq(appEnrollments.accountId, accountId)),
    ).toEqual([]);
    // The hold outlives the account, released 30 days after the hard delete.
    const holds = await db
      .select()
      .from(handleHolds)
      .where(eq(handleHolds.handle, digest("enrolled")));
    expect(holds).toHaveLength(1);
    expect(holds[0]!.accountId).toBeNull();
    expect(holds[0]!.releaseAt).toBe(HARD_DELETE_AT + 30 * 86_400);
  });
});

describe("an account with its sign-in credentials, hard-deleted on D1", () => {
  // The soft delete keeps every credential, so the hard delete is the only
  // place they go, and each names the account by a foreign key.
  it("is deleted with its passkey, recovery code and authenticator", async () => {
    const { accountId } = await person("credentialed");
    const now = Math.floor(Date.now() / 1_000);
    await db.insert(passkeys).values({
      id: newId("pk_"),
      accountId,
      credentialId: crypto.randomUUID(),
      publicKey: "stub",
      counter: 0,
      createdAt: new Date(),
    });
    await db.insert(recoveryCodes).values({
      id: newId("rec_"),
      accountId,
      codeHash: crypto.randomUUID(),
      createdAt: now,
    });
    await db.insert(totpCredentials).values({
      id: newId("totp_"),
      accountId,
      secretCiphertext: Buffer.from(new Uint8Array(36)),
      iv: Buffer.from(new Uint8Array(12)),
      keyVersion: 1,
      confirmedAt: now,
      createdAt: now,
    });

    const result = await purge(accountId);

    expect(result.deleted).toBe(true);
    expect(await accountGone(accountId)).toBe(true);
    expect(await db.select().from(passkeys).where(eq(passkeys.accountId, accountId))).toEqual([]);
    expect(
      await db.select().from(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
    ).toEqual([]);
    expect(
      await db.select().from(totpCredentials).where(eq(totpCredentials.accountId, accountId)),
    ).toEqual([]);
  });
});

describe("an account that owns organisations, hard-deleted on D1 with foreign keys enforced", () => {
  it("an organisation with another admin passes to the longest-standing one", async () => {
    const owner = await person("d1owner1");
    const bob = await person("d1bob1");
    const carol = await person("d1carol1");
    const dave = await person("d1dave1");
    const orgId = await organisation(owner.profileId, "d1org1", [
      { profileId: bob.profileId, role: "member", joined: 10 },
      { profileId: carol.profileId, role: "admin", joined: 30 },
      { profileId: dave.profileId, role: "admin", joined: 20 },
    ]);

    const result = await purge(owner.accountId);

    expect(result).toEqual({
      deleted: true,
      transfers: [{ orgId, ownerProfileId: dave.profileId }],
      orgsDeleted: 0,
    });
    expect(await accountGone(owner.accountId)).toBe(true);
    expect(await orgState(orgId)).toEqual({
      ownerId: dave.profileId,
      members: membersOf(
        { profileId: bob.profileId, role: "member" },
        { profileId: carol.profileId, role: "admin" },
        { profileId: dave.profileId, role: "admin" },
      ),
    });
  });

  it("a sole admin's organisation, transfer confirmed, passes to the longest-standing member, made admin", async () => {
    const owner = await person("d1owner2");
    const bob = await person("d1bob2");
    const carol = await person("d1carol2");
    const orgId = await organisation(owner.profileId, "d1org2", [
      { profileId: bob.profileId, role: "member", joined: 20 },
      { profileId: carol.profileId, role: "member", joined: 10 },
    ]);

    const result = await purge(owner.accountId, { [action(orgId)]: { choice: "transfer" } });

    expect(result.transfers).toEqual([{ orgId, ownerProfileId: carol.profileId }]);
    expect(await accountGone(owner.accountId)).toBe(true);
    expect(await orgState(orgId)).toEqual({
      ownerId: carol.profileId,
      members: membersOf(
        { profileId: bob.profileId, role: "member" },
        { profileId: carol.profileId, role: "admin" },
      ),
    });
  });

  it("a sole member's organisation is deleted with its memberships", async () => {
    const owner = await person("d1owner3");
    const orgId = await organisation(owner.profileId, "d1org3", []);

    const result = await purge(owner.accountId, { [action(orgId)]: { choice: "delete" } });

    expect(result).toEqual({ deleted: true, transfers: [], orgsDeleted: 1 });
    expect(await accountGone(owner.accountId)).toBe(true);
    expect(await orgState(orgId)).toEqual({ gone: true, members: 0 });
  });

  it("a named successor who is still a member takes it, ahead of an admin", async () => {
    const owner = await person("d1owner4");
    const bob = await person("d1bob4");
    const carol = await person("d1carol4");
    const orgId = await organisation(owner.profileId, "d1org4", [
      { profileId: bob.profileId, role: "admin", joined: 10 },
      { profileId: carol.profileId, role: "member", joined: 20 },
    ]);

    const result = await purge(owner.accountId, {
      [action(orgId)]: { choice: "successor", successorProfileId: carol.profileId },
    });

    expect(result.transfers).toEqual([{ orgId, ownerProfileId: carol.profileId }]);
    expect(await accountGone(owner.accountId)).toBe(true);
    expect(await orgState(orgId)).toEqual({
      ownerId: carol.profileId,
      members: membersOf(
        { profileId: bob.profileId, role: "admin" },
        { profileId: carol.profileId, role: "admin" },
      ),
    });
  });

  it("a delete choice deletes it even with another admin", async () => {
    const owner = await person("d1owner5");
    const bob = await person("d1bob5");
    const orgId = await organisation(owner.profileId, "d1org5", [
      { profileId: bob.profileId, role: "admin", joined: 10 },
    ]);

    const result = await purge(owner.accountId, { [action(orgId)]: { choice: "delete" } });

    expect(result).toEqual({ deleted: true, transfers: [], orgsDeleted: 1 });
    expect(await accountGone(owner.accountId)).toBe(true);
    expect(await orgState(orgId)).toEqual({ gone: true, members: 0 });
    expect(await accountGone(bob.accountId)).toBe(false);
  });
});

describe("two deletions of one account at once on D1", () => {
  it("one is scheduled and the other answers that it already is", async () => {
    // The held request read no job; its batch, job insert first, then meets
    // the other's row, and D1 rolls the whole batch back.
    const { accountId } = await person("d1twice");
    const insert = hold(/^insert into "deletion_jobs"/);
    const held = run(requestErasure({ accountId, cancel: null, heldHandleDigest: digest }));
    await insert.reached;
    const other = await run(requestErasure({ accountId, cancel: null, heldHandleDigest: digest }));
    insert.release();

    expect(other.newlyScheduled).toBe(true);
    expect(await held).toEqual({
      accountId,
      scheduledFor: other.scheduledFor,
      newlyScheduled: false,
      profileIds: [],
    });
    expect(
      await db.select().from(handleHolds).where(eq(handleHolds.accountId, accountId)),
    ).toHaveLength(1);
  });
});

describe("the hard delete waits for every app, on D1", () => {
  /**
   * A scheduled account whose job's marks are then set to `pulse` and `zap`,
   * and cire's to `cire` (done unless given).
   */
  const withMarks = async (
    handle: string,
    pulse: number | null,
    zap: number | null,
    cire: number | null = 1_700_000_002,
  ) => {
    const { accountId, profileId } = await person(handle);
    await run(requestErasure({ accountId, cancel: null, heldHandleDigest: digest }));
    await db
      .update(deletionJobs)
      .set({ pulseDoneAt: pulse, zapDoneAt: zap, cireDoneAt: cire })
      .where(eq(deletionJobs.accountId, accountId));
    const [job] = await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId));
    return { accountId, profileId, job: job! };
  };

  it("a new job starts with every app pending, whatever its enrolments", async () => {
    const { accountId } = await person("marksnull");
    await run(joinApp(accountId, "pulse"));
    await run(requestErasure({ accountId, cancel: null, heldHandleDigest: digest }));
    const [job] = await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId));
    expect({ pulse: job!.pulseDoneAt, zap: job!.zapDoneAt, cire: job!.cireDoneAt }).toEqual({
      pulse: null,
      zap: null,
      cire: null,
    });
  });

  it.each([
    ["an app still pending", 1_700_000_000, null],
    [
      "the not-enrolled mark a job written before every account went to every app holds",
      1_700_000_000,
      -1,
    ],
  ])("erases nothing while a job has %s", async (_label, pulse, zap) => {
    const { accountId, profileId, job } = await withMarks(`wait${String(zap)}`, pulse, zap);
    expect((await run(hardDeleteAccount(job, HARD_DELETE_AT))).deleted).toBe(false);
    expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.id, profileId))).toHaveLength(1);
  });

  // The fan-out claims a job before it calls any app, so a job the hard delete
  // meets with an app still pending has usually been claimed already, and the
  // claim no longer guards it: only the batch's job delete does, and D1 rolls
  // the whole batch back when the account's delete then fails on the job.
  it.each([
    ["an app still pending", 1_700_000_000, null],
    ["the old not-enrolled mark", 1_700_000_000, -1],
  ])(
    "erases nothing of a job the fan-out already claimed while it has %s",
    async (_label, pulse, zap) => {
      const { accountId, profileId, job } = await withMarks(`claimed${String(zap)}`, pulse, zap);
      await db
        .update(deletionJobs)
        .set({ purgeStartedAt: HARD_DELETE_AT - 60 })
        .where(eq(deletionJobs.accountId, accountId));
      const claimed = { ...job, purgeStartedAt: HARD_DELETE_AT - 60 };
      const outcome = await Effect.runPromise(
        Effect.result(hardDeleteAccount(claimed, HARD_DELETE_AT).pipe(Effect.provide(layer))),
      );
      expect(outcome._tag).toBe("Failure");
      expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(1);
      expect(await db.select().from(users).where(eq(users.id, profileId))).toHaveLength(1);
      expect(
        await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
      ).toHaveLength(1);
    },
  );

  it("erases the account once every app is done, a skipped app included", async () => {
    const { accountId, job } = await withMarks("bothdone", 1_700_000_000, 1_700_000_001);
    expect((await run(hardDeleteAccount(job, HARD_DELETE_AT))).deleted).toBe(true);
    expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(0);
    expect(
      await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
    ).toHaveLength(0);
  });
});
