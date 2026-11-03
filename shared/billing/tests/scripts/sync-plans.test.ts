import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../scripts/sync-plans";
import { createFakeStripe } from "../support/fake-stripe";

/** A plans module on disk, the way a consumer's script would name one. */
function plansModule(): string {
  const dir = mkdtempSync(join(tmpdir(), "billing-plans-"));
  const file = join(dir, "plans.ts");
  const src = join(import.meta.dirname, "../../src/index.ts");
  writeFileSync(
    file,
    `import { defineFeature, definePlan } from ${JSON.stringify(src)};
const f = defineFeature({ id: "workspace" });
export const plans = [definePlan({ id: "monthly", name: "Monthly", group: "g", lookupKey: "k_monthly", features: [f],
  price: { interval: "month", defaultCurrency: "AUD", amounts: { AUD: 4900 }, taxBehavior: "exclusive" } })];
`,
  );
  return file;
}

const io = (stripe: ReturnType<typeof createFakeStripe>) => {
  const out: string[] = [];
  return {
    out,
    io: { write: (line: string) => void out.push(line), fetchImpl: stripe.fetchImpl, cwd: "/" },
  };
};

describe("sync-plans script", () => {
  it("is a dry run unless told to apply", async () => {
    const stripe = createFakeStripe();
    const { out, io: deps } = io(stripe);
    const code = await main(["--plans", plansModule()], { STRIPE_SECRET_KEY: "sk_test_x" }, deps);
    expect(code).toBe(0);
    expect(stripe.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(out.join("\n")).toContain("dry run");
  });

  it("refuses to run without a key", async () => {
    const stripe = createFakeStripe();
    const { io: deps } = io(stripe);
    expect(await main(["--plans", plansModule()], {}, deps)).toBe(2);
    expect(stripe.calls).toEqual([]);
  });

  it.each(["sk_live_x", "rk_live_x"])(
    "refuses to apply the live key %s without --live",
    async (key) => {
      const stripe = createFakeStripe();
      const { out, io: deps } = io(stripe);
      expect(
        await main(["--plans", plansModule(), "--apply"], { STRIPE_SECRET_KEY: key }, deps),
      ).toBe(2);
      expect(out.join("\n")).toContain("without --live");
      expect(stripe.calls).toEqual([]);
    },
  );
});
