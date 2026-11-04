import {
  context,
  metrics,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Link,
} from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  ParentBasedSampler,
  SamplingDecision,
  SimpleSpanProcessor,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Elysia, t } from "elysia";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { observabilityPlugin } from "../src/elysia/plugin";

/**
 * These tests run the plugin against real OTel SDK providers that this
 * file registers globally: a `NodeTracerProvider` (which also installs the
 * W3C trace-context propagator) feeding an in-memory span exporter, and a
 * `MeterProvider` whose metric reader the tests collect from. Spans and
 * metric data points are asserted directly. Vitest isolates test files, so
 * the global registration does not leak into other files.
 *
 * The tracer provider samples through `ParentBasedSampler`, whose root
 * delegate runs only for a span with no parent. That delegate records each
 * call and returns the decision a test sets, so a test can see that a span
 * was sampled by our sampler rather than by a parent's flag.
 */
const rootSamplerCalls: { traceId: string; links: Link[] }[] = [];
let rootDecision = SamplingDecision.RECORD_AND_SAMPLED;
const rootSampler: Sampler = {
  shouldSample: (_context, traceId, _name, _kind, _attributes, links) => {
    rootSamplerCalls.push({ traceId, links });
    return { decision: rootDecision };
  },
  toString: () => "RecordingRootSampler",
};

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  sampler: new ParentBasedSampler({ root: rootSampler }),
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
tracerProvider.register();

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });
metrics.setGlobalMeterProvider(meterProvider);

afterAll(async () => {
  await meterProvider.shutdown();
  await tracerProvider.shutdown();
});

beforeEach(async () => {
  // Let any `onAfterResponse` from the previous test finish first.
  await new Promise((resolve) => setTimeout(resolve, 5));
  spanExporter.reset();
  rootSamplerCalls.length = 0;
  rootDecision = SamplingDecision.RECORD_AND_SAMPLED;
});

type Point = { attributes: Attributes; value: unknown };

/** Flush the reader and return the latest data points of one metric. */
const collectPoints = async (name: string): Promise<Point[]> => {
  metricExporter.reset();
  await metricReader.forceFlush();
  const points: Point[] = [];
  for (const rm of metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          for (const dp of m.dataPoints)
            points.push({ attributes: dp.attributes, value: dp.value });
        }
      }
    }
  }
  return points;
};

const activeRequests = async (method: string): Promise<unknown> => {
  const points = await collectPoints("http.server.active_requests");
  return points.find((p) => p.attributes["http.request.method"] === method)?.value;
};

const serverSpans = () => spanExporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER);

/**
 * Elysia runs `onAfterResponse` after `handle()` resolves, so the span ends
 * and the metrics land a tick later. Wait for the server span to finish.
 */
const send = async (app: ReturnType<typeof makeApp>, url: string, init?: RequestInit) => {
  const before = serverSpans().length;
  const res = await app.handle(new Request(url, init));
  await vi.waitFor(() => expect(serverSpans().length).toBe(before + 1));
  return res;
};

const INBOUND_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INBOUND_SPAN_ID = "b7ad6b7169203331";
const traceparent = (flags: string) => `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-${flags}`;

const LEAK = "leak-msg@example.com";

class StatusError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "StatusError";
  }
}

let release: () => void = () => {};
let entered: () => void = () => {};

// Mounted the way the services mount it: a plain `.use()` on the app.
const makeApp = () =>
  new Elysia()
    .use(observabilityPlugin({ serviceName: "test-svc" }))
    .get("/ping", () => ({ pong: true }))
    .get("/items/:id", ({ params }) => params.id)
    .get("/boom", () => {
      throw new Error("kaboom");
    })
    .get("/leaky", () => {
      throw new Error(`failed for ${LEAK}`);
    })
    .get("/bad", () => {
      throw new StatusError(`bad input for ${LEAK}`);
    })
    .post("/validate", ({ body }) => body, { body: t.Object({ count: t.Number() }) })
    .get("/non-error", () => {
      // oxlint-disable-next-line no-throw-literal
      throw "not an error object";
    })
    .get("/slow", async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    });

