import { describe, expect, it } from "vitest";

import { bucketEventType, bucketStatus } from "../src/metrics";

describe("metric attribute buckets", () => {
  it("collapses an event type outside the handled set to other", () => {
    expect(bucketEventType("invoice.paid")).toBe("invoice.paid");
    expect(bucketEventType("evt_1A2B3C.attacker")).toBe("other");
    expect(bucketEventType("charge.refunded")).toBe("other");
  });

  it("collapses an unknown subscription status to other, and absence to none", () => {
    expect(bucketStatus("past_due")).toBe("past_due");
    expect(bucketStatus("sub_1234")).toBe("other");
    expect(bucketStatus(null)).toBe("none");
  });
});
