import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import {
  accounts,
  connections,
  deletionJobs,
  emailChanges,
  organisationMembers,
  securityEvents,
  sessions,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { type EmailService, makeLogEmailLive } from "@shared/email";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import {
  cancelErasure,
  requestErasure,
  runFanOutRetrySweep,
} from "../../src/services/account-erasure";
import { joinApp } from "../../src/services/app-enrollments";
import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { createOrganisationService } from "../../src/services/organisation";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { holdQueries } from "../helpers/held-query";

/**
 * The writes that name the row as their request read it, on real D1. D1 takes
 * the email change's three statements as one batch and answers each
 * statement's result, so whether the commit reads its own insert's change
 * count correctly — 1 for the change that commits, 0 for the one the cap
 * refuses — is proven here, on the driver production runs. The same holds for
 * a refresh's rotation and an erasure cancel, each one batch whose results are
 * read. The graph and organisation writes answer from a single statement's
 * change count, which D1 reports under `meta.changes`; each one's success path
 * runs here, and the rows it writes are read back.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

let mf: Miniflare;
let db: ReturnType<typeof createD1Db>;
let hold: ReturnType<typeof holdQueries>["hold"];
let layer: Layer.Layer<Db | EmailService>;
let mail: ReturnType<typeof makeLogEmailLive>;
let auth: ReturnType<typeof createAuthService>;
const graph = createGraphService();
const org = createOrganisationService();

const run = <A, E>(eff: Effect.Effect<A, E, Db | EmailService>) =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

const outcomeOf = <A, E>(eff: Effect.Effect<A, E, Db | EmailService>) =>
  Effect.runPromise(eff.pipe(Effect.result, Effect.provide(layer)));

/** The newest six-digit code mailed. */
const latestCode = (): string => {
  const all = mail.recorded();
  for (let i = all.length - 1; i >= 0; i--) {
    const match = all[i]!.text.match(/code is: (\d{6})/);
    if (match) return match[1]!;
  }
  throw new Error("no code mailed");
};

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  db = createD1Db(d1);
  const held = holdQueries(db);
  hold = held.hold;
  mail = makeLogEmailLive();
  layer = Layer.merge(Layer.succeed(Db, { db: held.db }), mail.layer);
  auth = createAuthService(await makeTestAuthConfig());
});

afterAll(async () => {
  await mf?.dispose();
});

describe("email change on D1", () => {
  it("commits one of two changes that each counted one on record, and refuses the other", async () => {
    const profile = await run(auth.registerProfile("ec-d1@example.com", "ecd1"));
    const nowSec = Math.floor(Date.now() / 1000);
    await db.insert(emailChanges).values({
      id: "ech_d1_seed",
      accountId: profile.accountId,
      previousEmail: "seed-old@example.com",
      newEmail: "seed-new@example.com",
      completedAt: nowSec,
    });
    const tokenA = await run(auth.issueStepUpToken(profile.accountId, "otp", "email_change"));
    const tokenB = await run(auth.issueStepUpToken(profile.accountId, "otp", "email_change"));

    await run(auth.beginEmailChange(profile.accountId, "ec-d1-a@example.com"));
    const codeA = latestCode();
    // A's commit batch waits, after its claim and preflight have read one change.
    const commitA = hold(/^update "accounts" set "email"/);
    const a = outcomeOf(auth.completeEmailChange(profile.accountId, codeA, tokenA, null));
    await commitA.reached;

    await run(auth.beginEmailChange(profile.accountId, "ec-d1-b@example.com"));
    const b = await run(auth.completeEmailChange(profile.accountId, latestCode(), tokenB, null));
    expect(b.email).toBe("ec-d1-b@example.com");

    commitA.release();
    const outcome = await a;
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure")
      expect(String(outcome.failure.message)).toMatch(/limit reached/i);

    const rows = await db
      .select({ newEmail: emailChanges.newEmail })
      .from(emailChanges)
      .where(eq(emailChanges.accountId, profile.accountId));
    expect(rows.map((row) => row.newEmail).toSorted()).toEqual([
      "ec-d1-b@example.com",
      "seed-new@example.com",
    ]);
    const [account] = await db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, profile.accountId));
    expect(account?.email).toBe("ec-d1-b@example.com");
  });
});

