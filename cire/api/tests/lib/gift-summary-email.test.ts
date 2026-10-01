/**
 * Tests for sendGiftSummaryEmails — delivery of the retention sweep's parting
 * summary.
 *
 * The behaviour worth pinning is what happens when things go wrong: by the time
 * this runs the deletes have committed, so nothing here may fail the caller.
 * An owner whose address osn-api could not resolve is skipped silently, a
 * bounced send costs one owner their summary and no more, and a lookup that
 * throws outright still leaves the effect successful. Every owner of a wedding
 * gets the summary, once per address.
 */

import { describe, it, expect } from "bun:test";

import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { sendGiftSummaryEmails, type OrganiserEmailLookup } from "../../src/lib/gift-summary-email";
import type { GiftSummaryNotice } from "../../src/services/retention";

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

const lookupOf =
  (pairs: Record<string, string>): OrganiserEmailLookup =>
  () =>
    Promise.resolve(new Map(Object.entries(pairs)));

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
    expect(String(data.giftTotal)).toContain("450");
  });

  it("skips a wedding whose address the lookup could not answer for", async () => {
    const { layer, calls } = makeRecordingStub();

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails(
        [notice(), notice({ weddingId: "wed_2", ownerOsnProfileIds: ["usr_gone"] })],
        lookupOf({ usr_owner1: "couple@example.com" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("couple@example.com");
  });

  it("sends the summary to every owner of the wedding, in one lookup", async () => {
    const { layer, calls } = makeRecordingStub();
    const asked: string[][] = [];

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails(
        [notice({ ownerOsnProfileIds: ["usr_owner1", "usr_owner2"] })],
        (ids) => {
          asked.push([...ids]);
          return Promise.resolve(
            new Map([
              ["usr_owner1", "ada@example.com"],
              ["usr_owner2", "bo@example.com"],
            ]),
          );
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

  it("succeeds when the address lookup itself throws", async () => {
    const { layer, calls } = makeRecordingStub();

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails([notice()], () => Promise.reject(new Error("osn-api 500"))).pipe(
        Effect.provide(layer),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does nothing at all for an empty cohort", async () => {
    const { layer, calls } = makeRecordingStub();
    let lookedUp = false;

    const exit = await Effect.runPromiseExit(
      sendGiftSummaryEmails([], () => {
        lookedUp = true;
        return Promise.resolve(new Map());
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(lookedUp).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
