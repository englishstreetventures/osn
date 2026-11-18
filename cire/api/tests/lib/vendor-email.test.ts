/**
 * Tests for sendClaimInviteEmail — the fail-soft vendor claim-link emailer.
 * A transport that dies (a defect, not a failure) still leaves the effect
 * succeeding with `false`. The sent link and a transport that rejects are
 * checked through the route, in routes/vendors.test.ts.
 */

import { describe, it, expect } from "bun:test";

import { EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { sendClaimInviteEmail } from "../../src/lib/vendor-email";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendClaimInviteEmail", () => {
  it("succeeds (fail-soft) when the transport throws a defect", async () => {
    const defectLayer = Layer.succeed(EmailService, {
      send: (_input: SendEmailInput) => Effect.die(new Error("unexpected defect in transport")),
    });

    const exit = await Effect.runPromiseExit(
      sendClaimInviteEmail({
        to: "vendor@example.com",
        claimUrl: "https://host.cireweddings.com/claim/xyz",
        vendorName: "",
      }).pipe(Effect.provide(defectLayer)),
    );

    expect(Exit.isSuccess(exit) && exit.value === false).toBe(true);
  });
});
