import { metrics, SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
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
 */
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
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

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";

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

  describe("inbound traceparent trust gate", () => {
    const run = async (headers: Record<string, string>) => {
      const res = await send(makeApp(), "http://localhost/ping", { headers });
      expect(res.status).toBe(200);
      const spans = serverSpans();
      expect(spans).toHaveLength(1);
      return spans[0]!;
    };

    it("starts a fresh root for a traceparent with no Authorization header", async () => {
      const span = await run({ traceparent: TRACEPARENT });
      expect(span.spanContext().traceId).not.toBe(TRACE_ID);
      expect(span.parentSpanContext?.spanId).toBeUndefined();
    });

    it("continues the caller's trace for a traceparent with Authorization: ARC", async () => {
      const span = await run({ traceparent: TRACEPARENT, authorization: "ARC x.y.z" });
      expect(span.spanContext().traceId).toBe(TRACE_ID);
      expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    });

    it("starts a fresh root for a traceparent with Authorization: Bearer", async () => {
      const span = await run({ traceparent: TRACEPARENT, authorization: "Bearer x" });
      expect(span.spanContext().traceId).not.toBe(TRACE_ID);
      expect(span.parentSpanContext?.spanId).toBeUndefined();
    });

    it("starts a fresh root for a lower-case 'arc' scheme", async () => {
      const span = await run({ traceparent: TRACEPARENT, authorization: "arc x" });
      expect(span.spanContext().traceId).not.toBe(TRACE_ID);
      expect(span.parentSpanContext?.spanId).toBeUndefined();
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

    it("keeps the query string out of the span's url.path", async () => {
      await send(makeApp(), "http://localhost/ping?code=secret-token");
      const spans = serverSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes["url.path"]).toBe("/ping");
      for (const value of Object.values(spans[0]!.attributes)) {
        expect(String(value)).not.toContain("secret-token");
      }
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