describe("graph and organisation writes on D1", () => {
  it("each success answers ok and changes its row", async () => {
    const [alice, bob, carol] = await Promise.all(
      ["d1alice", "d1bob", "d1carol"].map((handle) =>
        run(auth.registerProfile(`${handle}@example.com`, handle)),
      ),
    );

    // Connections: send, accept, remove; send, decline; send, cancel.
    await run(graph.sendConnectionRequest(alice!.id, bob!.id));
    const [sent] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.requesterId, alice!.id), eq(connections.addresseeId, bob!.id)));
    expect(sent?.status).toBe("pending");
    expect(sent!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await run(graph.acceptConnection(bob!.id, alice!.id));
    expect(await run(graph.getConnectionStatus(alice!.id, bob!.id))).toBe("connected");
    await run(graph.removeConnection(alice!.id, bob!.id));
    expect(await run(graph.getConnectionStatus(alice!.id, bob!.id))).toBe("none");
    await run(graph.sendConnectionRequest(alice!.id, bob!.id));
    await run(graph.rejectConnection(bob!.id, alice!.id));
    expect(await run(graph.getConnectionStatus(alice!.id, bob!.id))).toBe("none");
    await run(graph.sendConnectionRequest(alice!.id, bob!.id));
    await run(graph.removeConnection(alice!.id, bob!.id));
    expect(await run(graph.getConnectionStatus(alice!.id, bob!.id))).toBe("none");

    // Blocks: a block removes the request, an unblock removes the block.
    await run(graph.sendConnectionRequest(alice!.id, bob!.id));
    await run(graph.blockProfile(bob!.id, alice!.id));
    expect(await run(graph.getConnectionStatus(alice!.id, bob!.id))).toBe("none");
    await run(graph.unblockProfile(bob!.id, alice!.id));
    expect(await run(graph.isBlocked(bob!.id, alice!.id))).toBe(false);

    // Organisation: add, change a role, rename, remove.
    const organisation = await run(org.createOrganisation(alice!.id, "d1org", "D1 Org"));
    await run(org.addMember(organisation.id, alice!.id, bob!.id, "member"));
    await run(org.addMember(organisation.id, alice!.id, carol!.id, "member"));
    const [membership] = await db
      .select()
      .from(organisationMembers)
      .where(
        and(
          eq(organisationMembers.organisationId, organisation.id),
          eq(organisationMembers.profileId, bob!.id),
        ),
      );
    expect(membership?.role).toBe("member");
    expect(membership!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await run(org.updateMemberRole(organisation.id, alice!.id, bob!.id, "admin"));
    expect(await run(org.getMemberRole(organisation.id, bob!.id))).toBe("admin");
    await run(org.updateOrganisation(organisation.id, bob!.id, { name: "Renamed" }));
    expect((await run(org.getOrganisation(organisation.id))).name).toBe("Renamed");
    await run(org.removeMember(organisation.id, bob!.id, carol!.id));
    expect(await run(org.getMemberRole(organisation.id, carol!.id))).toBeNull();
    await run(org.removeMember(organisation.id, alice!.id, bob!.id));
    expect(await run(org.getMemberRole(organisation.id, bob!.id))).toBeNull();
  });
});

