import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import { accounts, changeNoticeRuns } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { createSchemaSql } from "@osn/db/testing";
import { createD1Db } from "@shared/db-utils";
import { EmailService } from "@shared/email";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import {
  changeNoticeCounts,
  sendChangeNoticeBatch,
  type ChangeNoticeBatchRequest,
} from "../../src/services/change-notices";
import { fakeResend } from "../helpers/fake-resend";
import { holdQueries } from "../helpers/held-query";

/**
 * A change-notice run's writes on real D1. Each one names the state it read —
 * the claim, the attempt count, the move past a batch, the drop of a refused
 * key, the finish — and the run reads each write's RETURNING rows to know
 * whether it won. D1 reports those rows and evaluates the counters' arithmetic
 * in SQL; this proves both on the driver production runs, where the route
 * tests prove them on bun:sqlite.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const T0 = Date.UTC(2026, 11, 1) / 1_000;
const data = {
  instanceName: "Acme",
  document: "privacy notice",
  changes: ["We now keep sign-in records for 12 months."],
  takesEffect: Date.UTC(2027, 0, 1) / 1_000,
  url: "https://app.example.test/privacy",
};

let mf: Miniflare;
let db: ReturnType<typeof createD1Db>;
let hold: ReturnType<typeof holdQueries>["hold"];
let heldDb: ReturnType<typeof createD1Db>;
let notice = 0;

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
  heldDb = held.db;
  hold = held.hold;
});

afterAll(async () => {
  await mf?.dispose();
});

/** Waits until `condition` holds, a millisecond at a time. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

/** A fresh notice id and its own accounts, so the cases share one database. */
async function fixture(addresses: readonly string[]) {
  notice += 1;
  const noticeId = `d1-notice-${notice}`;
  await db.delete(accounts);
  for (const [i, email] of addresses.entries()) {
    await db.insert(accounts).values({
      id: `acc_${notice}_${i}`,
      email,
      passkeyUserId: crypto.randomUUID(),
      createdAt: new Date((T0 - 86_400) * 1_000),
      updatedAt: new Date((T0 - 86_400) * 1_000),
    });
  }
  const resend = fakeResend();
  const layer = Layer.merge(
    Layer.succeed(Db, { db: heldDb }),
    Layer.succeed(EmailService, resend.service),
  );
  let keys = 0;
  const call = (overrides: Partial<ChangeNoticeBatchRequest> = {}) =>
    Effect.runPromise(
      sendChangeNoticeBatch({
        noticeId,
        data,
        limit: 100,
        resendUnconfirmed: false,
        now: T0,
        timeout: "200 millis",
        newKey: () => `change-notice/${noticeId}/${(keys += 1)}`,
        ...overrides,
      }).pipe(Effect.provide(layer)),
    );
  const row = async () =>
    (await db.select().from(changeNoticeRuns).where(eq(changeNoticeRuns.noticeId, noticeId)))[0];
  const counts = () =>
    Effect.runPromise(changeNoticeCounts(noticeId, T0).pipe(Effect.provide(layer)));
  const readdress = (i: number, email: string) =>
    db
      .update(accounts)
      .set({ email })
      .where(eq(accounts.id, `acc_${notice}_${i}`));
  return { noticeId, resend, call, row, counts, readdress };
}

/** Makes the first batch unconfirmed: its send went, its answer was lost, and an address changed. */
async function unconfirmedBatch(f: Awaited<ReturnType<typeof fixture>>) {
  f.resend.script.push("accept-then-503");
  expect(await f.call()).toEqual({ kind: "unknown" });
  await f.readdress(0, `moved-${notice}@example.test`);
  expect(await f.call()).toEqual({ kind: "unconfirmed", count: 1 });
}

