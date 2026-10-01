import { describe, it, expect } from "bun:test";

import { EmailError, EmailService } from "@shared/email";
import type { SendEmailInput } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { createOwnerNotices, formatRestoreUntil } from "../../src/lib/owner-notice-email";
import type { OwnerNoticeDeps } from "../../src/lib/owner-notice-email";
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
  const layer = Layer.succeed(EmailService, {
    send: () => Effect.die("send should not be called when sendBatch exists"),
    sendBatch: (inputs) =>
      fail
        ? Effect.fail(new EmailError({ reason: "dispatch_failed" }))
        : Effect.sync(() => {
            batches.push([...inputs]);
          }),
  });
  return { layer, batches };
}

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
    throttle: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
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

  it("counts by the acting owner too, so a new wedding does not reset the throttle", async () => {
    const { notices, run, transport } = setup({
      throttle: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
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
    await run(
      down.notices.deleteStarted({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        restoreUntil: new Date(),
        restoreDays: 7,
      }),
    );
    expect(down.transport.batches).toEqual([]);
  });

  it("sends no delete notice to a sole owner", async () => {
    const { notices, run, transport } = setup({}, ["usr_a"]);
    await run(
      notices.deleteStarted({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        restoreUntil: new Date(),
        restoreDays: 7,
      }),
    );
    expect(transport.batches).toEqual([]);
  });
});

describe("formatRestoreUntil", () => {
  it("prints the instant in UTC", () => {
    expect(formatRestoreUntil(new Date("2026-10-09T14:05:00Z"))).toBe(
      "9 October 2026 at 14:05 UTC",
    );
  });
});
