import { describe, it, expect } from "bun:test";

import { weddingHosts } from "@cire/db";
import { EmailError, EmailService } from "@shared/email";
import type { SendEmailInput } from "@shared/email";
import { LEGAL_ENTITY } from "@shared/legal";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { createOwnerNotices, formatRestoreUntil } from "../../src/lib/owner-notice-email";
import type { OwnerNoticeDeps } from "../../src/lib/owner-notice-email";
import { CIRE_METRICS } from "../../src/metrics";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding, ownerSeat } from "../test-helpers/wedding";

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
  return { notices, run, transport, db };
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

describe("createOwnerNotices — an upgrade refund", () => {
  /**
   * Every owner hears that a payment for the wedding was refunded, with the
   * amount and where to write; it names no reason, since the reason can be
   * another owner's act.
   */
  it("tells every owner, once each, with the tier, the amount and cire's address", async () => {
    const { notices, run, transport } = setup({}, ["usr_a", "usr_b"]);
    const before = await counterValue(CIRE_METRICS.ownerNotice, {
      kind: "upgrade_refund",
      result: "sent",
    });
    await run(
      notices.refundIssued({
        weddingId: "wed_one",
        tier: "gold",
        amountMinor: 7900,
        currency: "AUD",
      }),
    );
    expect(transport.batches.map((b) => b.map((m) => m.to))).toEqual([
      ["a@example.test", "b@example.test"],
    ]);
    const [mail] = transport.batches[0] ?? [];
    expect(mail?.template).toBe("upgrade-refund");
    if (mail?.template === "upgrade-refund") {
      expect(mail.data).toEqual({
        weddingName: "Wedding wed_one",
        tierName: "Gold",
        amount: "A$79.00",
        contactEmail: LEGAL_ENTITY.supportEmail,
        portalUrl: "https://host.example.test",
      });
    }
    expect(
      await counterValue(CIRE_METRICS.ownerNotice, { kind: "upgrade_refund", result: "sent" }),
    ).toBe(before + 1);
  });

  it("still tells the owners of a wedding they deleted, which is the usual case", async () => {
    const { notices, run, transport, db } = setup({}, ["usr_a", "usr_b"]);
    db.$client.exec("UPDATE weddings SET deleted_at = unixepoch() WHERE id = 'wed_one'");
    await run(
      notices.refundIssued({
        weddingId: "wed_one",
        tier: "gold",
        amountMinor: 7900,
        currency: "AUD",
      }),
    );
    expect(transport.batches.map((b) => b.map((m) => m.to))).toEqual([
      ["a@example.test", "b@example.test"],
    ]);
  });

  it("names no tier and no amount it does not have", async () => {
    for (const [amountMinor, currency] of [
      [null, null],
      [7900, null],
      [null, "AUD"],
    ] as const) {
      const { notices, run, transport } = setup({}, ["usr_a"]);
      await run(notices.refundIssued({ weddingId: "wed_one", tier: null, amountMinor, currency }));
      const [mail] = transport.batches[0] ?? [];
      expect(
        mail?.template === "upgrade-refund" && mail.data,
        `${amountMinor} ${currency}`,
      ).toMatchObject({
        tierName: null,
        amount: null,
      });
    }
  });

  /** The caller records the owners as told only on a notice that went out. */
  it("says whether it mailed anyone", async () => {
    const sent = setup({}, ["usr_a"]);
    const answer = (n: typeof sent) =>
      Effect.runPromise(
        n.notices
          .refundIssued({ weddingId: "wed_one", tier: "gold", amountMinor: 7900, currency: "AUD" })
          .pipe(Effect.provideService(DbService, n.db)),
      );
    expect(await answer(sent)).toBe(true);
    const nobody = setup({}, ["usr_z"]);
    expect(await answer(nobody)).toBe(false);
  });

  /**
   * A refund notice spends a budget of the wedding's own: it has no acting
   * owner, so it must not share one platform-wide key.
   */
  it("spends only the wedding's own budget", async () => {
    const { notices, run, transport } = setup({ emailsPerDay: 2 }, ["usr_a"]);
    const refund = (weddingId: string) =>
      notices.refundIssued({ weddingId, tier: "gold", amountMinor: 7900, currency: "AUD" });
    await run(refund("wed_one"));
    await run(refund("wed_two"));
    await run(refund("wed_one"));
    expect(transport.batches).toHaveLength(3);
    const before = await counterValue(CIRE_METRICS.ownerNotice, {
      kind: "upgrade_refund",
      result: "throttled",
    });
    await run(refund("wed_one"));
    expect(transport.batches).toHaveLength(3);
    expect(
      await counterValue(CIRE_METRICS.ownerNotice, { kind: "upgrade_refund", result: "throttled" }),
    ).toBe(before + 1);
  });

  /**
   * Refund notices and owner-change notices spend different keys: refunds an
   * owner set off cannot use up the budget an owner's removal is told from,
   * and owner changes cannot leave a refund untold.
   */
  it("leaves the owner-change budget alone, and the other way round", async () => {
    // Two owners: each notice is two emails, the whole of a day's budget.
    const { notices, run, transport } = setup({ emailsPerDay: 2 }, ["usr_a", "usr_b"]);
    const refund = () =>
      notices.refundIssued({
        weddingId: "wed_one",
        tier: "gold",
        amountMinor: 7900,
        currency: "AUD",
      });
    const change = () =>
      notices.ownerChanged({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        subjectOsnProfileId: "usr_b",
        change: "removed",
      });
    await run(refund());
    await run(refund());
    expect(transport.batches).toHaveLength(1);
    await run(change());
    expect(transport.batches).toHaveLength(2);
    await run(change());
    expect(transport.batches).toHaveLength(2);
  });

  it("sends nothing for a wedding that is gone", async () => {
    const { notices, run, transport } = setup();
    await run(
      notices.refundIssued({
        weddingId: "wed_gone",
        tier: "gold",
        amountMinor: 7900,
        currency: "AUD",
      }),
    );
    expect(transport.batches).toEqual([]);
  });
});

