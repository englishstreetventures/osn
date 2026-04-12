import { describe, expect, it } from "vitest";

import {
  currentSpanId,
  currentTraceId,
  extractTraceContext,
  injectTraceContext,
} from "../src/tracing/propagation";

describe("trace context propagation", () => {
  it("extract returns a context even when no traceparent header is present", () => {
    const headers = new Headers();
    const ctx = extractTraceContext(headers);
    expect(ctx).toBeDefined();
  });

  it("injects nothing into headers when there is no active span", () => {
    const headers = new Headers();
    injectTraceContext(headers);
    // With no active span + no SDK initialised, nothing should be injected.
    // This is intentional: tests don't require the OTel SDK to be running.
    expect(headers.get("traceparent")).toBeNull();
  });

  it("extracts from a plain record", () => {
    const ctx = extractTraceContext({
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(ctx).toBeDefined();
  });
});

describe("currentTraceId / currentSpanId", () => {
  // With no SDK installed, both helpers must return undefined. Callers
  // annotating logs rely on this "safe-to-call-anywhere" behaviour —
  // the goal is that log sites never need to null-check before calling.
  it("returns undefined when no SDK is active", () => {
    expect(currentTraceId()).toBeUndefined();
    expect(currentSpanId()).toBeUndefined();
  });

  it("calling repeatedly does not throw or allocate an invalid span", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => currentTraceId()).not.toThrow();
      expect(() => currentSpanId()).not.toThrow();
    }
  });
});
