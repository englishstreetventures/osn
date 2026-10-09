/**
 * Tests for sendGiftSummaryEmails — delivery of the retention sweep's parting
 * summary.
 *
 * The behaviour worth pinning is what happens when things go wrong: by the time
 * this runs the deletes have committed, so nothing here may fail the caller.
 * An owner osn-api has no address for is skipped, a bounced send costs one
 * owner their summary and no more, and an osn-api that does not answer — fails,
 * rejects or hangs until the sweep's timeout — still leaves the effect
 * successful, but is logged and counted, because no later sweep resends the
 * summary. Every owner of a wedding gets the summary, once per address.
 */

import { describe, it, expect } from "bun:test";

import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { sendGiftSummaryEmails } from "../../src/lib/gift-summary-email";
import { CIRE_METRICS, type GiftSummaryUnmailedReason } from "../../src/metrics";
import type { OsnOrganiserEmailLookup } from "../../src/services/osn-bridge";
import type { GiftSummaryNotice } from "../../src/services/retention";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";

function makeRecordingStub(): {
  layer: Layer.Layer<EmailService>;
  calls: SendEmailInput[];
} {
  const calls: SendEmailInput[] = [];
  const layer = Layer.succeed(EmailService, {
    send: (input: SendEmailInput) =>
      Effect.sync(() => {
        calls.push(input);
      }),
  });
  return { layer, calls };
}

function makeFailingStub(): Layer.Layer<EmailService> {
  return Layer.succeed(EmailService, {
    send: (_input: SendEmailInput) =>
      Effect.fail(new EmailError({ reason: "api_unreachable", cause: new Error("network gone") })),
  });
}

function notice(overrides: Partial<GiftSummaryNotice> = {}): GiftSummaryNotice {
  return {
    weddingId: "wed_1",
    weddingName: "Ada and Bo",
    ownerOsnProfileIds: ["usr_owner1"],
    currency: "AUD",
    finalEventOn: "2025-08-20",
    summary: {
      sweptOn: "2026-08-25",
      firstGiftOn: "2025-06-01",
      lastGiftOn: "2025-08-19",
      claims: { reserved: 7, purchased: 5 },
      contributions: {
        count: 3,
        totals: [
          { currency: "AUD", amountMinor: 45_000 },
          { currency: "NZD", amountMinor: 1_000 },
        ],
      },
    },
    ...overrides,
  };
}

/** A notice for a wedding whose gifts all arrived in one currency. */
function inOneCurrency(currency: string, amountMinor: number): GiftSummaryNotice {
  const base = notice();
  return notice({
    currency,
    summary: {
      ...base.summary,
      contributions: { count: 2, totals: [{ currency, amountMinor }] },
    },
  });
}

/** What `Intl` itself prints for a MAJOR-unit amount, in the runtime's locale. */
const intl = (major: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);

/** osn-api answered every call, with these addresses. */
const lookupOf =
  (pairs: Record<string, string>): OsnOrganiserEmailLookup =>
  () =>
    Promise.resolve({ answered: true, emails: new Map(Object.entries(pairs)) });

/** At least one call to osn-api failed; these are what the others returned. */
const unansweredWith =
  (pairs: Record<string, string>): OsnOrganiserEmailLookup =>
  () =>
    Promise.resolve({ answered: false, emails: new Map(Object.entries(pairs)) });

const unmailed = (reason: GiftSummaryUnmailedReason) =>
  counterValue(CIRE_METRICS.giftSummaryUnmailed, { reason });

/** The money line's total for one notice, as the email is handed it. */
async function totalFor(n: GiftSummaryNotice): Promise<unknown> {
  const { layer, calls } = makeRecordingStub();
  await Effect.runPromise(
    sendGiftSummaryEmails([n], lookupOf({ usr_owner1: "couple@example.com" })).pipe(
      Effect.provide(layer),
    ),
  );
  return (calls[0]?.data as Record<string, unknown> | undefined)?.giftTotal;
}

