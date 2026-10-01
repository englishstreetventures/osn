import { describe, expect, it } from "bun:test";

import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { sendClaimReviewAlert } from "../../src/lib/claim-review-email";
import { captureLogs } from "../test-helpers/capture-logs";

const input = {
  to: "ops@example.test",
  env: "production" as const,
  summary: { pending: 2, oldestWaitingDays: 4 },
};

describe("sendClaimReviewAlert", () => {
  it("sends one counts-only reminder to the operator address", async () => {
    const calls: SendEmailInput[] = [];
    const layer = Layer.succeed(EmailService, {
      send: (msg: SendEmailInput) => Effect.sync(() => void calls.push(msg)),
    });
    const exit = await Effect.runPromiseExit(
      sendClaimReviewAlert(input).pipe(Effect.provide(layer)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual([
      {
        template: "vendor-claim-review-pending",
        to: "ops@example.test",
        data: { pending: 2, oldestWaitingDays: 4, env: "production" },
      },
    ]);
  });

  it("absorbs a transport failure and logs it", async () => {
    const layer = Layer.succeed(EmailService, {
      send: () => Effect.fail(new EmailError({ reason: "api_unreachable" })),
    });
    let ok = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        sendClaimReviewAlert(input).pipe(Effect.provide(layer)),
      );
      ok = Exit.isSuccess(exit);
    });
    expect(ok).toBe(true);
    expect(logs).toContain("operator reminder send failed");
  });
});
