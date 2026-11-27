import { Db } from "@osn/db/service";
import {
  type DeletionRecord,
  type DeletionRecordStore,
  memoryDeletionRecordStore,
  missingDeletionRecordStore,
} from "@shared/db-utils/deletion-records";
import type { EmailService } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccountErasureRateLimiters } from "../../src/routes/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
import { holdQueries } from "../helpers/held-query";
import { createAccountErasureRoutes, createProfileRoutes } from "../helpers/routes";
import { mintStepUpToken } from "../helpers/step-up-session";

// Every account deletion osn-api accepts, its cancel, and every profile
// deletion are recorded outside the database before they are written, so a
// D1 restore cannot lose them (lib/deletion-records.ts). Each case seeds a
// second account and checks that its rows and records are untouched.

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const allowAll = (): AccountErasureRateLimiters => {
  const backend = { check: async () => true } as RateLimiterBackend;
  return {
    accountDelete: backend,
    accountRestore: backend,
    accountDeletionStatus: backend,
    accountDataLink: backend,
  };
};

const IP = { "x-forwarded-for": "1.2.3.4" };

/** A store that refuses writes of the kinds named, and records the rest. */
function failingFor(
  kinds: ReadonlyArray<DeletionRecord["kind"]>,
): DeletionRecordStore & { records: () => DeletionRecord[] } {
  const memory = memoryDeletionRecordStore();
  const missing = missingDeletionRecordStore();
  return {
    write: (record) => (kinds.includes(record.kind) ? missing.write(record) : memory.write(record)),
    discard: memory.discard,
    rewrite: memory.rewrite,
    records: memory.records,
  };
}

