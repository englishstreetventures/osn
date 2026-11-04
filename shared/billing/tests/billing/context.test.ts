import { describe, expect, it } from "vitest";

import { createBilling, type BillingOptions } from "../../src";
import { createStripeProvider } from "../../src/stripe";
import { APP_ORIGIN, createHarness, PLANS } from "../support/billing";
import { createTestStorage } from "../support/db";
import { createFakeStripe } from "../support/fake-stripe";

async function build(over: Partial<BillingOptions<typeof PLANS>>) {
  const { storage } = await createTestStorage();
  return createBilling({
    plans: PLANS,
    storage,
    provider: createStripeProvider({
      secretKey: "sk_test_1",
      webhookSecret: null,
      fetchImpl: createFakeStripe().fetchImpl,
    }),
    returnOrigins: [APP_ORIGIN],
    ...over,
  });
}

describe("createBilling's configuration checks", () => {
  it.each([
    ["graceDays", Number.NaN],
    ["graceDays", -1],
    ["periodLeewayHours", Number.NaN],
    ["periodLeewayHours", Number.POSITIVE_INFINITY],
  ] as const)("refuses policy.%s = %s", async (key, value) => {
    await expect(createHarness({ policy: { [key]: value } })).rejects.toThrow(
      new RegExp(`policy.${key} must be a finite number`),
    );
  });

  it("keeps the default for a policy value passed as undefined", async () => {
    // The shape `Number(env.X) || undefined` produces for an unset variable.
    const h = await createHarness({ policy: { graceDays: undefined } });
    expect(h.billing).toBeDefined();
  });

  it.each([
    ["backoffMs", { backoffMs: 0 }],
    ["eventLeaseMs", { eventLeaseMs: Number.NaN }],
    ["leaseMs", { leaseMs: -1 }],
  ] as const)("refuses a tuning.%s that is not above zero", async (key, tuning) => {
    await expect(createHarness({ tuning })).rejects.toThrow(
      new RegExp(`tuning.${key} must be a finite number above 0`),
    );
  });

  it("refuses an access lease no longer than the hook timeout plus the budget", async () => {
    await expect(
      createHarness({ tuning: { leaseMs: 4_000, hookTimeoutMs: 3_000, accessBudgetMs: 1_000 } }),
    ).rejects.toThrow(/leaseMs must exceed/);
  });

  it("refuses an event lease that one delivery could outlast", async () => {
    // The harness's provider call times out at 1 s.
    await expect(createHarness({ tuning: { eventLeaseMs: 3_000 + 150 + 1_000 } })).rejects.toThrow(
      /eventLeaseMs must exceed/,
    );
  });

  it.each([[[]], [["https://app.example.test/billing"]], [["app.example.test"]]])(
    "refuses returnOrigins %j",
    async (returnOrigins) => {
      await expect(build({ returnOrigins })).rejects.toThrow(/returnOrigins/);
    },
  );
});
