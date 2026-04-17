import { describe, it, expect } from "vitest";

import { createOriginGuard } from "../../src/lib/origin-guard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeContext(method: string, url: string, origin?: string): any {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);

  return {
    request: new Request(url, { method, headers }),
    set: { status: 200 },
  };
}

describe("createOriginGuard", () => {
  const allowedOrigins = new Set(["http://localhost:5173"]);
  const guard = createOriginGuard({ allowedOrigins });

  it("allows GET requests without Origin header", () => {
    const ctx = makeContext("GET", "http://localhost:4000/profiles/list");
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("allows HEAD requests without Origin header", () => {
    const ctx = makeContext("HEAD", "http://localhost:4000/token");
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("allows POST to S2S graph/internal endpoints", () => {
    const ctx = makeContext("POST", "http://localhost:4000/graph/internal/connections");
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("allows POST to S2S organisation-internal endpoints", () => {
    const ctx = makeContext("POST", "http://localhost:4000/organisation-internal/members");
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("allows POST with matching Origin", () => {
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/login/otp/begin",
      "http://localhost:5173",
    );
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("rejects POST with missing Origin", () => {
    const ctx = makeContext("POST", "http://localhost:4000/login/otp/begin");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("rejects POST with mismatched Origin", () => {
    const ctx = makeContext("POST", "http://localhost:4000/login/otp/begin", "http://evil.com");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("rejects PUT with missing Origin", () => {
    const ctx = makeContext("PUT", "http://localhost:4000/some/resource");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("rejects DELETE with missing Origin", () => {
    const ctx = makeContext("DELETE", "http://localhost:4000/some/resource");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("skips validation in dev mode (empty allowedOrigins)", () => {
    const devGuard = createOriginGuard({ allowedOrigins: new Set() });
    const ctx = makeContext("POST", "http://localhost:4000/login/otp/begin");
    const result = devGuard(ctx);
    expect(result).toBeUndefined();
  });
});