const runOn = <A, E>(layer: Layer.Layer<Db | EmailService>, effect: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

async function seed(store: DeletionRecordStore, layerOf = createTestLayerWithSqlite) {
  const base = layerOf();
  const held = holdQueries(base.db);
  const layer = Layer.merge(Layer.succeed(Db, { db: held.db }), base.email.layer);
  const auth = createAuthService(config);
  const signIn = async (email: string, handle: string) => {
    const profile = await runOn(layer, auth.registerProfile(email, handle, handle));
    const tokens = await runOn(
      layer,
      auth.issueTokens(profile.id, profile.accountId, profile.email, profile.handle, null),
    );
    return { profile, authed: { ...IP, Authorization: `Bearer ${tokens.accessToken}` } };
  };
  const eraser = await signIn("eraser@example.com", "eraser");
  const bystander = await signIn("bystander@example.com", "bystander");
  const erasure = createAccountErasureRoutes(
    config,
    layer,
    undefined,
    allowAll(),
    { secure: false },
    { trustedProxyCount: 1 },
    undefined,
    undefined,
    undefined,
    store,
  );
  const profiles = createProfileRoutes(
    config,
    layer,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
  const stepUp = (purpose: "account_delete" | "account_restore") =>
    runOn(layer, mintStepUpToken(auth, eraser.profile.accountId, "otp", purpose));
  const del = async (body: Record<string, unknown>) =>
    erasure.handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { ...eraser.authed, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const restore = async (body: Record<string, unknown>) =>
    erasure.handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { ...eraser.authed, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const row = <T>(sql: string, ...params: string[]) =>
    base.sqlite.query(sql).get(...params) as T | null;
  const job = () =>
    row<{ job_id: string; hard_delete_at: number }>(
      "SELECT job_id, hard_delete_at FROM deletion_jobs WHERE account_id = ?",
      eraser.profile.accountId,
    );
  const tombstone = (accountId: string) =>
    row<{ deleted_at: number | null }>("SELECT deleted_at FROM accounts WHERE id = ?", accountId)
      ?.deleted_at ?? null;
  return {
    base,
    held,
    layer,
    auth,
    eraser,
    bystander,
    profiles,
    stepUp,
    del,
    restore,
    row,
    job,
    tombstone,
  };
}

/** The bystander's account, untouched: live, with no job and no record naming it. */
function expectBystanderUntouched(
  h: Awaited<ReturnType<typeof seed>>,
  records: ReadonlyArray<DeletionRecord>,
) {
  expect(h.tombstone(h.bystander.profile.accountId)).toBeNull();
  expect(
    h.row("SELECT 1 FROM deletion_jobs WHERE account_id = ?", h.bystander.profile.accountId),
  ).toBeNull();
  expect(h.row("SELECT 1 FROM users WHERE id = ?", h.bystander.profile.id)).not.toBeNull();
  expect(JSON.stringify(records)).not.toContain(h.bystander.profile.accountId);
  expect(JSON.stringify(records)).not.toContain(h.bystander.profile.id);
}

describe("DELETE /account records the deletion it accepts", () => {
  it("records the job it schedules, with ids and the answers only", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const res = await h.del({
      confirm_handle: "eraser",
      step_up_token: await h.stepUp("account_delete"),
    });
    expect(res.status).toBe(202);
    const job = h.job();
    expect(store.records()).toEqual([
      {
        v: 1,
        kind: "account_deletion_requested",
        at: expect.any(Number),
        accountId: h.eraser.profile.accountId,
        jobId: job?.job_id,
        hardDeleteAt: job?.hard_delete_at,
        deleteEverything: false,
        choices: [],
      },
    ]);
    expect(JSON.stringify(store.records())).not.toContain("eraser@example.com");
    expectBystanderUntouched(h, store.records());
  });

  it("records nothing for a refused step-up, nor for a repeat while the deletion is pending", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const refused = await h.del({ confirm_handle: "eraser" });
    expect(refused.status).toBe(403);
    expect(store.records()).toEqual([]);

    await h.del({ confirm_handle: "eraser", step_up_token: await h.stepUp("account_delete") });
    const again = await h.del({ confirm_handle: "eraser" });
    expect(again.status).toBe(202);
    expect(store.records()).toHaveLength(1);
  });

  it("keeps no record for a request that loses the race to another", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const [heldToken, otherToken] = [
      await h.stepUp("account_delete"),
      await h.stepUp("account_delete"),
    ];
    const insert = h.held.hold(/^insert into "deletion_jobs"/);
    const heldRequest = h.del({ confirm_handle: "eraser", step_up_token: heldToken });
    await insert.reached;
    const other = await h.del({ confirm_handle: "eraser", step_up_token: otherToken });
    insert.release();
    const held = await heldRequest;

    expect(other.status).toBe(202);
    expect(held.status).toBe(202);
    expect(
      store.records().map((record) => record.kind === "account_deletion_requested" && record.jobId),
    ).toEqual([h.job()?.job_id]);
  });

  it("keeps the record when the database fails after it, since the write may have landed", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const token = await h.stepUp("account_delete");
    const insert = h.held.hold(/^insert into "deletion_jobs"/);
    const deleting = h.del({ confirm_handle: "eraser", step_up_token: token });
    await insert.reached;
    h.base.sqlite.run("DROP TABLE security_events");
    insert.release();
    expect((await deleting).status).not.toBe(202);
    expect(store.records().map(({ kind }) => kind)).toEqual(["account_deletion_requested"]);
  });

  it("refuses the deletion with 503, writing nothing, when the record cannot be written", async () => {
    const h = await seed(missingDeletionRecordStore());
    const res = await h.del({
      confirm_handle: "eraser",
      step_up_token: await h.stepUp("account_delete"),
    });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 503,
      body: { error: "temporarily_unavailable" },
    });
    expect(h.tombstone(h.eraser.profile.accountId)).toBeNull();
    expect(h.job()).toBeNull();
    expect(h.row("SELECT handle FROM users WHERE id = ?", h.eraser.profile.id)).toEqual({
      handle: "eraser",
    });
  });
});