describe("session revoke on D1", () => {
  const signIn = async (handle: string) => {
    const profile = await run(auth.registerProfile(`${handle}@example.com`, handle));
    const { refreshToken } = await run(
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
    const { familyId } = await run(auth.verifyRefreshToken(refreshToken));
    return { profile, refreshToken, familyId };
  };
  const familyRows = async (familyId: string) =>
    (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.familyId, familyId)))
      .length;

  it("a revoke that lands while a refresh's batch is held leaves no session of the device", async () => {
    const { profile, refreshToken, familyId } = await signIn("rvd1hold");

    const batch = hold(/^insert into "sessions"/);
    const refresh = outcomeOf(auth.refreshTokens(refreshToken));
    await batch.reached;
    await run(
      auth.revokeAccountSession(
        profile.accountId,
        auth.hashSessionToken(refreshToken).slice(0, 16),
        null,
      ),
    );
    batch.release();

    expect((await refresh)._tag).toBe("Failure");
    expect(await familyRows(familyId)).toBe(0);
  });

  it("a handle the device has rotated away from still revokes it, and a refresh succeeds", async () => {
    const { profile, refreshToken, familyId } = await signIn("rvd1stale");
    const handle = auth.hashSessionToken(refreshToken).slice(0, 16);

    const next = await run(auth.refreshTokens(refreshToken));
    await run(auth.verifyRefreshToken(next.refreshToken));
    expect(await familyRows(familyId)).toBe(1);

    expect(await run(auth.revokeAccountSession(profile.accountId, handle, null))).toEqual({
      revokedSelf: false,
    });
    expect(await familyRows(familyId)).toBe(0);
  });
});

describe("erasure cancel and purge on D1", () => {
  let server: ReturnType<typeof Bun.serve>;
  const purged: string[] = [];
  let urls: { pulseApiUrl: string; zapApiUrl: string };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { accountId: string };
        purged.push(body.accountId);
        return Response.json({ ok: true });
      },
    });
    const base = `http://localhost:${server.port}`;
    urls = { pulseApiUrl: base, zapApiUrl: base };
  });

  afterAll(() => {
    void server.stop(true);
  });

  const purgesOf = (accountId: string) => purged.filter((id) => id === accountId).length;

  const scheduled = async (handle: string) => {
    const profile = await run(auth.registerProfile(`${handle}@example.com`, handle));
    await run(joinApp(profile.accountId, "pulse"));
    await run(joinApp(profile.accountId, "zap"));
    const { scheduledFor } = await run(
      requestErasure({ accountId: profile.accountId, cancelSessionId: null }),
    );
    return { accountId: profile.accountId, pastWindowMs: (scheduledFor + 1) * 1_000 };
  };

  const deletedAt = async (accountId: string) =>
    (await db.select().from(accounts).where(eq(accounts.id, accountId)))[0]?.deletedAt;
  const job = async (accountId: string) =>
    (await db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)))[0];

  it("a cancel whose batch is held while the fan-out claims and purges is refused", async () => {
    const { accountId, pastWindowMs } = await scheduled("ced1claim");

    const batch = hold(/^delete from "deletion_jobs"/);
    const cancel = outcomeOf(cancelErasure(accountId));
    await batch.reached;
    await run(runFanOutRetrySweep({ nowMs: pastWindowMs, ...urls }));
    expect(purgesOf(accountId)).toBe(2);
    batch.release();

    expect(await cancel).toMatchObject({ _tag: "Success", success: { cancelled: false } });
    expect(await deletedAt(accountId)).not.toBeNull();
    expect((await job(accountId))?.purgeStartedAt).toBeGreaterThan(0);
  });

  it("a cancel that lands while the fan-out is held before its claim stops the purge", async () => {
    const { accountId, pastWindowMs } = await scheduled("ced1first");

    const body = hold(/^select "id" from "users"/);
    const sweep = run(runFanOutRetrySweep({ nowMs: pastWindowMs, ...urls }));
    await body.reached;
    expect(await run(cancelErasure(accountId))).toEqual({ cancelled: true });
    body.release();
    await sweep;

    expect(purgesOf(accountId)).toBe(0);
    expect(await deletedAt(accountId)).toBeNull();
    expect(await job(accountId)).toBeUndefined();
  });

  it("of two cancels of one job, the second's batch writes nothing", async () => {
    const { accountId } = await scheduled("ced1twice");

    const batch = hold(/^delete from "deletion_jobs"/);
    const second = outcomeOf(cancelErasure(accountId));
    await batch.reached;
    expect(await run(cancelErasure(accountId))).toEqual({ cancelled: true });
    batch.release();

    expect(await second).toMatchObject({ _tag: "Success", success: { cancelled: false } });
    const events = await db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.accountId, accountId),
          eq(securityEvents.kind, "account_deletion_cancelled"),
        ),
      );
    expect(events).toHaveLength(1);
  });
});