describe("sendGiftSummaryEmails", () => {
  it("sends one email per wedding, addressed and totalled in the wedding's currency", async () => {
    const { layer, calls } = makeRecordingStub();

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails([notice()], lookupOf({ usr_owner1: "couple@example.com" })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("couple@example.com");
    expect(calls[0]?.template).toBe("registry-gift-summary");
    const data = calls[0]?.data as Record<string, unknown>;
    expect(data.weddingName).toBe("Ada and Bo");
    expect(data.giftCount).toBe(3);
    expect(data.listPurchased).toBe(5);
    // AUD is the wedding's own currency, so it wins over the NZD row that
    // happens to sit first-equal in the totals.
    expect(data.giftTotal).toBe(intl(450, "AUD"));
  });

  it("prints a yen total without dividing it", async () => {
    // A fixed `/ 100` told a JPY wedding its gifts came to ¥10.
    expect(await totalFor(inOneCurrency("JPY", 1000))).toBe(intl(1000, "JPY"));
  });

  it("prints a dinar total to the thousandth", async () => {
    // A fixed `/ 100` told a KWD wedding its gifts came to ten times 1.500 dinar.
    const total = await totalFor(inOneCurrency("KWD", 1500));
    expect(total).toBe(intl(1.5, "KWD"));
    expect(String(total)).toContain("1.500");
  });

  it("prints a euro total from its cents", async () => {
    expect(await totalFor(inOneCurrency("EUR", 1999))).toBe(intl(19.99, "EUR"));
  });

  it("skips a wedding osn-api has no address for, and counts it", async () => {
    const { layer, calls } = makeRecordingStub();
    const before = await unmailed("no_address");

    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendGiftSummaryEmails(
          [notice(), notice({ weddingId: "wed_2", ownerOsnProfileIds: ["usr_gone"] })],
          lookupOf({ usr_owner1: "couple@example.com" }),
        ).pipe(Effect.provide(layer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("couple@example.com");
    expect(await unmailed("no_address")).toBe(before + 1);
    // osn-api answered: an owner it has no address for is not an outage.
    expect(logs).not.toContain("osn-api did not answer");
  });

  it("sends the summary to every owner of the wedding, in one lookup", async () => {
    const { layer, calls } = makeRecordingStub();
    const asked: string[][] = [];

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails(
        [notice({ ownerOsnProfileIds: ["usr_owner1", "usr_owner2"] })],
        (ids) => {
          asked.push([...ids]);
          return Promise.resolve({
            answered: true,
            emails: new Map([
              ["usr_owner1", "ada@example.com"],
              ["usr_owner2", "bo@example.com"],
            ]),
          });
        },
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(asked).toEqual([["usr_owner1", "usr_owner2"]]);
    expect(calls.map((c) => c.to).toSorted()).toEqual(["ada@example.com", "bo@example.com"]);
    // The same summary to each.
    expect(calls[0]?.data).toEqual(calls[1]?.data);
  });

  it("sends once to an address two owners share", async () => {
    const { layer, calls } = makeRecordingStub();

    await Effect.runPromise(
      sendGiftSummaryEmails(
        [notice({ ownerOsnProfileIds: ["usr_owner1", "usr_owner2"] })],
        lookupOf({ usr_owner1: "us@example.com", usr_owner2: "us@example.com" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(calls.map((c) => c.to)).toEqual(["us@example.com"]);
  });

  it("still mails one owner when the other has no address, or the other's send fails", async () => {
    const calls: SendEmailInput[] = [];
    const layer = Layer.succeed(EmailService, {
      send: (input: SendEmailInput) =>
        input.to === "bounce@example.com"
          ? Effect.fail(new EmailError({ reason: "api_unreachable", cause: new Error("bounced") }))
          : Effect.sync(() => {
              calls.push(input);
            }),
    });

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails(
        [notice({ ownerOsnProfileIds: ["usr_bounce", "usr_gone", "usr_owner1"] })],
        lookupOf({ usr_bounce: "bounce@example.com", usr_owner1: "couple@example.com" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls.map((c) => c.to)).toEqual(["couple@example.com"]);
  });

  it("succeeds when the transport rejects every send", async () => {
    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails([notice()], lookupOf({ usr_owner1: "couple@example.com" })).pipe(
        Effect.provide(makeFailingStub()),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("warns and counts when osn-api did not answer, naming no owner", async () => {
    const { layer, calls } = makeRecordingStub();
    const before = await unmailed("lookup_failed");

    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendGiftSummaryEmails(
          [notice(), notice({ weddingId: "wed_2", ownerOsnProfileIds: ["usr_owner2"] })],
          unansweredWith({}),
        ).pipe(Effect.provide(layer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    expect(calls).toHaveLength(0);
    expect(logs).toContain("osn-api did not answer");
    // Counts only: no profile id and no address reaches the log line.
    expect(logs).not.toContain("usr_owner");
    expect(logs).not.toContain("@example.com");
    expect(await unmailed("lookup_failed")).toBe(before + 2);
  });

  it("still mails the owners osn-api did answer for when another call failed", async () => {
    const { layer, calls } = makeRecordingStub();
    const before = await unmailed("lookup_failed");

    const logs = await captureLogs(async () => {
      await Effect.runPromise(
        sendGiftSummaryEmails(
          [notice(), notice({ weddingId: "wed_2", ownerOsnProfileIds: ["usr_owner2"] })],
          unansweredWith({ usr_owner1: "couple@example.com" }),
        ).pipe(Effect.provide(layer)),
      );
    });

    // No later sweep resends a summary, so what did resolve is sent now.
    expect(calls.map((c) => c.to)).toEqual(["couple@example.com"]);
    expect(logs).toContain("osn-api did not answer");
    expect(await unmailed("lookup_failed")).toBe(before + 1);
  });

  it("treats a lookup that rejects as osn-api not answering", async () => {
    const { layer, calls } = makeRecordingStub();
    const before = await unmailed("lookup_failed");

    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendGiftSummaryEmails([notice()], () => Promise.reject(new Error("osn-api 500"))).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    expect(calls).toHaveLength(0);
    expect(logs).toContain("osn-api did not answer");
    expect(await unmailed("lookup_failed")).toBe(before + 1);
  });

  it("warns and counts when osn-api hangs until the caller's timeout", async () => {
    const { layer, calls } = makeRecordingStub();
    const before = await unmailed("lookup_failed");

    // The sweep bounds the notifier with `Effect.timeout`; a hung osn-api is
    // the most likely outage, and its interrupt must still be reported.
    const logs = await captureLogs(async () => {
      await Effect.runPromiseExit(
        sendGiftSummaryEmails(
          [notice(), notice({ weddingId: "wed_2", ownerOsnProfileIds: ["usr_owner2"] })],
          () => new Promise(() => {}),
        ).pipe(Effect.provide(layer), Effect.timeout("20 millis")),
      );
    });

    expect(calls).toHaveLength(0);
    expect(logs).toContain("osn-api did not answer");
    expect(await unmailed("lookup_failed")).toBe(before + 2);
  });

  it("sends the whole cohort in one batch call when the transport takes batches", async () => {
    const batches: SendEmailInput[][] = [];
    const layer = Layer.succeed(EmailService, {
      send: () => Effect.die(new Error("a batch-capable transport is sent one batch")),
      sendBatch: (inputs: readonly SendEmailInput[]) =>
        Effect.sync(() => {
          batches.push([...inputs]);
        }),
    });

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails(
        [
          notice({ ownerOsnProfileIds: ["usr_owner1", "usr_owner2"] }),
          notice({ weddingId: "wed_2", ownerOsnProfileIds: ["usr_owner3"] }),
        ],
        lookupOf({
          usr_owner1: "ada@example.com",
          usr_owner2: "bo@example.com",
          usr_owner3: "cy@example.com",
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    // One provider call for every recipient: each send is an external
    // subrequest, and the cron's whole invocation shares a small budget.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((input) => input.to).toSorted()).toEqual([
      "ada@example.com",
      "bo@example.com",
      "cy@example.com",
    ]);
  });

  it("logs a failed batch once and still succeeds", async () => {
    const layer = Layer.succeed(EmailService, {
      send: () => Effect.die(new Error("a batch-capable transport is sent one batch")),
      sendBatch: () => Effect.fail(new EmailError({ reason: "rate_limited" })),
    });

    let ok = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendGiftSummaryEmails([notice()], lookupOf({ usr_owner1: "couple@example.com" })).pipe(
          Effect.provide(layer),
        ),
      );
      ok = Exit.isSuccess(exit);
    });

    expect(ok).toBe(true);
    expect(logs).toContain("batch send failed");
    expect(logs).not.toContain("couple@example.com");
  });

  it("labels a defect in delivery as a defect, and still succeeds", async () => {
    // A transport that throws instead of failing never reaches the per-send
    // catch; the outer one must hold it.
    const layer = Layer.succeed(EmailService, {
      send: () => {
        throw new Error("transport bug");
      },
    });

    let ok = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendGiftSummaryEmails([notice()], lookupOf({ usr_owner1: "couple@example.com" })).pipe(
          Effect.provide(layer),
        ),
      );
      ok = Exit.isSuccess(exit);
    });

    expect(ok).toBe(true);
    expect(logs).toContain("summary delivery failed");
    expect(logs).toContain("defect");
  });

  it("does nothing at all for an empty cohort", async () => {
    const { layer, calls } = makeRecordingStub();
    let lookedUp = false;

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails([], () => {
        lookedUp = true;
        return Promise.resolve({ answered: true, emails: new Map() });
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(lookedUp).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
