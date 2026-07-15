import { describe, it, expect } from "vitest";

import { createOriginGuard } from "../../src/lib/origin-guard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeContext(method: string, url: string, origin?: string, authorization?: string): any {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (authorization) headers.set("authorization", authorization);

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

  it("allows POST to S2S /organisations/internal endpoints", () => {
    const ctx = makeContext("POST", "http://localhost:4000/organisations/internal/members");
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("allows POST to S2S /internal endpoints (step-up verify, app-enrollment)", () => {
    const ctx = makeContext("POST", "http://localhost:4000/internal/step-up/verify");
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("exempts any POST carrying an Authorization: ARC header, regardless of path", () => {
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/internal/app-enrollment/leave",
      undefined,
      "ARC eyJhbGciOiJFUzI1NiJ9.payload.sig",
    );
    const result = guard(ctx);
    expect(result).toBeUndefined();
  });

  it("does NOT exempt a look-alike route that only shares a prefix substring", () => {
    const ctx = makeContext("POST", "http://localhost:4000/internal-looking/thing");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
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

  it("admits the monorepo dev ports (@pulse/app:1420, @osn/social:1422) when configured", () => {
    const devGuard = createOriginGuard({
      allowedOrigins: new Set(["http://localhost:1420", "http://localhost:1422"]),
    });
    for (const origin of ["http://localhost:1420", "http://localhost:1422"]) {
      const ctx = makeContext("POST", "http://localhost:4000/handle/alice", origin);
      expect(devGuard(ctx)).toBeUndefined();
    }
    const stale = makeContext(
      "POST",
      "http://localhost:4000/handle/alice",
      "http://localhost:5173",
    );
    const result = devGuard(stale) as { error: string };
    expect(stale.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });
});
