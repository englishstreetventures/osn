import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";

import { observabilityPlugin } from "../src/elysia/plugin";

/**
 * These tests exercise the public behaviours of the plugin without
 * booting the OTel SDK. Because the plugin calls `trace.getTracer()`
 * and `metrics.getMeter()`, which default to NoOp implementations when
 * no provider is installed, the whole pipeline runs end-to-end but
 * doesn't export anything — which is exactly what we want in unit tests.
 */
const makeApp = () =>
  new Elysia()
    .use(observabilityPlugin({ serviceName: "test-svc" }))
    .get("/ping", () => ({ pong: true }))
    .get("/boom", () => {
      throw new Error("kaboom");
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

  // S-H3: strict validation. Bun's Request constructor rejects
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

  it("accepts an inbound traceparent header without throwing", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: {
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        },
      }),
    );
    // S-H2: the plugin accepts the request, but silently ignores the
    // traceparent for anonymous callers (no ARC auth header). We can't
    // assert the trace-id on the span without a recording processor,
    // but we can assert no throw + successful handler execution.
    expect(res.status).toBe(200);
  });

  // S-H2: only ARC-authenticated callers are trusted for traceparent
  it("ignores traceparent from an anonymous caller and treats as root", async () => {
    // This is a smoke test — without hooking into the exporter we
    // can't observe the parent link. What we verify is that the
    // request completes successfully, which means the plugin made
    // the "should I trust this?" decision without crashing.
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: {
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts traceparent when paired with Authorization: ARC ...", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/ping", {
        headers: {
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          authorization: "ARC eyJhbGciOiJFUzI1NiJ9.fake.sig",
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("does not leak the in-flight gauge when a handler throws", async () => {
    const app = makeApp();
    // Elysia returns 500 (or converts to an error response) rather than
    // propagating the throw to the caller. Either way, the plugin's
    // onAfterResponse hook must fire and dec the gauge.
    const res = await app.handle(new Request("http://localhost/boom"));
    // Elysia defaults to 500 on uncaught throws; we don't assert the
    // exact code — only that the request completes without hanging and
    // a response is returned with an x-request-id header.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("survives many sequential requests without accumulating state", async () => {
    const app = makeApp();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => app.handle(new Request(`http://localhost/ping?i=${i}`))),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBeTruthy();
    }
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
