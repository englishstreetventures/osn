/**
 * `POST /internal/change-notices/:noticeId/send`: the operator's run that
 * mails a change notice to every account, one batch a call.
 *
 * What it must never do: answer anyone without the operator's secret; mail an
 * erased account, a restricted one, or one created after the run began; mail
 * anyone twice, or pass anyone without mailing them, however a call dies;
 * guess when it cannot know whether a batch went; or put an address or an
 * account id in a log line or a response.
 *
 * The mail provider is a fake that behaves as Resend does with idempotency
 * keys: a key it has accepted answers its stored result for the same payload
 * and delivers nothing; a different payload under it answers 409
 * `invalid_idempotent_request`; a second request while the first is in flight
 * answers 409 `concurrent_idempotent_requests`. Each test scripts the answers
 * it needs and reads what was delivered.
 */

import { Database } from "bun:sqlite";

import { Db } from "@osn/db/service";
import { applySchema } from "@osn/db/testing";
import { EmailService } from "@shared/email";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Deferred, Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { createChangeNoticeRoutes } from "../../src/routes/change-notices";
import { noticeDigest, parseChangeNotices } from "../../src/services/change-notice-registry";
import { fakeResend } from "../helpers/fake-resend";

const SECRET = "change-notice-secret-for-tests-0123456789abcdef";
const NOTICE_ID = "privacy-2027-01";
const REGISTRY = {
  [NOTICE_ID]: {
    document: "privacy notice",
    path: "/privacy",
    takesEffect: "2027-01-01",
    changes: ["We now keep sign-in records for 12 months, not 6."],
  },
};
const DIGEST = await noticeDigest(parseChangeNotices(REGISTRY).get(NOTICE_ID)!);
/** 2026-12-01 00:00 UTC, in seconds. */
const T0 = Date.UTC(2026, 11, 1) / 1_000;

interface LogLine {
  readonly level: string;
  readonly message: unknown;
  readonly annotations?: unknown;
}

