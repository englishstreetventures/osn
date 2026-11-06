import { metrics, type Attributes } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Elysia } from "elysia";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { observabilityPlugin } from "../src/elysia/plugin";

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });
metrics.setGlobalMeterProvider(meterProvider);

afterAll(async () => {
  await meterProvider.shutdown();
});

beforeEach(async () => {
  // Let any `onAfterResponse` from the previous test finish first.
  await new Promise((resolve) => setTimeout(resolve, 5));
});

type Point = { attributes: Attributes; value: unknown };

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

/** Requests recorded so far, summed over every series. */
const requestsRecorded = async (): Promise<number> =>
  (await collectPoints("http.server.requests")).reduce(
    (sum, point) => sum + (typeof point.value === "number" ? point.value : 0),
    0,
  );

/** Waits until `onAfterResponse` has recorded `count` more requests. */
const recorded = async (before: number, count = 1): Promise<void> => {
  await vi.waitFor(async () => expect(await requestsRecorded()).toBe(before + count));
};

const send = async (app: ReturnType<typeof makeApp>, url: string, init?: RequestInit) => {
  const before = await requestsRecorded();
  const res = await app.handle(new Request(url, init));
  await recorded(before);
  return res;
};

let release: () => void = () => {};
let entered: () => void = () => {};

// Mounted the way the services mount it: a plain `.use()` on the app.
const makeApp = () =>
  new Elysia()
    .use(observabilityPlugin())
    .get("/ping", () => ({ pong: true }))
    .get("/items/:id", ({ params }) => params.id)
    .get("/boom", () => {
      throw new Error("kaboom");
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

  describe("route attribute", () => {
    it("records the 'unmatched' sentinel for a 404, not the path", async () => {
      const path = `/does-not-exist/${crypto.randomUUID()}`;
      const res = await send(makeApp(), `http://localhost${path}`);
      expect(res.status).toBe(404);
      const points = await collectPoints("http.server.requests");
      const routes = points.map((p) => p.attributes["http.route"]);
      expect(routes).toContain("unmatched");
      expect(routes.some((r) => typeof r === "string" && r.includes("does-not-exist"))).toBe(false);
    });

    it("records the route template, never the path or query, for a matched request", async () => {
      const id = crypto.randomUUID();
      await send(makeApp(), `http://localhost/items/${id}?code=secret-token`);
      const points = await collectPoints("http.server.requests");
      expect(points.map((p) => p.attributes["http.route"])).toContain("/items/:id");
      for (const point of points) {
        for (const value of Object.values(point.attributes)) {
          expect(String(value)).not.toContain(id);
          expect(String(value)).not.toContain("secret-token");
        }
      }
    });

    it("records a method outside the known set as _OTHER", async () => {
      await send(makeApp(), "http://localhost/ping", { method: "PROPFIND" });
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
      const before = await requestsRecorded();
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.handle(new Request(`http://localhost/ping?i=${i}`)),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.headers.get("x-request-id")).toBeTruthy();
      }
      await recorded(before, 10);
      expect(await activeRequests("GET")).toBe(0);
    });

    it("reads 1 while a handler is still running, then 0", async () => {
      const app = makeApp();
      const before = await requestsRecorded();
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = app.handle(new Request("http://localhost/slow"));
      await started;
      expect(await activeRequests("GET")).toBe(1);
      release();
      const res = await pending;
      expect(await res.text()).toBe("done");
      await recorded(before);
      expect(await activeRequests("GET")).toBe(0);
    });
  });

  it("works alongside other Elysia routes without interfering", async () => {
    const app = new Elysia()
      .use(observabilityPlugin())
      .get("/a", () => "a")
      .get("/b", () => "b")
      .post("/echo", ({ body }) => body, { body: undefined });

    const a = await app.handle(new Request("http://localhost/a"));
    const b = await app.handle(new Request("http://localhost/b"));
    expect(await a.text()).toBe("a");
    expect(await b.text()).toBe("b");
  });
});