describe("DELETE /account records the person's answers", () => {
  it("records each answer as an action id and a choice token, a named successor's profile id among them", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const orgs = createOrganisationService({ heldHandleDigest: h.auth.heldHandleDigest });
    const solo = await runOn(
      h.layer,
      orgs.createOrganisation(h.eraser.profile.id, "soloclub", "Solo"),
    );
    const shared = await runOn(
      h.layer,
      orgs.createOrganisation(h.eraser.profile.id, "sharedclub", "Shared"),
    );
    await runOn(
      h.layer,
      orgs.addMember(shared.id, h.eraser.profile.id, h.bystander.profile.id, "member"),
    );
    const res = await h.del({
      confirm_handle: "eraser",
      step_up_token: await h.stepUp("account_delete"),
      choices: [
        { action: `osn:organisation:${solo.id}`, choice: "delete" },
        {
          action: `osn:organisation:${shared.id}`,
          choice: "successor",
          successor_profile_id: h.bystander.profile.id,
        },
      ],
    });
    expect(res.status).toBe(202);
    const [record] = store.records();
    expect(record).toMatchObject({ kind: "account_deletion_requested", deleteEverything: false });
    const choices = record?.kind === "account_deletion_requested" ? record.choices : [];
    expect(choices.toSorted((a, b) => a.action.localeCompare(b.action))).toEqual(
      [
        { action: `osn:organisation:${solo.id}`, choice: "delete" },
        {
          action: `osn:organisation:${shared.id}`,
          choice: "successor",
          successorProfileId: h.bystander.profile.id,
        },
      ].toSorted((a, b) => a.action.localeCompare(b.action)),
    );
    expect(JSON.stringify(store.records())).not.toContain("Solo");
    expect(JSON.stringify(store.records())).not.toContain("soloclub");
  });

  it("records delete everything as the flag and no answers", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const res = await h.del({
      confirm_handle: "eraser",
      step_up_token: await h.stepUp("account_delete"),
      delete_everything: true,
    });
    expect(res.status).toBe(202);
    expect(store.records()).toEqual([
      expect.objectContaining({ deleteEverything: true, choices: [] }),
    ]);
  });
});

describe("POST /account/restore records the cancel it accepts", () => {
  it("records the job it cancels", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    await h.del({ confirm_handle: "eraser", step_up_token: await h.stepUp("account_delete") });
    const jobId = h.job()?.job_id;
    const res = await h.restore({ step_up_token: await h.stepUp("account_restore") });
    expect(await res.json()).toEqual({ cancelled: true });
    expect(store.records().map(({ kind }) => kind)).toEqual([
      "account_deletion_requested",
      "account_deletion_withdrawn",
    ]);
    expect(store.records()[1]).toEqual({
      v: 1,
      kind: "account_deletion_withdrawn",
      at: expect.any(Number),
      accountId: h.eraser.profile.accountId,
      jobId,
    });
    expectBystanderUntouched(h, store.records());
  });

  it("keeps no record of a cancel refused once the window has passed", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    await h.del({ confirm_handle: "eraser", step_up_token: await h.stepUp("account_delete") });
    h.base.sqlite.run("UPDATE deletion_jobs SET hard_delete_at = 1 WHERE account_id = ?", [
      h.eraser.profile.accountId,
    ]);
    const res = await h.restore({ step_up_token: await h.stepUp("account_restore") });
    expect(await res.json()).toEqual({ cancelled: false });
    expect(store.records().map(({ kind }) => kind)).toEqual(["account_deletion_requested"]);
  });

  it("keeps no record of a cancel a purge beats between its read and its write", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    await h.del({ confirm_handle: "eraser", step_up_token: await h.stepUp("account_delete") });
    const token = await h.stepUp("account_restore");
    const release = h.held.hold(/^delete from "deletion_jobs"/);
    const cancelling = h.restore({ step_up_token: token });
    await release.reached;
    h.base.sqlite.run("UPDATE deletion_jobs SET purge_started_at = 1 WHERE account_id = ?", [
      h.eraser.profile.accountId,
    ]);
    release.release();
    expect(await (await cancelling).json()).toEqual({ cancelled: false });
    expect(store.records().map(({ kind }) => kind)).toEqual(["account_deletion_requested"]);
    expect(h.tombstone(h.eraser.profile.accountId)).not.toBeNull();
  });

  it("cancels even when its record cannot be written", async () => {
    const store = failingFor(["account_deletion_withdrawn"]);
    const h = await seed(store);
    await h.del({ confirm_handle: "eraser", step_up_token: await h.stepUp("account_delete") });
    const res = await h.restore({ step_up_token: await h.stepUp("account_restore") });
    expect(await res.json()).toEqual({ cancelled: true });
    expect(h.tombstone(h.eraser.profile.accountId)).toBeNull();
    expect(h.job()).toBeNull();
  });
});

