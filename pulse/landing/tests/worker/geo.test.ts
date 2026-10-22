// @vitest-environment node
import { describe, expect, it } from "vitest";

import worker from "../../worker/index";

const ORIGIN = "https://pulse.example.test";

/** An `ASSETS` binding that records each request it serves and answers with a marker. */
function stubAssets() {
  const served: string[] = [];
  return {
    served,
    env: {
      ASSETS: {
        fetch(request: Request): Promise<Response> {
          served.push(`${request.method} ${new URL(request.url).pathname}`);
          return Promise.resolve(new Response("from assets", { status: 299 }));
        },
      },
    },
  };
}

/** A request carrying Cloudflare's edge geo, as workerd delivers it. */
function edgeRequest(path: string, init?: RequestInit, cf?: Record<string, string>): Request {
  return Object.assign(new Request(`${ORIGIN}${path}`, init), { cf });
}

describe("pulse landing's Worker", () => {
  it("G1: GET /api/geo answers the geo JSON with a private five-minute cache, without touching the assets", async () => {
    const assets = stubAssets();
    const res = await worker.fetch(
      edgeRequest("/api/geo", undefined, {
        city: "Austin",
        region: "Texas",
        regionCode: "TX",
        country: "US",
      }),
      assets.env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      city: "Austin",
      region: "Texas",
      regionCode: "TX",
      country: "US",
      count: expect.any(Number),
    });
    expect(body.count).toBeGreaterThanOrEqual(20);
    expect(body.count).toBeLessThanOrEqual(179);

    // No edge geo: every field null, still 200.
    const none = await worker.fetch(edgeRequest("/api/geo"), assets.env);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({
      city: null,
      region: null,
      regionCode: null,
      country: null,
      count: null,
    });
    expect(assets.served).toEqual([]);
  });

  it("G2: every other path goes to the static assets unchanged", async () => {
    const assets = stubAssets();
    for (const path of ["/", "/privacy", "/_astro/app.js", "/api/other", "/api/geo/", "/api"]) {
      const res = await worker.fetch(edgeRequest(path), assets.env);
      expect({ path, status: res.status, body: await res.text() }).toEqual({
        path,
        status: 299,
        body: "from assets",
      });
    }
    const post = await worker.fetch(edgeRequest("/", { method: "POST" }), assets.env);
    expect(post.status).toBe(299);
    expect(assets.served).toEqual([
      "GET /",
      "GET /privacy",
      "GET /_astro/app.js",
      "GET /api/other",
      "GET /api/geo/",
      "GET /api",
      "POST /",
    ]);
  });

  it("G3: a method other than GET or HEAD on /api/geo answers 405, naming the allowed methods", async () => {
    const assets = stubAssets();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await worker.fetch(edgeRequest("/api/geo", { method }), assets.env);
      expect({ method, status: res.status, allow: res.headers.get("allow") }).toEqual({
        method,
        status: 405,
        allow: "GET, HEAD",
      });
    }
    const head = await worker.fetch(edgeRequest("/api/geo", { method: "HEAD" }), assets.env);
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("private, max-age=300");
    expect(assets.served).toEqual([]);
  });
});
