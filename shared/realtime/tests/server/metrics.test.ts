import { describe, expect, it } from "vitest";

import { REALTIME_METRICS } from "../../src/server/metrics";

describe("REALTIME_METRICS", () => {
  it("every metric name is unique", () => {
    const values = Object.values(REALTIME_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});
