/**
 * Tests for sendGiftSummaryEmails — delivery of the retention sweep's parting
 * summary.
 *
 * The behaviour worth pinning is what happens when things go wrong: by the time
 * this runs the deletes have committed, so nothing here may fail the caller.
 * A wedding whose address osn-api could not resolve is skipped silently, a
 * bounced send costs one couple its summary and no more, and a lookup that
 * throws outright still leaves the effect successful.
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
    ownerOsnProfileId: "usr_owner1",
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
        [notice(), notice({ weddingId: "wed_2", ownerOsnProfileId: "usr_gone" })],
        lookupOf({ usr_owner1: "couple@example.com" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("couple@example.com");
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
