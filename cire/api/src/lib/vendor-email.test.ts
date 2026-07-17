/**
 * Tests for sendClaimInviteEmail — the fail-soft vendor claim-link emailer.
 *
 * Two scenarios:
 * 1. Happy path: stub transport records the send call; assert `to` and `claimUrl`
 *    appear in the call, and the effect succeeds.
 * 2. Fail-soft: stub transport rejects; assert the effect STILL succeeds
 *    (Exit.isSuccess) — a broken transport must never propagate to the caller.
 */

import { describe, it, expect } from "bun:test";

import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { sendClaimInviteEmail } from "./vendor-email";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub EmailService layer that records calls into `calls`. */
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

/** Build a stub EmailService layer whose `send` always fails. */
function makeFailingStub(): Layer.Layer<EmailService> {
  return Layer.succeed(EmailService, {
    send: (_input: SendEmailInput) =>
      Effect.fail(new EmailError({ reason: "api_unreachable", cause: new Error("network gone") })),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendClaimInviteEmail", () => {
  it("calls send once with the correct to, template, and claimUrl in the data", async () => {
    const { layer, calls } = makeRecordingStub();

    const exit = await Effect.runPromiseExit(
      sendClaimInviteEmail({
        to: "vendor@example.com",
        claimUrl: "https://host.cireweddings.com/claim/abc123",
        vendorName: "Amazing Photos Co.",
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.to).toBe("vendor@example.com");
    expect(call.template).toBe("vendor-claim-invite");
    // The claimUrl must appear in the template data so the email body can carry it.
    expect((call.data as { claimUrl: string }).claimUrl).toBe(
      "https://host.cireweddings.com/claim/abc123",
    );
  });

  it("succeeds (fail-soft) even when the transport rejects", async () => {
    const failLayer = makeFailingStub();

    const exit = await Effect.runPromiseExit(
      sendClaimInviteEmail({
        to: "vendor@example.com",
        claimUrl: "https://host.cireweddings.com/claim/abc123",
        vendorName: "Amazing Photos Co.",
      }).pipe(Effect.provide(failLayer)),
    );

    // The error channel is `never` — a transport failure MUST NOT propagate.
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("succeeds (fail-soft) when the transport throws a defect", async () => {
    const defectLayer = Layer.succeed(EmailService, {
      send: (_input: SendEmailInput) => Effect.dieMessage("unexpected defect in transport"),
    });

    const exit = await Effect.runPromiseExit(
      sendClaimInviteEmail({
        to: "vendor@example.com",
        claimUrl: "https://host.cireweddings.com/claim/xyz",
        vendorName: "",
      }).pipe(Effect.provide(defectLayer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
