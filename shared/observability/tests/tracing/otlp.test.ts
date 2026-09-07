import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObservabilityConfig } from "../../src/config";
import { makeOtlpTracing } from "../../src/tracing/otlp";

/**
 * The workerd OTLP trace exporter. `makeTracingLayer` (the Bun/NodeSdk path) is
 * covered by `tests/layer.test.ts`; this file covers the layer the two deployed
 * Cloudflare Workers actually run, and the two behaviours the deployment
 * depends on:
 *
 *  - configured endpoint ⇒ an explicit `flush` POSTs a well-formed OTLP
 *    `resourceSpans` payload (nothing before the flush — the background export
 *    interval is deliberately pushed out of reach on workerd);
 *  - no endpoint ⇒ inert. The effect still runs, and NOTHING is posted.
 *
 * Every runtime here is disposed. The exporter forks a fiber that sleeps for
 * the export interval (24h by default), and on Bun/Node that timer keeps the
 * process alive; `dispose()` closes the layer scope and cancels it.
 */

interface CapturedPost {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
      scopeSpans: Array<{
        scope: { name: string };
        spans: Array<{
          traceId: string;
          spanId: string;
          name: string;
          attributes: Array<{ key: string; value: Record<string, unknown> }>;
        }>;
      }>;
    }>;
  };
}

let posts: Array<CapturedPost>;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  posts = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    posts.push({
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: JSON.parse(await request.text()) as CapturedPost["body"],
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const baseConfig: ObservabilityConfig = {
  serviceName: "probe-api",
  serviceVersion: "9.9.9",
  serviceNamespace: "osn",
  serviceInstanceId: "probe-api-instance-1",
  env: "production",
  logLevel: "info",
  otlpEndpoint: "https://otlp.example.test/otlp",
  otlpHeaders: { authorization: "Basic abc123" },
  traceSampleRatio: 1,
};

const attr = (
  attributes: Array<{ key: string; value: Record<string, unknown> }>,
  key: string,
): unknown => attributes.find((a) => a.key === key)?.value;

describe("makeOtlpTracing — exporting path", () => {
  it("POSTs a span to <endpoint>/v1/traces on an explicit flush", async () => {
    const tracing = makeOtlpTracing(baseConfig);
    expect(tracing.enabled).toBe(true);

    const runtime = ManagedRuntime.make(tracing.layer);
    try {
      await runtime.runPromise(
        Effect.succeed("ok").pipe(
          Effect.withSpan("probe.span", { attributes: { "probe.attr": 42 } }),
        ),
      );

      // The background interval must NOT have exported: on workerd a
      // background export is unreliable and a failed one disables the exporter
      // (and drops spans) for 60s. The explicit drain is the whole strategy.
      expect(posts).toHaveLength(0);

      await runtime.runPromise(tracing.flush);
      expect(posts).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }

    const post = posts[0]!;
    expect(post.url).toBe("https://otlp.example.test/otlp/v1/traces");
    expect(post.headers.authorization).toBe("Basic abc123");
    expect(post.headers["content-type"]).toContain("application/json");

    const resourceSpan = post.body.resourceSpans[0]!;
    expect(attr(resourceSpan.resource.attributes, "service.name")).toEqual({
      stringValue: "probe-api",
    });
    expect(attr(resourceSpan.resource.attributes, "service.version")).toEqual({
      stringValue: "9.9.9",
    });
    expect(attr(resourceSpan.resource.attributes, "service.namespace")).toEqual({
      stringValue: "osn",
    });
    expect(attr(resourceSpan.resource.attributes, "deployment.environment")).toEqual({
      stringValue: "production",
    });

    const span = resourceSpan.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe("probe.span");
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(attr(span.attributes, "probe.attr")).toEqual({ intValue: 42 });
  });

  it("drains an exporter built into a DIFFERENT runtime than the one flushing", async () => {
    // osn/api builds the same layer into two long-lived runtimes (the
    // module-level one in `observability.ts` and `build-deps`' shared
    // `appRuntime`), and a Layer is memoized per MemoMap — so there are two
    // exporters and only one holds the spans. `flush` drains every live one.
    const tracing = makeOtlpTracing(baseConfig);
    const spanRuntime = ManagedRuntime.make(tracing.layer);
    const flushRuntime = ManagedRuntime.make(tracing.layer);
    try {
      await spanRuntime.runPromise(Effect.void.pipe(Effect.withSpan("probe.other-runtime")));
      await flushRuntime.runPromise(tracing.flush);
    } finally {
      await spanRuntime.dispose();
      await flushRuntime.dispose();
    }

    const names = posts.flatMap((p) =>
      p.body.resourceSpans.flatMap((rs) =>
        rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => s.name)),
      ),
    );
    expect(names).toContain("probe.other-runtime");
  });

  it("honours traceSampleRatio: 0 by exporting nothing", async () => {
    const tracing = makeOtlpTracing({ ...baseConfig, traceSampleRatio: 0 });
    const runtime = ManagedRuntime.make(tracing.layer);
    try {
      await runtime.runPromise(Effect.void.pipe(Effect.withSpan("probe.unsampled")));
      await runtime.runPromise(tracing.flush);
    } finally {
      await runtime.dispose();
    }
    expect(posts).toHaveLength(0);
  });
});

describe("makeOtlpTracing — inert path", () => {
  const inertConfig: ObservabilityConfig = { ...baseConfig, otlpEndpoint: undefined };

  it("is a true no-op with no endpoint configured: effects run, nothing is POSTed", async () => {
    const tracing = makeOtlpTracing(inertConfig);
    expect(tracing.enabled).toBe(false);

    const runtime = ManagedRuntime.make(tracing.layer);
    try {
      const value = await runtime.runPromise(
        Effect.succeed("still works").pipe(Effect.withSpan("probe.inert")),
      );
      expect(value).toBe("still works");
      await runtime.runPromise(tracing.flush);
    } finally {
      await runtime.dispose();
    }

    expect(posts).toHaveLength(0);
  });

  it("stays a Layer<never>, so it merges into an existing layer graph unchanged", async () => {
    const tracing = makeOtlpTracing(inertConfig);
    const merged: Layer.Layer<never> = Layer.merge(Layer.empty, tracing.layer);
    const runtime = ManagedRuntime.make(merged);
    try {
      expect(await runtime.runPromise(Effect.succeed(1))).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("flushes to nothing before the layer has ever been built", async () => {
    const tracing = makeOtlpTracing(baseConfig);
    await Effect.runPromise(tracing.flush);
    expect(posts).toHaveLength(0);
  });
});
