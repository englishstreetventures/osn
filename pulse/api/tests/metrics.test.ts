import { describe, expect, it } from "vitest";

import { PULSE_METRICS } from "../src/metrics";

/**
 * Naming-convention + uniqueness guard for Pulse domain metrics.
 * Mirrors the same assertions in `osn/core/tests/metrics.test.ts`.
 * Runs without a MeterProvider — we're asserting on the const table,
 * not on emission.
 */
describe("PULSE_METRICS naming", () => {
  it("all names follow the pulse.* lowercase dotted convention", () => {
    const nameRe = /^pulse\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const name of Object.values(PULSE_METRICS)) {
      expect(name, `${name} does not match ${nameRe}`).toMatch(nameRe);
    }
  });

  it("every metric name is unique", () => {
    const values = Object.values(PULSE_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});