function setup(
  options: {
    secret?: string;
    registry?: unknown;
    withoutKeyedBatch?: boolean;
  } = {},
) {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  const db = drizzle({ client: sqlite });
  const resend = fakeResend();
  const email = options.withoutKeyedBatch
    ? { send: resend.service.send, sendBatch: () => Effect.void }
    : resend.service;
  const logs: LogLine[] = [];
  const loggerLayer = Logger.layer([
    Logger.map(Logger.formatStructured, (line) => {
      logs.push(line as LogLine);
    }),
  ]);
  const clock = { now: T0 };
  const app = createChangeNoticeRoutes(
    {
      secret: "secret" in options ? options.secret : SECRET,
      registry: "registry" in options ? options.registry : REGISTRY,
      appUrl: "https://app.example.test",
      instanceName: "Acme",
    },
    Layer.merge(Layer.succeed(Db, { db }), Layer.succeed(EmailService, email)),
    loggerLayer,
    undefined,
    { now: () => clock.now, batchTimeout: "50 millis" },
  );

  let created = 0;
  /** An account, created a day before the run starts unless `createdAt` says otherwise. */
  function account(
    address: string,
    extra: { deletedAt?: number; restrictedAt?: number; createdAt?: number } = {},
  ): string {
    created += 1;
    const id = `acc_${String(created).padStart(4, "0")}`;
    sqlite.run(
      `INSERT INTO accounts (id, email, passkey_user_id, max_profiles, created_at, updated_at, deleted_at, processing_restricted_at)
       VALUES (?, ?, ?, 5, ?, ?, ?, ?)`,
      [
        id,
        address,
        crypto.randomUUID(),
        extra.createdAt ?? clock.now - 86_400,
        extra.createdAt ?? clock.now - 86_400,
        extra.deletedAt ?? null,
        extra.restrictedAt ?? null,
      ],
    );
    return id;
  }

  const erase = (id: string) => sqlite.run("DELETE FROM accounts WHERE id = ?", [id]);

  async function send(
    body: Record<string, unknown>,
    headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
    noticeId = NOTICE_ID,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.handle(
      new Request(`http://osn.test/internal/change-notices/${noticeId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ expect: DIGEST, ...body }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
  }

  /** Calls until the run finishes; the answers, in order. */
  async function sendAll(body: Record<string, unknown> = { dryRun: false }) {
    const answers: { status: number; body: Record<string, unknown> }[] = [];
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each call resumes where the last stopped
      const answer = await send(body);
      answers.push(answer);
      if (answer.status !== 200 || answer.body.finished === true) break;
    }
    return answers;
  }

  const run = () =>
    sqlite
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM change_notice_runs WHERE notice_id = ?",
      )
      .get(NOTICE_ID);

  return { app, sqlite, resend, logs, clock, account, erase, send, sendAll, run };
}

/** Every address, as delivered, in order. */
const recipients = (h: ReturnType<typeof setup>) => h.resend.delivered.map((d) => d.to);

/** No address and no account id anywhere in the logs or the answers. */
function expectRedacted(
  h: ReturnType<typeof setup>,
  values: readonly string[],
  answers: readonly unknown[] = [],
) {
  const text = JSON.stringify(h.logs) + JSON.stringify(answers);
  for (const value of values) {
    expect({ value, present: text.includes(value) }).toEqual({ value, present: false });
  }
}

/** A response holds integer counts, booleans and fixed tokens only. */
function expectCountsOnly(body: Record<string, unknown>) {
  const outOfShape = Object.entries(body).filter(([key, value]) =>
    key === "error"
      ? typeof value !== "string" || !/^[a-z_]+$/.test(value)
      : typeof value !== "boolean" && !Number.isSafeInteger(value),
  );
  expect(outOfShape).toEqual([]);
}

describe("refusals before anything is read or written", () => {
  it.each([
    ["unset", undefined],
    ["shorter than 32 characters", "a".repeat(31)],
  ])("answers 501 while the secret is %s", async (_, secret) => {
    const h = setup({ secret });
    h.account("ada@example.test");
    const answer = await h.send({ dryRun: false }, { authorization: `Bearer ${secret ?? ""}` });
    expect(answer.status).toBe(501);
    expect(h.resend.calls).toEqual([]);
    expect(h.run()).toBeNull();
  });

  it("answers a secret of exactly 32 characters", async () => {
    const secret = "s".repeat(32);
    const h = setup({ secret });
    h.account("ada@example.test");
    const answer = await h.send({ dryRun: true }, { authorization: `Bearer ${secret}` });
    expect(answer.status).toBe(200);
  });

  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer wrong-secret-wrong-secret-wrong-secret" }],
    ["the secret with one character more", { authorization: `Bearer ${SECRET}x` }],
    ["the secret under another scheme", { authorization: `Basic ${SECRET}` }],
  ])("answers 401 to %s", async (_, headers) => {
    const h = setup();
    h.account("ada@example.test");
    const answer = await h.send({ dryRun: false }, headers);
    expect(answer.status).toBe(401);
    expect(h.resend.calls).toEqual([]);
    expect(h.run()).toBeNull();
  });

  it("checks the secret before saying whether a notice exists", async () => {
    const h = setup();
    const answer = await h.send({ dryRun: true }, {}, "no-such-notice");
    expect(answer.status).toBe(401);
  });

  it("answers 422 to a malformed id or body, and 404 to an id the registry lacks", async () => {
    const h = setup();
    h.account("ada@example.test");
    expect((await h.send({ dryRun: true }, undefined, "Privacy_2027")).status).toBe(422);
    expect((await h.send({ dryRun: "yes" })).status).toBe(422);
    expect((await h.send({ dryRun: false, limit: 101 })).status).toBe(422);
    expect((await h.send({ dryRun: false, limit: 0 })).status).toBe(422);
    expect((await h.send({ dryRun: false, expect: "x" })).status).toBe(422);
    const unknown = await h.send({ dryRun: false }, undefined, "terms-2027-01");
    expect(unknown).toEqual({ status: 404, body: { error: "unknown_notice" } });
    expect(h.resend.calls).toEqual([]);
    expect(h.run()).toBeNull();
  });

  it("refuses with notice_changed when the approved words are not the words it holds", async () => {
    const h = setup();
    h.account("ada@example.test");
    const answer = await h.send({ dryRun: false, expect: "0".repeat(64) });
    expect(answer).toEqual({ status: 409, body: { error: "notice_changed" } });
    expect(h.resend.calls).toEqual([]);
    expect(h.run()).toBeNull();
  });

  it("answers 500 bad_registry for a registry that does not parse, and only on this route", async () => {
    const h = setup({ registry: { [NOTICE_ID]: { document: "Privacy" } } });
    h.account("ada@example.test");
    const answer = await h.send({ dryRun: true });
    expect(answer).toEqual({ status: 500, body: { error: "bad_registry" } });
    expect(h.resend.calls).toEqual([]);
  });

  it("answers 501 no_batch_transport when the mail transport has no keyed batch", async () => {
    const h = setup({ withoutKeyedBatch: true });
    h.account("ada@example.test");
    const answer = await h.send({ dryRun: false });
    expect(answer).toEqual({ status: 501, body: { error: "no_batch_transport" } });
    expect(h.run()).toBeNull();
  });
});

describe("who is mailed", () => {
  it("counts the audience in a dry run, and writes and sends nothing", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.account("bea@example.test", { deletedAt: T0 - 3_600 });
    h.account("cy@example.test", { restrictedAt: T0 - 3_600 });
    const answer = await h.send({ dryRun: true });
    expect(answer).toEqual({
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        finished: false,
        toSend: 2,
        skipped: 1,
        sentSoFar: 0,
        failedSoFar: 0,
        unconfirmed: 0,
      },
    });
    expect(h.resend.calls).toEqual([]);
    expect(h.run()).toBeNull();
  });

  it("mails each account that can still sign in or restore, once, and never one erased, restricted or newer than the run", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.account("bea@example.test", { deletedAt: T0 - 3_600 });
    h.account("cy@example.test", { restrictedAt: T0 - 3_600 });
    h.erase(h.account("dee@example.test"));
    const first = await h.send({ dryRun: false, limit: 1 });
    expect(first.status).toBe(200);
    // Signs up after the run began.
    h.clock.now = T0 + 60;
    h.account("eve@example.test", { createdAt: T0 + 30 });
    const rest = await h.sendAll();
    expect(rest.at(-1)?.body.finished).toBe(true);
    expect(recipients(h)).toEqual(["ada@example.test", "bea@example.test"]);
    expect(h.resend.delivered.every((d) => d.subject === "change-notice")).toBe(true);

    const again = await h.send({ dryRun: false });
    expect(again.body).toMatchObject({ ok: true, finished: true, sent: 0 });
    expect(recipients(h)).toHaveLength(2);

    const counts = await h.send({ dryRun: true });
    expect(counts.body).toMatchObject({ finished: true, toSend: 0, skipped: 1, sentSoFar: 2 });
    expect(h.run()).toMatchObject({ sent: 2, failed: 0, cursor: null, pending_key: null });
    for (const answer of [first, ...rest, again, counts]) expectCountsOnly(answer.body);
  });

  it("resumes after the batch it confirmed: the next call never mails the first again", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.account("bea@example.test");
    const first = await h.send({ dryRun: false, limit: 1 });
    expect(first.body).toEqual({
      ok: true,
      finished: false,
      sent: 1,
      failed: 0,
      sentSoFar: 1,
      failedSoFar: 0,
    });
    const second = await h.send({ dryRun: false, limit: 1 });
    expect(second.body).toMatchObject({ sent: 1, sentSoFar: 2 });
    expect(recipients(h)).toEqual(["ada@example.test", "bea@example.test"]);
    expect(h.resend.calls.map((c) => c.to)).toEqual([["ada@example.test"], ["bea@example.test"]]);
  });

  it("passes an address the provider refuses on its own, and counts it failed", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.account("bea@example.test");
    h.account("cy@example.test");
    h.resend.script.push({ refuse: [1] });
    const answers = await h.sendAll();
    expect(answers[0]!.body).toMatchObject({ sent: 2, failed: 1 });
    expect(recipients(h)).toEqual(["ada@example.test", "cy@example.test"]);
    expect(h.run()).toMatchObject({ sent: 2, failed: 1 });
  });
});

describe("neither skipped nor mailed twice, however a call ends", () => {
  it("retries an unknown outcome under the same key, and the provider delivers once", async () => {
    for (const step of ["accept-then-503", "hang"] as const) {
      const h = setup();
      h.account("ada@example.test");
      h.account("bea@example.test");
      h.resend.script.push(step);
      const lost = await h.send({ dryRun: false });
      expect(lost).toEqual({ status: 503, body: { error: "unknown_outcome" } });
      expect(h.run()).toMatchObject({ pending_attempts: 1, pending_refused: 0 });
      const retried = await h.send({ dryRun: false });
      expect(retried.status).toBe(200);
      expect(h.resend.calls[1]!.key).toBe(h.resend.calls[0]!.key);
      expect(h.resend.calls[1]!.to).toEqual(h.resend.calls[0]!.to);
      expect(recipients(h)).toEqual(["ada@example.test", "bea@example.test"]);
      expect(h.run()).toMatchObject({ sent: 2, pending_key: null });
    }
  });

  it("drops a key whose only attempt was refused, and sends under a new one", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.resend.script.push("429");
    const limited = await h.send({ dryRun: false });
    expect(limited).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(h.run()).toMatchObject({ pending_key: null, sent: 0 });
    const sent = await h.send({ dryRun: false });
    expect(sent.status).toBe(200);
    expect(h.resend.calls[1]!.key).not.toBe(h.resend.calls[0]!.key);
    expect(recipients(h)).toEqual(["ada@example.test"]);
  });

  it("keeps a key whose earlier attempt may have gone, when a retry is refused", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.resend.script.push("accept-then-503", "429-early");
    expect((await h.send({ dryRun: false })).status).toBe(503);
    const key = h.resend.calls[0]!.key;
    const limited = await h.send({ dryRun: false });
    expect(limited).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(h.run()).toMatchObject({ pending_key: key, pending_attempts: 2, pending_refused: 1 });
    const later = await h.send({ dryRun: false });
    expect(later.status).toBe(200);
    expect(h.resend.calls.map((c) => c.key)).toEqual([key, key, key]);
    expect(recipients(h)).toEqual(["ada@example.test"]);
  });

  it("refuses 502 on another refusal, dropping the key only when nothing could have gone", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.resend.script.push("422");
    expect(await h.send({ dryRun: false })).toEqual({ status: 502, body: { error: "refused" } });
    expect(h.run()).toMatchObject({ pending_key: null });
  });

  it("will not guess when the provider says the key carried another payload", async () => {
    const h = setup();
    const ada = h.account("ada@example.test");
    h.account("bea@example.test");
    h.resend.script.push("accept-then-503");
    expect((await h.send({ dryRun: false })).status).toBe(503);
    // An address changes before the retry, so its payload differs.
    h.sqlite.run("UPDATE accounts SET email = 'ada.new@example.test' WHERE id = ?", [ada]);
    const unsure = await h.send({ dryRun: false });
    expect(unsure).toEqual({ status: 409, body: { error: "unconfirmed_batch", unconfirmed: 2 } });
    expect(h.run()).toMatchObject({ pending_state: "unconfirmed", sent: 0 });
    // Without the operator's word it answers the same, and sends nothing.
    expect((await h.send({ dryRun: false })).body).toEqual({
      error: "unconfirmed_batch",
      unconfirmed: 2,
    });
    const dry = await h.send({ dryRun: true });
    expect(dry.body).toMatchObject({ unconfirmed: 2 });
    // With it, the batch goes again under a new key.
    const resent = await h.send({ dryRun: false, resendUnconfirmed: true });
    expect(resent.status).toBe(200);
    const keys = new Set(h.resend.calls.map((c) => c.key));
    expect(keys.size).toBe(2);
    expect(recipients(h)).toEqual([
      "ada@example.test",
      "bea@example.test",
      "ada.new@example.test",
      "bea@example.test",
    ]);
  });

  it("hands a key older than the provider keeps it to the operator", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.resend.script.push("hang");
    expect((await h.send({ dryRun: false })).status).toBe(503);
    h.clock.now = T0 + 23 * 3_600 + 1;
    const stale = await h.send({ dryRun: false });
    expect(stale).toEqual({ status: 409, body: { error: "unconfirmed_batch", unconfirmed: 1 } });
    expect(h.resend.calls).toHaveLength(1);
    const resent = await h.send({ dryRun: false, resendUnconfirmed: true });
    expect(resent.status).toBe(200);
    expect(h.resend.calls[1]!.key).not.toBe(h.resend.calls[0]!.key);
    expect(recipients(h)).toEqual(["ada@example.test"]);
  });

  it("will not send a batch in hand that is bigger than the call's limit", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.account("bea@example.test");
    h.resend.script.push("503");
    expect((await h.send({ dryRun: false, limit: 2 })).status).toBe(503);
    const capped = await h.send({ dryRun: false, limit: 1 });
    expect(capped).toEqual({ status: 409, body: { error: "pending_exceeds_limit", pending: 2 } });
    expect(h.resend.calls).toHaveLength(1);
    expect(h.run()).toMatchObject({ pending_attempts: 1 });
  });

  it("lets one of two calls at once claim a batch; the other is busy", async () => {
    const h = setup();
    h.account("ada@example.test");
    const release = Effect.runSync(Deferred.make<void>());
    h.resend.script.push({ hold: release });
    const first = h.send({ dryRun: false });
    await waitFor(() => h.resend.calls.length === 1);
    const second = await h.send({ dryRun: false });
    expect(second).toEqual({ status: 409, body: { error: "busy" } });
    Effect.runSync(Deferred.succeed(release, undefined));
    expect((await first).status).toBe(200);
    expect(recipients(h)).toEqual(["ada@example.test"]);
  });

  it("lets one of two retries at once send; the other is busy", async () => {
    const h = setup();
    h.account("ada@example.test");
    const release = Effect.runSync(Deferred.make<void>());
    h.resend.script.push("503", { hold: release });
    expect((await h.send({ dryRun: false })).status).toBe(503);
    const first = h.send({ dryRun: false });
    await waitFor(() => h.resend.calls.length === 2);
    const second = await h.send({ dryRun: false });
    expect(second).toEqual({ status: 409, body: { error: "busy" } });
    Effect.runSync(Deferred.succeed(release, undefined));
    expect((await first).status).toBe(200);
    expect(recipients(h)).toEqual(["ada@example.test"]);
    expect(new Set(h.resend.calls.map((c) => c.key)).size).toBe(1);
  });
});

describe("what moves a run without a send, and what never does", () => {
  it("sends a batch of 100 when the call allows 100", async () => {
    const h = setup();
    for (let i = 0; i < 101; i += 1) h.account(`p${String(i).padStart(3, "0")}@example.test`);
    const answer = await h.send({ dryRun: false, limit: 100 });
    expect(answer.body).toMatchObject({ sent: 100 });
    expect(h.resend.calls[0]!.to).toHaveLength(100);
  });

  it("moves past a batch in hand whose accounts were all erased since, sending nothing", async () => {
    const h = setup();
    const ada = h.account("ada@example.test");
    h.account("bea@example.test");
    h.resend.script.push("503");
    expect((await h.send({ dryRun: false, limit: 1 })).status).toBe(503);
    h.erase(ada);
    const moved = await h.send({ dryRun: false, limit: 1 });
    expect(moved.body).toMatchObject({ ok: true, finished: false, sent: 0, sentSoFar: 0 });
    expect(h.resend.calls).toHaveLength(1);
    expect(h.run()).toMatchObject({ cursor: "acc_0001", pending_key: null });
    await h.sendAll();
    expect(recipients(h)).toEqual(["bea@example.test"]);
  });

  it("keeps the key when the transport dies, and drops it when the email does not render", async () => {
    const died = setup();
    died.account("ada@example.test");
    died.resend.script.push("defect");
    expect(await died.send({ dryRun: false })).toEqual({
      status: 503,
      body: { error: "unknown_outcome" },
    });
    expect(died.run()).toMatchObject({ pending_attempts: 1, pending_refused: 0 });
    expect(died.run()?.pending_key).not.toBeNull();

    const unrendered = setup();
    unrendered.account("ada@example.test");
    unrendered.resend.script.push("render-failed");
    expect(await unrendered.send({ dryRun: false })).toEqual({
      status: 502,
      body: { error: "refused" },
    });
    expect(unrendered.run()).toMatchObject({ pending_key: null });
  });

  it("does not hand a key of exactly 23 hours to the operator: the provider still holds it", async () => {
    const h = setup();
    h.account("ada@example.test");
    h.resend.script.push("accept-then-503");
    expect((await h.send({ dryRun: false })).status).toBe(503);
    h.clock.now = T0 + 23 * 3_600;
    const retried = await h.send({ dryRun: false });
    expect(retried.status).toBe(200);
    expect(h.resend.calls.map((c) => c.key)).toEqual([
      h.resend.calls[0]!.key,
      h.resend.calls[0]!.key,
    ]);
    expect(recipients(h)).toEqual(["ada@example.test"]);
  });

  it("answers 500 internal when the database fails, and logs no address or account id", async () => {
    const h = setup();
    const ada = h.account("ada@example.test");
    h.sqlite.run("DROP TABLE change_notice_runs");
    const failed = await h.send({ dryRun: false });
    expect(failed).toEqual({ status: 500, body: { error: "internal" } });
    expect(h.resend.calls).toEqual([]);
    expect(h.logs.some((line) => JSON.stringify(line).includes("change notice call failed"))).toBe(
      true,
    );
    expectRedacted(h, [ada, "ada@example.test", SECRET], [failed]);
  });
});

describe("logs", () => {
  it("never carry an address or an account id, whatever the outcome", async () => {
    const h = setup();
    const ids = [
      h.account("ada@example.test"),
      h.account("bea@example.test"),
      h.account("cy@example.test"),
    ];
    h.resend.script.push("accept-then-503", "429");
    const answers = [
      await h.send({ dryRun: false, limit: 1 }),
      await h.send({ dryRun: false, limit: 1 }),
      await h.send({ dryRun: false, limit: 1 }),
      ...(await h.sendAll()),
    ];
    expect(h.logs.length).toBeGreaterThan(0);
    expectRedacted(
      h,
      [...ids, "ada@example.test", "bea@example.test", "cy@example.test", SECRET],
      answers,
    );
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls a fake until the call under test reaches it
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}
