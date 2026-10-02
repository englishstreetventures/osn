import { describe, it, expect } from "bun:test";

import { EmailError, EmailService } from "@shared/email";
import type { SendEmailInput } from "@shared/email";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { createOwnerNotices, formatRestoreUntil } from "../../src/lib/owner-notice-email";
import type { OwnerNoticeDeps } from "../../src/lib/owner-notice-email";
import { CIRE_METRICS } from "../../src/metrics";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

/**
 * The sender on its own, through a transport that has `sendBatch` the way the
 * Resend one does — the route tests use the log transport, which has none.
 */

const ADDRESSES: Record<string, string> = {
  usr_a: "a@example.test",
  usr_b: "b@example.test",
  usr_c: "Shared@example.test",
  usr_d: "shared@example.test",
};

function batchTransport(fail = false) {
  const batches: SendEmailInput[][] = [];
  const attempts = { count: 0 };
  const layer = Layer.succeed(EmailService, {
    send: () => Effect.die("send should not be called when sendBatch exists"),
    sendBatch: (inputs) =>
      Effect.suspend(() => {
        attempts.count += 1;
        if (fail) return Effect.fail(new EmailError({ reason: "dispatch_failed" }));
        batches.push([...inputs]);
        return Effect.void;
      }),
  });
  return { layer, batches, attempts };
}

const noticeCount = (kind: "owner_change" | "delete_started", result: string) =>
  counterValue(CIRE_METRICS.ownerNotice, { kind, result });

function setup(
  overrides: Partial<OwnerNoticeDeps> = {},
  owners = ["usr_a", "usr_b", "usr_c", "usr_d"],
) {
  const db = createDb(":memory:");
  for (const id of ["wed_one", "wed_two"]) {
    insertWedding(db, { id, slug: id, displayName: `Wedding ${id}`, owners });
  }
  const transport = batchTransport();
  const notices = createOwnerNotices({
    lookup: async (ids) => ({
      answered: true,
      emails: new Map(ids.flatMap((id) => (ADDRESSES[id] ? [[id, ADDRESSES[id]] as const] : []))),
    }),
    emailLayer: transport.layer,
    portalUrl: "https://host.example.test",
    ...overrides,
  });
  const run = (eff: Effect.Effect<void, never, DbService>) =>
    Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
  return { notices, run, transport };
}

describe("createOwnerNotices", () => {
  it("sends one batch, one email per distinct address", async () => {
    const { notices, run, transport } = setup();
    await run(
      notices.ownerChanged({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        subjectOsnProfileId: "usr_b",
        change: "removed",
      }),
    );
    expect(transport.batches).toHaveLength(1);
    const [batch] = transport.batches;
    // usr_c and usr_d share an inbox, which gets one copy.
    expect(batch?.map((m) => m.to)).toEqual([
      "b@example.test",
      "a@example.test",
      "Shared@example.test",
    ]);
    expect(
      batch?.map((m) => (m.template === "wedding-owner-change" ? m.data.audience : null)),
    ).toEqual(["subject", "actor", "owner"]);
  });

  it("counts by the acting owner too, so a new wedding does not reset the budget", async () => {
    const { notices, run, transport } = setup({
      emailsPerDay: 3,
    });
    const removeB = (weddingId: string) =>
      notices.ownerChanged({
        weddingId,
        actorOsnProfileId: "usr_a",
        subjectOsnProfileId: "usr_b",
        change: "removed",
      });
    await run(removeB("wed_one"));
    await run(removeB("wed_two"));
    expect(transport.batches).toHaveLength(1);
  });

  it("never fails when the transport or the lookup does", async () => {
    const failing = batchTransport(true);
    const { notices, run } = setup({ emailLayer: failing.layer });
    await run(
      notices.deleteStarted({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        restoreUntil: new Date(),
        restoreDays: 7,
      }),
    );

    const down = setup({ lookup: async () => ({ answered: false, emails: new Map() }) });
    await down.run(
      down.notices.deleteStarted({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        restoreUntil: new Date(),
        restoreDays: 7,
      }),
    );
    expect(down.transport.batches).toEqual([]);
  });

  it("tells a sole owner of their own delete, from the actor's budget alone", async () => {
    // The wedding's budget is already spent; the delete notice does not use it.
    const { notices, run, transport } = setup({ emailsPerDay: 1 }, ["usr_a"]);
    await run(
      notices.ownerChanged({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_x",
        subjectOsnProfileId: "usr_b",
        change: "removed",
      }),
    );
    transport.batches.length = 0;
    await run(
      notices.deleteStarted({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        restoreUntil: new Date(),
        restoreDays: 7,
      }),
    );
    expect(transport.batches.map((b) => b.map((m) => m.to))).toEqual([["a@example.test"]]);
    const [mail] = transport.batches[0] ?? [];
    expect(mail?.template === "wedding-delete-started" && mail.data.audience).toBe("actor");
  });
});

describe("formatRestoreUntil", () => {
  it("prints the instant in UTC", () => {
    expect(formatRestoreUntil(new Date("2026-10-09T14:05:00Z"))).toBe(
      "9 October 2026 at 14:05 UTC",
    );
  });
});

describe("createOwnerNotices — each way a notice ends", () => {
  const removeB = (actor = "usr_a") => ({
    weddingId: "wed_one",
    actorOsnProfileId: actor,
    subjectOsnProfileId: "usr_b",
    change: "removed" as const,
  });

  it("swallows a failed batch send, counted as failed", async () => {
    const failing = batchTransport(true);
    const { notices, run } = setup({ emailLayer: failing.layer });
    const before = await noticeCount("owner_change", "failed");
    await run(notices.ownerChanged(removeB()));
    expect(failing.attempts.count).toBe(1);
    expect(await noticeCount("owner_change", "failed")).toBe(before + 1);
  });

  it("mails whoever osn-api did answer for, even when another call failed", async () => {
    const { notices, run, transport } = setup({
      lookup: async () => ({ answered: false, emails: new Map([["usr_b", "b@example.test"]]) }),
    });
    const before = await noticeCount("owner_change", "sent");
    await run(notices.ownerChanged(removeB()));
    expect(transport.batches.map((b) => b.map((m) => m.to))).toEqual([["b@example.test"]]);
    expect(await noticeCount("owner_change", "sent")).toBe(before + 1);
  });

  it("counts an answer with no addresses as no recipients", async () => {
    const { notices, run, transport } = setup({
      lookup: async () => ({ answered: true, emails: new Map() }),
    });
    const before = await noticeCount("owner_change", "no_recipients");
    await run(notices.ownerChanged(removeB()));
    expect(transport.batches).toEqual([]);
    expect(await noticeCount("owner_change", "no_recipients")).toBe(before + 1);
  });

  it("still sends, with generic names, when the display lookup throws", async () => {
    const { notices, run, transport } = setup({
      resolveDisplays: async () => {
        throw new Error("osn-api down");
      },
    });
    await run(notices.ownerChanged(removeB()));
    const [batch] = transport.batches;
    const toB = batch?.find((m) => m.to === "b@example.test");
    expect(toB?.template === "wedding-owner-change" && toB.data.actorName).toBeNull();
  });

  it("spends the wedding's budget across owners taking turns", async () => {
    const { notices, run, transport } = setup({
      emailsPerDay: 3,
    });
    const before = await noticeCount("owner_change", "throttled");
    await run(notices.ownerChanged(removeB("usr_a")));
    await run(notices.ownerChanged(removeB("usr_c")));
    expect(transport.batches).toHaveLength(1);
    expect(await noticeCount("owner_change", "throttled")).toBe(before + 1);
  });
});