/**
 * An owner retired the Stripe account money gifts are paid into. Every owner
 * hears of it, so a replace while the holder is seated always reaches the
 * holder; an absent holder is not an owner and hears nothing. The notice
 * spends a budget of its own for the wedding, so owner changes cannot use up
 * the budget a replace is told from.
 */
describe("createOwnerNotices — a payout account retired", () => {
  type Retired = Parameters<ReturnType<typeof createOwnerNotices>["payoutRetired"]>[0];
  const retired = (over: Partial<Retired> = {}): Retired => ({
    weddingId: "wed_one",
    actorOsnProfileId: "usr_a",
    reason: "disconnected",
    handToOsnProfileId: null,
    holderOsnProfileId: null,
    ...over,
  });

  const copies = (batch: SendEmailInput[] | undefined) =>
    (batch ?? []).map((m) =>
      m.template === "registry-payout-retired" ? [m.to, m.data.audience] : [m.to, null],
    );

  it("tells every owner of a hand-over, the named owner in words of their own", async () => {
    const { notices, run, transport } = setup({}, ["usr_a", "usr_b", "usr_c"]);
    await run(
      notices.payoutRetired(retired({ reason: "handed_over", handToOsnProfileId: "usr_b" })),
    );
    expect(copies(transport.batches[0])).toEqual([
      ["b@example.test", "named"],
      ["a@example.test", "actor"],
      ["Shared@example.test", "owner"],
    ]);
    const named = transport.batches[0]?.[0];
    expect(named?.template).toBe("registry-payout-retired");
    if (named?.template === "registry-payout-retired") {
      expect(named.data.reason).toBe("handed_over");
      expect(named.data.moneyGiftsUrl).toBe(
        "https://host.example.test/#/w/wed_one/registry/settings",
      );
    }
  });

  it("tells every owner of a disconnect", async () => {
    const { notices, run, transport } = setup({}, ["usr_a", "usr_b"]);
    await run(notices.payoutRetired(retired()));
    expect(copies(transport.batches[0])).toEqual([
      ["a@example.test", "actor"],
      ["b@example.test", "owner"],
    ]);
  });

  it("tells the seated holder whose account another owner replaced", async () => {
    const { notices, run, transport } = setup({}, ["usr_a", "usr_b", "usr_c"]);
    await run(
      notices.payoutRetired(
        retired({ actorOsnProfileId: "usr_b", reason: "replaced", holderOsnProfileId: "usr_a" }),
      ),
    );
    expect(copies(transport.batches[0])).toEqual([
      ["a@example.test", "holder"],
      ["b@example.test", "actor"],
      ["Shared@example.test", "owner"],
    ]);
  });

  it("tells every owner of an absent holder's account, and not the holder", async () => {
    const { notices, run, transport, db } = setup({}, ["usr_a", "usr_b"]);
    // usr_c held the account and now sits below owner.
    db.insert(weddingHosts)
      .values({ ...ownerSeat("wed_one", "usr_c"), role: "editor" })
      .run();
    await run(notices.payoutRetired(retired({ reason: "holder_absent" })));
    expect(copies(transport.batches[0])).toEqual([
      ["a@example.test", "actor"],
      ["b@example.test", "owner"],
    ]);
  });

  it("does not mail an owner the actor seated in the last day, named or not", async () => {
    const { notices, run, transport, db } = setup({}, ["usr_a"]);
    // Two strangers the actor made owners an hour ago, with no say in it.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const id of ["usr_b", "usr_c"]) {
      db.insert(weddingHosts)
        .values({ ...ownerSeat("wed_one", id, anHourAgo), addedByOsnProfileId: "usr_a" })
        .run();
    }
    await run(
      notices.payoutRetired(retired({ reason: "handed_over", handToOsnProfileId: "usr_b" })),
    );
    expect(copies(transport.batches[0])).toEqual([["a@example.test", "actor"]]);
  });

  it("still mails a replaced holder the actor seated in the last day: they connected it", async () => {
    const { notices, run, transport, db } = setup({}, ["usr_b"]);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    db.insert(weddingHosts)
      .values({ ...ownerSeat("wed_one", "usr_a", anHourAgo), addedByOsnProfileId: "usr_b" })
      .run();
    await run(
      notices.payoutRetired(
        retired({ actorOsnProfileId: "usr_b", reason: "replaced", holderOsnProfileId: "usr_a" }),
      ),
    );
    expect(copies(transport.batches[0])).toEqual([
      ["a@example.test", "holder"],
      ["b@example.test", "actor"],
    ]);
  });

  it("is told even when owner changes have spent the wedding's budget, and spends only its own", async () => {
    // Two owners: each notice is two emails, the whole of a day's budget.
    const { notices, run, transport } = setup({ emailsPerDay: 2 }, ["usr_a", "usr_b"]);
    const change = () =>
      notices.ownerChanged({
        weddingId: "wed_one",
        actorOsnProfileId: "usr_a",
        subjectOsnProfileId: "usr_b",
        change: "removed",
      });
    await run(change());
    expect(transport.batches).toHaveLength(1);
    // The wedding's and the actor's budgets are spent; the retire is told.
    await run(notices.payoutRetired(retired()));
    expect(transport.batches).toHaveLength(2);
    // And owner changes still have nothing left, so the retire spent neither.
    await run(change());
    expect(transport.batches).toHaveLength(2);
    // A second retire the same day finds its own budget spent.
    await run(notices.payoutRetired(retired()));
    expect(transport.batches).toHaveLength(2);
  });

  it("always tells the holder of a replace, however many retires came before it", async () => {
    // Retires earlier in the day have spent the wedding's retire budget. Each
    // replace needs the holder to have connected an account again, so their
    // copy is never what a budget bounds.
    const { notices, run, transport } = setup({ emailsPerDay: 2 }, ["usr_a", "usr_b"]);
    await run(notices.payoutRetired(retired()));
    expect(transport.batches).toHaveLength(1);
    await run(
      notices.payoutRetired(
        retired({ actorOsnProfileId: "usr_b", reason: "replaced", holderOsnProfileId: "usr_a" }),
      ),
    );
    expect(transport.batches).toHaveLength(2);
    expect(copies(transport.batches[1])).toEqual([["a@example.test", "holder"]]);
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

  it("keeps one wedding's and one owner's budget apart from another's", async () => {
    const { notices, run, transport } = setup({
      emailsPerDay: 3,
    });
    const removeUsrB = (weddingId: string, actorOsnProfileId: string) =>
      notices.ownerChanged({
        weddingId,
        actorOsnProfileId,
        subjectOsnProfileId: "usr_b",
        change: "removed",
      });
    await run(removeUsrB("wed_one", "usr_a"));
    await run(removeUsrB("wed_two", "usr_c"));
    expect(transport.batches).toHaveLength(2);
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
