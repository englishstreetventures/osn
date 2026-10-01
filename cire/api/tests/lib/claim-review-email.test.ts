import { describe, expect, it } from "bun:test";

import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { Effect, Exit, Layer } from "effect";

import { claimReviewAlertTarget, sendClaimReviewAlert } from "../../src/lib/claim-review-email";
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

describe("claimReviewAlertTarget", () => {
  const base = { CIRE_OPS_EMAIL: " ops@example.test ", RESEND_API_KEY: "re_x" };

  it("trims the address and maps the tier to the script's --env", () => {
    expect(claimReviewAlertTarget({ ...base, tier: "production" })).toEqual({
      to: "ops@example.test",
      env: "production",
    });
    expect(claimReviewAlertTarget({ ...base, tier: "dev" })?.env).toBe("dev");
  });

  it("sends nothing without an address, a Resend key, or a deployed tier", () => {
    expect(claimReviewAlertTarget({ ...base, CIRE_OPS_EMAIL: "  ", tier: "production" })).toBe(
      null,
    );
    expect(claimReviewAlertTarget({ CIRE_OPS_EMAIL: "ops@example.test", tier: "production" })).toBe(
      null,
    );
    expect(claimReviewAlertTarget({ ...base, tier: "local" })).toBe(null);
  });
});
