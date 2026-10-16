import { describe, expect, it } from "vitest";

import { BYTE_BUCKETS, LATENCY_BUCKETS_SECONDS } from "../src/metrics/factory";

describe("metrics factory", () => {
  it("LATENCY_BUCKETS_SECONDS is monotonically increasing", () => {
    const bs = LATENCY_BUCKETS_SECONDS;
    for (let i = 1; i < bs.length; i++) {
      expect(bs[i]).toBeGreaterThan(bs[i - 1] as number);
    }
  });

  it("BYTE_BUCKETS is monotonically increasing", () => {
    const bs = BYTE_BUCKETS;
    expect(bs.length).toBeGreaterThan(0);
    for (let i = 1; i < bs.length; i++) {
      expect(bs[i]).toBeGreaterThan(bs[i - 1] as number);
    }
  });
});
