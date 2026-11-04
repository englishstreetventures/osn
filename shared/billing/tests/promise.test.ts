import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createBilling } from "../src/promise";
import { createStripeProvider } from "../src/stripe";
import { PLANS } from "./support/billing";
import { createTestStorage } from "./support/db";
import { createFakeStripe } from "./support/fake-stripe";

describe("the Promise facade", () => {
  it("rejects with the tagged error, and runs a Promise hook", async () => {
    const { storage } = await createTestStorage();
    const stripe = createFakeStripe();
    const seen: boolean[] = [];
    const billing = createBilling({
      plans: PLANS,
      storage,
      provider: createStripeProvider({
        secretKey: "sk",
        webhookSecret: null,
        fetchImpl: stripe.fetchImpl,
      }),
      returnOrigins: ["https://x.test"],
      run: Effect.runPromise,
      hooks: { onAccess: async (decision) => void seen.push(decision.features.workspace.allowed) },
    });
    await expect(
      billing.portal({ customerRef: "org_1", returnUrl: "https://x.test" }),
    ).rejects.toMatchObject({
      _tag: "NoBillingCustomer",
    });
    await billing.grant({
      customerRef: "org_1",
      featureId: "workspace",
      source: "comp",
      grantedBy: "ops",
      expiresAt: null,
    });
    expect(seen).toEqual([true]);
  });
});
