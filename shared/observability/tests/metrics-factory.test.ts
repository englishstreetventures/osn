import { describe, expect, it } from "vitest";

import type { Result } from "../src/metrics/attrs";
import {
  BYTE_BUCKETS,
  createCounter,
  createHistogram,
  createUpDownCounter,
  LATENCY_BUCKETS_SECONDS,
} from "../src/metrics/factory";
import { recordHttpRequest } from "../src/metrics/http";

describe("metrics factory", () => {
  it("createCounter returns a typed counter with add/inc", () => {
    type Attrs = { route: string; result: Result };
    const counter = createCounter<Attrs>({
      name: "test.counter",
      description: "test counter",
      unit: "{count}",
    });
    // These must not throw even though no MeterProvider is set (OTel
    // defaults to a NoOp meter).
    expect(() => counter.inc({ route: "/foo", result: "ok" })).not.toThrow();
    expect(() => counter.add(5, { route: "/foo", result: "error" })).not.toThrow();
  });

  it("createHistogram accepts boundaries", () => {
    type Attrs = { op: "read" | "write" };
    const hist = createHistogram<Attrs>({
      name: "test.histogram",
      description: "test histogram",
      unit: "s",
      boundaries: LATENCY_BUCKETS_SECONDS,
    });
    expect(() => hist.record(0.123, { op: "read" })).not.toThrow();
  });

  it("createUpDownCounter returns a gauge with add/inc/dec", () => {
    type Attrs = { pool: "read" | "write" };
    const gauge = createUpDownCounter<Attrs>({
      name: "test.gauge",
      description: "test up-down counter",
      unit: "{item}",
    });
    // inc, dec, and arbitrary add must all work on the NoOp meter.
    expect(() => gauge.inc({ pool: "read" })).not.toThrow();
    expect(() => gauge.dec({ pool: "read" })).not.toThrow();
    expect(() => gauge.add(5, { pool: "write" })).not.toThrow();
    expect(() => gauge.add(-3, { pool: "write" })).not.toThrow();
  });

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

  it("recordHttpRequest emits without throwing on the NoOp meter", () => {
    expect(() =>
      recordHttpRequest({
        method: "GET",
        route: "/events/:id",
        status: 200,
        durationSeconds: 0.042,
      }),
    ).not.toThrow();
    // Error path should also be a no-throw.
    expect(() =>
      recordHttpRequest({
        method: "POST",
        route: "/events",
        status: 500,
        durationSeconds: 1.23,
      }),
    ).not.toThrow();
  });
});
