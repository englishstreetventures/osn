import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/templates";

describe("vendor-claim-review-pending", () => {
  it("states the count, the oldest wait and the production list command", () => {
    const out = renderTemplate("vendor-claim-review-pending", {
      pending: 2,
      oldestWaitingDays: 3,
      env: "production",
    });
    expect(out.subject).toBe("Cire: 2 vendor claims are waiting for review");
    expect(out.text).toContain("The oldest has waited 3 days.");
    expect(out.text).toContain("bun scripts/cire-vendor-claim-review.ts list --env production");
    expect(out.html).toContain("--env production");
  });

  it("uses the singular for one claim and names a same-day claim", () => {
    const out = renderTemplate("vendor-claim-review-pending", {
      pending: 1,
      oldestWaitingDays: 0,
      env: "production",
    });
    expect(out.subject).toBe("Cire: 1 vendor claim is waiting for review");
    expect(out.text).toContain("The oldest arrived today.");
  });

  it("marks a dev deployment and points the command at dev", () => {
    const out = renderTemplate("vendor-claim-review-pending", {
      pending: 1,
      oldestWaitingDays: 1,
      env: "dev",
    });
    expect(out.subject).toBe("Cire (dev): 1 vendor claim is waiting for review");
    expect(out.text).toContain("The oldest has waited 1 day.");
    expect(out.text).toContain("list --env dev");
  });
});