describe("POST /profiles/delete records the deletion it accepts", () => {
  const remove = (h: Awaited<ReturnType<typeof seed>>, profileId: string) =>
    h.profiles.handle(
      new Request("http://localhost/profiles/delete", {
        method: "POST",
        headers: { ...h.eraser.authed, "content-type": "application/json" },
        body: JSON.stringify({ profile_id: profileId }),
      }),
    );
  const secondProfile = async (h: Awaited<ReturnType<typeof seed>>) => {
    const res = await h.profiles.handle(
      new Request("http://localhost/profiles/create", {
        method: "POST",
        headers: { ...h.eraser.authed, "content-type": "application/json" },
        body: JSON.stringify({ handle: "eraser_alt" }),
      }),
    );
    return ((await res.json()) as { profile: { id: string } }).profile.id;
  };

  it("records the profile it deletes", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const alt = await secondProfile(h);
    const res = await remove(h, alt);
    expect(res.status).toBe(200);
    expect(store.records()).toEqual([
      {
        v: 1,
        kind: "profile_deleted",
        at: expect.any(Number),
        accountId: h.eraser.profile.accountId,
        profileId: alt,
      },
    ]);
    expectBystanderUntouched(h, store.records());
  });

  it("records nothing for the account's last profile, nor for one that owns an organisation", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const last = await remove(h, h.eraser.profile.id);
    expect(last.status).toBe(400);

    const alt = await secondProfile(h);
    const orgs = createOrganisationService({ heldHandleDigest: h.auth.heldHandleDigest });
    await runOn(h.layer, orgs.createOrganisation(alt, "altclub", "Alt Club"));
    const owner = await remove(h, alt);
    expect(owner.status).toBe(400);
    expect(store.records()).toEqual([]);
  });

  it("keeps no record when the profile becomes the last between the read and the write", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const alt = await secondProfile(h);
    const write = h.held.hold(/^delete from "connections"/);
    const removing = remove(h, alt);
    await write.reached;
    h.base.sqlite.run("DELETE FROM users WHERE id = ?", [h.eraser.profile.id]);
    write.release();
    expect((await removing).status).toBe(400);
    expect(store.records()).toEqual([]);
  });

  it("keeps the record when the database fails after it, since the write may have landed", async () => {
    const store = memoryDeletionRecordStore();
    const h = await seed(store);
    const alt = await secondProfile(h);
    const write = h.held.hold(/^delete from "connections"/);
    const removing = remove(h, alt);
    await write.reached;
    h.base.sqlite.run("DROP TABLE blocks");
    write.release();
    expect((await removing).status).toBe(500);
    expect(store.records().map(({ kind }) => kind)).toEqual(["profile_deleted"]);
  });

  it("refuses the deletion with 503, deleting nothing, when the record cannot be written", async () => {
    const h = await seed(missingDeletionRecordStore());
    const alt = await secondProfile(h);
    const res = await remove(h, alt);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 503,
      body: { error: "temporarily_unavailable" },
    });
    expect(h.row("SELECT 1 AS one FROM users WHERE id = ?", alt)).toEqual({ one: 1 });
  });
});
