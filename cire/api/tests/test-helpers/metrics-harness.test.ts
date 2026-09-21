/**
 * The harness is the single point of failure for every metric assertion in this
 * package, so it gets the same standard as the code it protects.
 *
 * Its whole value is that it turns a silent zero into a loud error. If the
 * provider check inverted, or `sameAttributes` started matching a subset, every
 * counter test here would go back to passing against a meter that records
 * nothing — the exact failure the harness exists to stop — and nothing would
 * say so.
 *
 * This file lives beside the harness rather than under `tests/lib/` because it
 * tests the helper itself, not a `src/` module it mirrors.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { metrics } from "@opentelemetry/api";

import { CIRE_METRICS, metricDietaryPreset } from "../../src/metrics";
import { counterValue } from "./metrics-harness";

// Every test that disturbs the global provider puts it back, or every later
// FILE in the run reads zero — `bun test` shares one process.
const installed = metrics.getMeterProvider();
afterEach(() => {
  if (metrics.getMeterProvider() !== installed) {
    metrics.disable();
    metrics.setGlobalMeterProvider(installed);
  }
});

describe("counterValue", () => {
  it("answers 0 for a metric nothing has recorded", async () => {
    expect(await counterValue("cire.no.such.metric", { reason: "none" })).toBe(0);
  });

  it("matches on the WHOLE attribute set, never a subset", async () => {
    // A data point is keyed by all of its attributes. A partial match would
    // make a counter look higher than it is and, worse, would let a test
    // asserting `{ preset: "sesame" }` be satisfied by a different preset's
    // point if the comparison ever loosened.
    metricDietaryPreset("sesame");
    expect(await counterValue(CIRE_METRICS.dietaryPreset, { preset: "sesame" })).toBeGreaterThan(0);
    expect(await counterValue(CIRE_METRICS.dietaryPreset, { preset: "sesame", extra: "x" })).toBe(
      0,
    );
    expect(await counterValue(CIRE_METRICS.dietaryPreset, {})).toBe(0);
  });

  it("throws rather than answering 0 when this harness is not the provider", async () => {
    // The guard that makes a missing harness legible. Without it the failure
    // reads "expected 1, received 0" with nothing to say the provider never
    // installed — which is indistinguishable from the metric call being gone,
    // and is what every metric test in this package looked like before.
    metrics.disable();
    expect(metrics.getMeterProvider()).not.toBe(installed);
    await expect(counterValue(CIRE_METRICS.dietaryPreset, { preset: "sesame" })).rejects.toThrow(
      /not the installed MeterProvider/,
    );
  });

  it("reads again correctly once the provider is back", async () => {
    // Proves the afterEach restore actually works — otherwise the test above
    // would quietly break every file that runs after this one.
    expect(metrics.getMeterProvider()).toBe(installed);
    const before = await counterValue(CIRE_METRICS.dietaryPreset, { preset: "sesame" });
    metricDietaryPreset("sesame");
    expect(await counterValue(CIRE_METRICS.dietaryPreset, { preset: "sesame" })).toBe(before + 1);
  });
});
