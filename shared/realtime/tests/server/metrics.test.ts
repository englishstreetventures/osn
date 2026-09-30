import { describe, expect, it } from "vitest";

import {
  metricHubCapacityRefused,
  metricSignalPublished,
  metricSubscribe,
  REALTIME_METRICS,
} from "../../src/server/metrics";

describe("REALTIME_METRICS naming", () => {
  it("every name follows realtime.{domain}.{subject}[.{measurement}], lowercase and dotted", () => {
    const nameRe = /^realtime\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const name of Object.values(REALTIME_METRICS)) {
      expect(name, `${name} does not match ${nameRe}`).toMatch(nameRe);
    }
  });

  it("every metric name is unique", () => {
    const values = Object.values(REALTIME_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("metric wrappers", () => {
  it("do not throw when called against the real counters", () => {
    expect(() => metricSubscribe("cire", "accepted")).not.toThrow();
    expect(() => metricSignalPublished("cire", "members-changed", "ok")).not.toThrow();
    expect(() => metricHubCapacityRefused("cire")).not.toThrow();
  });
});
