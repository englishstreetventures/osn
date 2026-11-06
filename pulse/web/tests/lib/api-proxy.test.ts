import { describe, expect, it, vi } from "vitest";

import { proxyToPulseApi } from "../../src/lib/api-proxy";

const WEB = "http://pulse.test";
const API = "http://pulse-api.internal:3001";

type Call = { url: string; init: RequestInit & { duplex?: string } };

/** A `fetch` double: records each call, answers with `respond()`. */
function upstream(respond: () => Response | Promise<Response> = () => new Response("{}")) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: (init ?? {}) as Call["init"] });
    return respond();
  });
  return { fetch, calls };
}

/** A request to the web origin with a raw path, kept exactly as written. */
const at = (path: string, init?: RequestInit) => new Request(`${WEB}${path}`, init);

describe("proxyToPulseApi: where a request goes", () => {
  it("strips /api from a data path and keeps the query string", async () => {
    const { fetch, calls } = upstream();
    await proxyToPulseApi(at("/api/events?x=1&y=two"), API, fetch);
    expect(calls[0]!.url).toBe(`${API}/events?x=1&y=two`);
  });

  it("passes /api/auth/* through unchanged, where pulse-api mounts its auth routes", async () => {
    const { fetch, calls } = upstream();
    await proxyToPulseApi(at("/api/auth/session"), API, fetch);
    expect(calls[0]!.url).toBe(`${API}/api/auth/session`);
  });

  it.each(["/api", "/api/"])("answers %s with 404 and calls nothing", async (path) => {
    const { fetch } = upstream();
    const res = await proxyToPulseApi(at(path), API, fetch);
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "/api/%2e%2e/internal/register-service",
    "/api/events/%2E%2E/%2E%2E/internal/account-deleted",
    "/api/events/..%2Finternal",
    "/api/events/%252e%252e/internal",
  ])("never leaves the mapped prefix for an encoded traversal: %s", async (path) => {
    const { fetch, calls } = upstream();
    const res = await proxyToPulseApi(at(path), API, fetch);
    // Either refused outright, or the URL parser has already folded the
    // dot-segments away so the request is no longer under /api.
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it.each([
    "/api//evil.example/x",
    "/api/\\evil.example",
    "/api/http://evil.example",
    "/api/%2F%2Fevil.example",
    "/api/%5Cevil.example",
    "/api/events/%2f%2fevil.example",
  ])("refuses a path that could name another host: %s", async (path) => {
    const { fetch } = upstream();
    const res = await proxyToPulseApi(at(path), API, fetch);
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "/api/internal/register-service",
    "/api/internal/account-deleted",
    "/api/Internal/account-export",
    "/api/health",
    "/api/ready",
    "/api/openapi",
    "/api/openapi/json",
  ])("refuses pulse-api's operator and service paths: %s", async (path) => {
    const { fetch } = upstream();
    const res = await proxyToPulseApi(at(path, { method: "POST", body: "{}" }), API, fetch);
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("proxyToPulseApi: what a request carries", () => {
  it("forwards Origin verbatim, so pulse-api's origin guard judges the browser's", async () => {
    const { fetch, calls } = upstream();
    await proxyToPulseApi(
      at("/api/events", {
        method: "POST",
        headers: { origin: "https://evil.example", cookie: "pulse_web_session=tok" },
        body: "{}",
      }),
      API,
      fetch,
    );
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get("origin")).toBe("https://evil.example");
    expect(sent.get("cookie")).toBe("pulse_web_session=tok");
  });

  it("forwards If-None-Match and returns pulse-api's 304", async () => {
    const { fetch, calls } = upstream(() => new Response(null, { status: 304 }));
    const res = await proxyToPulseApi(
      at("/api/events/evt_1/ics", { headers: { "if-none-match": 'W/"abc"' } }),
      API,
      fetch,
    );
    expect(new Headers(calls[0]!.init.headers).get("if-none-match")).toBe('W/"abc"');
    expect(res.status).toBe(304);
  });

  it("forwards the step-up token header a sensitive account call carries", async () => {
    const { fetch, calls } = upstream();
    await proxyToPulseApi(
      at("/api/account", { method: "DELETE", headers: { "x-step-up-token": "stp_123" } }),
      API,
      fetch,
    );
    expect(new Headers(calls[0]!.init.headers).get("x-step-up-token")).toBe("stp_123");
  });

  it("never forwards Authorization or hop-by-hop headers", async () => {
    const { fetch, calls } = upstream();
    await proxyToPulseApi(
      at("/api/events", {
        headers: {
          authorization: "Bearer stolen",
          connection: "keep-alive, x-secret",
          "keep-alive": "timeout=5",
          te: "trailers",
          upgrade: "websocket",
          "proxy-authorization": "Basic x",
          accept: "application/json",
        },
      }),
      API,
      fetch,
    );
    const sent = new Headers(calls[0]!.init.headers);
    const dropped = [
      "authorization",
      "connection",
      "keep-alive",
      "te",
      "upgrade",
      "proxy-authorization",
      "host",
    ];
    expect(dropped.filter((name) => sent.has(name))).toEqual([]);
    expect(sent.get("accept")).toBe("application/json");
  });

  it("streams a write's body with duplex half, and sends no body on a read", async () => {
    const { fetch, calls } = upstream();
    await proxyToPulseApi(
      at("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"title":"x"}',
      }),
      API,
      fetch,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.duplex).toBe("half");
    expect(await new Response(calls[0]!.init.body).text()).toBe('{"title":"x"}');

    await proxyToPulseApi(at("/api/events"), API, fetch);
    expect(calls[1]!.init.body ?? null).toBeNull();
  });
});

describe("proxyToPulseApi: what comes back", () => {
  it("returns both Set-Cookie lines pulse-api sends", async () => {
    const { fetch } = upstream(() => {
      const headers = new Headers({ location: `${WEB}/` });
      headers.append("set-cookie", "pulse_web_session=tok; Path=/; HttpOnly; SameSite=Lax");
      headers.append("set-cookie", "pulse_oidc_tx=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return new Response(null, { status: 302, headers });
    });
    const res = await proxyToPulseApi(at("/api/auth/oidc/callback?code=c&state=s"), API, fetch);
    expect(res.headers.getSetCookie()).toEqual([
      "pulse_web_session=tok; Path=/; HttpOnly; SameSite=Lax",
      "pulse_oidc_tx=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
  });

  it("returns pulse-api's redirect rather than following it", async () => {
    const { fetch, calls } = upstream(
      () => new Response(null, { status: 302, headers: { location: "https://id.example/x" } }),
    );
    const res = await proxyToPulseApi(at("/api/auth/oidc/start?return_to=x"), API, fetch);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://id.example/x");
  });

  it("drops the encoding headers of a body the runtime already decoded", async () => {
    // What Node's and Bun's fetch hand back for a gzip upstream: the body
    // decoded, the headers still describing the compressed bytes.
    const { fetch } = upstream(
      () =>
        new Response('{"events":[]}', {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": "31",
          },
        }),
    );
    const res = await proxyToPulseApi(at("/api/events"), API, fetch);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.json()).toEqual({ events: [] });
  });

  it("answers 502 with a fixed body, and no error text, when pulse-api is unreachable", async () => {
    const { fetch } = upstream(() => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.7:3001 secret-host.internal");
    });
    const res = await proxyToPulseApi(at("/api/events"), API, fetch);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "upstream_unavailable" });
    expect(body).not.toContain("ECONNREFUSED");
  });
});