describe("observabilityPlugin", () => {
  it("echoes a generated x-request-id on successful responses", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/ping"));
    expect(res.status).toBe(200);
    const id = res.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect(id).toMatch(/^req_/);
  });

  it("preserves a valid inbound x-request-id rather than generating a new one", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: { "x-request-id": "req_external_abc123" },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("req_external_abc123");
  });

  // Strict validation. Bun's Request constructor rejects
  // literal CRLF in headers before we ever see the value, which is
  // already a layer of defence. What we test here is our extra
  // layer: values that Bun accepts but that fail our stricter
  // regex (anything outside `[A-Za-z0-9_.-]{1,64}`) must be
  // replaced with a fresh generated ID.
  it("rejects an x-request-id with spaces and generates a fresh one", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: { "x-request-id": "req bad id" },
      }),
    );
    const out = res.headers.get("x-request-id");
    expect(out).not.toBe("req bad id");
    expect(out).toMatch(/^req_[0-9a-f]+$/);
  });

  it("rejects an x-request-id with semicolons (header injection attempt)", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: { "x-request-id": "req_abc;evil=1" },
      }),
    );
    expect(res.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]+$/);
  });

  it("rejects a too-long x-request-id and generates a fresh one", async () => {
    const app = makeApp();
    const long = "a".repeat(500);
    const res = await app.handle(
      new Request("http://localhost/ping", { headers: { "x-request-id": long } }),
    );
    const out = res.headers.get("x-request-id");
    expect(out).not.toBe(long);
    expect(out).toMatch(/^req_/);
  });

  it("rejects an x-request-id with ANSI escape sequences", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: { "x-request-id": "\u001b[31mred\u001b[0m" },
      }),
    );
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
  });

  describe("inbound trace context becomes a span link, never the parent", () => {
    const ARC = ["an ARC Authorization header", { authorization: "ARC anything" }] as const;
    const NONE = ["no Authorization header", {}] as const;
    const CALLERS = [
      ARC,
      NONE,
      ["Authorization: Bearer", { authorization: "Bearer x" }],
      ["a lower-case arc scheme", { authorization: "arc x" }],
    ] as const;

    const inboundLink = (traceFlags: number) => ({
      traceId: INBOUND_TRACE_ID,
      spanId: INBOUND_SPAN_ID,
      traceFlags,
      isRemote: true,
    });

    const onlyServerSpan = () => {
      const spans = serverSpans();
      expect(spans).toHaveLength(1);
      return spans[0]!;
    };

    /** A root of our own: a new trace id, no parent, and our sampler asked once. */
    const expectOwnRoot = (span: ReturnType<typeof onlyServerSpan>) => {
      expect(span.spanContext().traceId).not.toBe(INBOUND_TRACE_ID);
      expect(span.parentSpanContext).toBeUndefined();
      expect(rootSamplerCalls.map((c) => c.traceId)).toEqual([span.spanContext().traceId]);
    };

    it.each(CALLERS)(
      "starts a new root that links a sampled traceparent sent with %s",
      async (_, auth) => {
        // Every flag bit set: the link keeps only the sampled bit.
        const res = await send(makeApp(), "http://localhost/ping", {
          headers: { ...auth, traceparent: traceparent("ff"), tracestate: "caller=chosen" },
        });
        expect(res.status).toBe(200);
        const span = onlyServerSpan();
        expectOwnRoot(span);
        expect(span.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
        expect(span.spanContext().traceState).toBeUndefined();
        expect(span.links.map((l) => l.context)).toEqual([inboundLink(TraceFlags.SAMPLED)]);
        expect(span.links[0]!.context.traceState).toBeUndefined();
        // The sampler saw the link when it decided: links are set at start.
        expect(rootSamplerCalls[0]!.links.map((l) => l.context)).toEqual([
          inboundLink(TraceFlags.SAMPLED),
        ]);
      },
    );

    it.each([ARC, NONE])(
      "samples by our sampler when an unsampled traceparent is sent with %s",
      async (_, auth) => {
        await send(makeApp(), "http://localhost/ping", {
          headers: { ...auth, traceparent: traceparent("00") },
        });
        const span = onlyServerSpan();
        expectOwnRoot(span);
        expect(span.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
        expect(span.links.map((l) => l.context)).toEqual([inboundLink(TraceFlags.NONE)]);
      },
    );

    it.each([ARC, NONE])(
      "records nothing when our sampler declines a sampled traceparent sent with %s",
      async (_, auth) => {
        rootDecision = SamplingDecision.NOT_RECORD;
        const res = await makeApp().handle(
          new Request("http://localhost/ping", {
            headers: { ...auth, traceparent: traceparent("01") },
          }),
        );
        expect(res.status).toBe(200);
        // The gauge falls in onAfterResponse, the hook that ends the span.
        await vi.waitFor(async () => expect(await activeRequests("GET")).toBe(0));
        expect(serverSpans()).toHaveLength(0);
        expect(rootSamplerCalls).toHaveLength(1);
      },
    );

    it.each([
      ["not a traceparent", "not-a-traceparent"],
      ["no flags", `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}`],
      ["an all-zero trace id", `00-${"0".repeat(32)}-${INBOUND_SPAN_ID}-01`],
      ["the reserved version ff", `ff-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`],
      ["a fifth part on version 00", `${traceparent("01")}-extra`],
    ])("adds no link for a traceparent with %s", async (_, value) => {
      const res = await send(makeApp(), "http://localhost/ping", {
        headers: { authorization: "ARC anything", traceparent: value },
      });
      expect(res.status).toBe(200);
      const span = onlyServerSpan();
      expectOwnRoot(span);
      expect(span.links).toEqual([]);
      expect(rootSamplerCalls[0]!.links).toEqual([]);
    });

    describe("inside a span already active in the calling context", () => {
      const LOCAL_TRACE_ID = "1".repeat(32);
      const active = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: LOCAL_TRACE_ID,
        spanId: "2".repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      });

      it.each([
        ["a valid traceparent", traceparent("01"), [inboundLink(TraceFlags.SAMPLED)]],
        ["a malformed traceparent", "not-a-traceparent", []],
      ])("starts a new root and links only the header, for %s", async (_, value, links) => {
        const res = await context.with(active, () =>
          send(makeApp(), "http://localhost/ping", { headers: { traceparent: value } }),
        );
        expect(res.status).toBe(200);
        const span = onlyServerSpan();
        expectOwnRoot(span);
        expect(span.spanContext().traceId).not.toBe(LOCAL_TRACE_ID);
        expect(span.links.map((l) => l.context)).toEqual(links);
      });
    });
  });

  describe("onError scrubbing", () => {
    const errorSpan = () => {
      const spans = serverSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      const event = span.events.find((e) => e.name === "exception");
      expect(event).toBeDefined();
      expect(JSON.stringify({ events: span.events, status: span.status })).not.toContain(LEAK);
      return { span, attrs: event!.attributes ?? {} };
    };

    it("records the name and Elysia's code, not the message or stack, for a thrown Error", async () => {
      const res = await send(makeApp(), "http://localhost/leaky");
      expect(res.status).toBe(500);
      const { span, attrs } = errorSpan();
      expect(attrs["exception.type"]).toBe("Error");
      expect(attrs["exception.message"]).toBe("UNKNOWN");
      expect(attrs["exception.stacktrace"]).toBeUndefined();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it("keeps the message out of the status of an error answered below 500", async () => {
      const res = await send(makeApp(), "http://localhost/bad");
      expect(res.status).toBe(400);
      const { span, attrs } = errorSpan();
      expect(attrs["exception.type"]).toBe("StatusError");
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "UNKNOWN" });
    });

    it("keeps a rejected request body out of a validation error's span", async () => {
      const res = await send(makeApp(), "http://localhost/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: LEAK }),
      });
      expect(res.status).toBe(422);
      const { span, attrs } = errorSpan();
      expect(attrs["exception.message"]).toBe("VALIDATION");
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "VALIDATION" });
    });

    it("records Elysia's code string for a thrown non-Error", async () => {
      await send(makeApp(), "http://localhost/non-error");
      const { span, attrs } = errorSpan();
      expect(attrs["exception.message"]).toBe("UNKNOWN");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe("route and url attributes", () => {
    it("records the 'unmatched' sentinel for a 404, not the path", async () => {
      const path = `/does-not-exist/${crypto.randomUUID()}`;
      const res = await send(makeApp(), `http://localhost${path}`);
      expect(res.status).toBe(404);
      const points = await collectPoints("http.server.requests");
      const routes = points.map((p) => p.attributes["http.route"]);
      expect(routes).toContain("unmatched");
      expect(routes.some((r) => typeof r === "string" && r.includes("does-not-exist"))).toBe(false);
    });

    it("records the route template on the span, never the path or query", async () => {
      const id = crypto.randomUUID();
      await send(makeApp(), `http://localhost/items/${id}?code=secret-token`);
      const spans = serverSpans();
      expect(spans).toHaveLength(1);
      const attrs = spans[0]!.attributes;
      expect(attrs["url.path"]).toBeUndefined();
      expect(attrs["http.route"]).toBe("/items/:id");
      for (const value of Object.values(attrs)) {
        expect(String(value)).not.toContain(id);
        expect(String(value)).not.toContain("secret-token");
      }
    });

    it("records a method outside the known set as _OTHER", async () => {
      await send(makeApp(), "http://localhost/ping", { method: "PROPFIND" });
      expect(serverSpans()[0]!.name).toBe("HTTP _OTHER");
      const methods = (await collectPoints("http.server.requests")).map(
        (p) => p.attributes["http.request.method"],
      );
      expect(methods).toContain("_OTHER");
      expect(methods).not.toContain("PROPFIND");
      expect(await activeRequests("_OTHER")).toBe(0);
    });

    it("records the matched route template for a matched request", async () => {
      await send(makeApp(), "http://localhost/ping");
      const points = await collectPoints("http.server.requests");
      const hit = points.find(
        (p) =>
          p.attributes["http.route"] === "/ping" &&
          p.attributes["http.response.status_code"] === "200",
      );
      expect(hit).toBeDefined();
    });
  });

  describe("in-flight gauge", () => {
    it("reads 0 after a request whose handler throws, and the response carries an id", async () => {
      const res = await send(makeApp(), "http://localhost/boom");
      expect(res.status).toBe(500);
      expect(res.headers.get("x-request-id")).toBeTruthy();
      expect(await activeRequests("GET")).toBe(0);
    });

    it("reads 0 after ten requests", async () => {
      const app = makeApp();
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.handle(new Request(`http://localhost/ping?i=${i}`)),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.headers.get("x-request-id")).toBeTruthy();
      }
      await vi.waitFor(() => expect(serverSpans()).toHaveLength(10));
      expect(await activeRequests("GET")).toBe(0);
    });

    it("reads 1 while a handler is still running, then 0", async () => {
      const app = makeApp();
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = app.handle(new Request("http://localhost/slow"));
      await started;
      expect(await activeRequests("GET")).toBe(1);
      release();
      const res = await pending;
      expect(await res.text()).toBe("done");
      await vi.waitFor(() => expect(serverSpans()).toHaveLength(1));
      expect(await activeRequests("GET")).toBe(0);
    });
  });

  it("works alongside other Elysia routes without interfering", async () => {
    const app = new Elysia()
      .use(observabilityPlugin({ serviceName: "test-svc" }))
      .get("/a", () => "a")
      .get("/b", () => "b")
      .post("/echo", ({ body }) => body, { body: undefined });

    const a = await app.handle(new Request("http://localhost/a"));
    const b = await app.handle(new Request("http://localhost/b"));
    expect(await a.text()).toBe("a");
    expect(await b.text()).toBe("b");
  });
});