describe("change-notice run on D1", () => {
  it("claims, sends, moves past each batch and finishes, counting on D1", async () => {
    const f = await fixture(["a@example.test", "b@example.test", "c@example.test"]);
    expect(await f.call({ limit: 2 })).toEqual({
      kind: "sent",
      sent: 2,
      failed: 0,
      sentSoFar: 2,
      failedSoFar: 0,
    });
    expect(await f.row()).toMatchObject({ cursor: "acc_1_1", sent: 2, pendingKey: null });
    expect(await f.call({ limit: 2 })).toMatchObject({ kind: "sent", sent: 1, sentSoFar: 3 });
    expect(await f.call()).toEqual({ kind: "finished", sentSoFar: 3, failedSoFar: 0 });
    expect(await f.row()).toMatchObject({ cursor: null, finishedAt: T0, sent: 3 });
    expect(await f.counts()).toMatchObject({ finished: true, toSend: 0, sentSoFar: 3 });
    expect(f.resend.delivered.map((d) => d.to)).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
    ]);
  });

  it("keeps the key through an unknown outcome and a refused retry, and drops a key only every send under it refused", async () => {
    const f = await fixture(["a@example.test"]);
    f.resend.script.push("accept-then-503", "429-early");
    expect(await f.call()).toEqual({ kind: "unknown" });
    expect(await f.call()).toEqual({ kind: "rate_limited" });
    expect(await f.row()).toMatchObject({ pendingAttempts: 2, pendingRefused: 1 });
    expect(await f.call()).toMatchObject({ kind: "sent", sentSoFar: 1 });
    expect(f.resend.delivered).toHaveLength(1);

    const g = await fixture(["b@example.test"]);
    g.resend.script.push("429");
    expect(await g.call()).toEqual({ kind: "rate_limited" });
    expect(await g.row()).toMatchObject({ pendingKey: null, pendingAttempts: null });
  });

  it("lets only one of two retries that read the same attempt count send", async () => {
    const f = await fixture(["a@example.test"]);
    const release = Effect.runSync(Deferred.make<void>());
    f.resend.script.push("503", { hold: release });
    expect(await f.call()).toEqual({ kind: "unknown" });

    // A reads the row and is held at its attempt count's write.
    const bump = hold(/^update "change_notice_runs" set "pending_attempts"/);
    const a = f.call();
    await bump.reached;
    // B reads the same count, wins the write, and its send is in flight.
    const b = f.call();
    for (let i = 0; i < 200 && f.resend.calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(f.resend.calls).toHaveLength(2);
    bump.release();
    expect(await a).toEqual({ kind: "busy" });
    Effect.runSync(Deferred.succeed(release, undefined));
    expect(await b).toMatchObject({ kind: "sent", sent: 1 });
    // A never reached the provider.
    expect(f.resend.calls).toHaveLength(2);
    expect(f.resend.delivered).toHaveLength(1);
  });

  it("lets only one of two calls that read the same cursor claim a batch", async () => {
    const f = await fixture(["a@example.test"]);
    const claim = hold(/^update "change_notice_runs" set "pending_key"/);
    const a = f.call();
    await claim.reached;
    expect(await f.call()).toMatchObject({ kind: "sent", sent: 1 });
    claim.release();
    expect(await a).toEqual({ kind: "busy" });
    expect(f.resend.delivered).toHaveLength(1);
    expect(f.resend.calls).toHaveLength(1);
  });

  it("moves past a batch once when two calls both hold its provider's answer", async () => {
    const f = await fixture(["a@example.test"]);
    const advance = hold(/^update "change_notice_runs" set "cursor"/);
    const a = f.call();
    await advance.reached;
    // B retries the same key; the provider answers what it stored.
    expect(await f.call()).toMatchObject({ kind: "sent", sentSoFar: 1 });
    advance.release();
    expect(await a).toEqual({ kind: "busy" });
    expect(await f.row()).toMatchObject({ sent: 1, cursor: "acc_" + notice + "_0" });
    expect(f.resend.delivered).toHaveLength(1);
  });

  it("re-keys an unconfirmed batch once when two calls are told to send it again", async () => {
    const f = await fixture(["a@example.test"]);
    await unconfirmedBatch(f);
    const rekey = hold(/^update "change_notice_runs" set "pending_key"/);
    const a = f.call({ resendUnconfirmed: true });
    await rekey.reached;
    expect(await f.call({ resendUnconfirmed: true })).toMatchObject({ kind: "sent", sent: 1 });
    rekey.release();
    expect(await a).toEqual({ kind: "busy" });
    // The first send and the one resend, never a third.
    expect(f.resend.delivered).toHaveLength(2);
  });

  it("answers busy, not unconfirmed, when another call has moved the batch on", async () => {
    const f = await fixture(["a@example.test"]);
    f.resend.script.push("accept-then-503");
    expect(await f.call()).toEqual({ kind: "unknown" });
    await f.readdress(0, `moved-${notice}@example.test`);
    const mark = hold(/^update "change_notice_runs" set "pending_state"/);
    const a = f.call();
    await mark.reached;
    // B marks it and C sends it again under a new key, as the operator asked.
    expect(await f.call()).toEqual({ kind: "unconfirmed", count: 1 });
    expect(await f.call({ resendUnconfirmed: true })).toMatchObject({ kind: "sent" });
    mark.release();
    expect(await a).toEqual({ kind: "busy" });
  });

  it("finishes a run once, keeping the first finish time", async () => {
    // No account at all: both calls read a run with no cursor and no batch.
    const f = await fixture([]);
    const finish = hold(/^update "change_notice_runs" set "cursor" = \?, "finished_at"/);
    const a = f.call({ now: T0 + 50 });
    await finish.reached;
    expect(await f.call({ now: T0 + 10 })).toMatchObject({ kind: "finished" });
    finish.release();
    expect(await a).toEqual({ kind: "busy" });
    expect(await f.row()).toMatchObject({ finishedAt: T0 + 10 });
  });
});
