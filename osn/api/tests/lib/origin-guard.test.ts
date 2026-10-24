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

  it("exempts a service-secret POST under /graph/internal (Authorization: Bearer)", () => {
    // Service registration from pulse-api and zap-api. They send no Origin,
    // and pulse-api swallows a failed registration at boot, so nothing else
    // would notice this exemption going away.
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/graph/internal/register-service",
      undefined,
      "Bearer shared-service-secret",
    );
    expect(guard(ctx)).toBeUndefined();
  });

  it("exempts the dev sign-in form POST by its exact path", () => {
    const ctx = makeContext("POST", "http://localhost:4000/dev/login/form");
    expect(guard(ctx)).toBeUndefined();
  });

  it("checks Origin on dev sign-in path look-alikes", () => {
    for (const path of ["/dev/login/form-x", "/dev/login/form/x", "/dev/login"]) {
      const ctx = makeContext("POST", `http://localhost:4000${path}`);
      expect(guard(ctx)).toEqual({ error: "forbidden", message: "Missing Origin header" });
    }
  });

  // The internal prefixes skip the Origin check only for a request that
  // carries credentials. A browser can attach a cookie cross-site but not an
  // Authorization header, so a credential-less request there is checked like
  // any other route.
  it("checks Origin on a POST under /internal that carries no Authorization", () => {
    const ctx = makeContext("POST", "http://localhost:4000/internal/step-up/verify");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("checks Origin on a POST under /graph/internal that carries no Authorization", () => {
    const ctx = makeContext("POST", "http://localhost:4000/graph/internal/profile-displays");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("rejects a foreign Origin under /organisations/internal with no Authorization", () => {
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/organisations/internal/members",
      "http://evil.com",
    );
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("checks Origin on a DELETE under /graph/internal that carries no Authorization", () => {
    const ctx = makeContext("DELETE", "http://localhost:4000/graph/internal/service-keys/k1");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("checks Origin under /internal when Authorization uses another scheme", () => {
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/internal/step-up/verify",
      undefined,
      "Basic dXNlcjpwYXNz",
    );
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("checks Origin on a Bearer POST outside the internal prefixes", () => {
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/login/otp/begin",
      undefined,
      "Bearer eyJhbGciOiJFUzI1NiJ9.payload.sig",
    );
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
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

  it("admits the monorepo dev ports (@pulse/web:1420, @musubi/social:1422) when configured", () => {
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

  it("still rejects a literal `null` Origin", () => {
    // A sandboxed iframe sends `Origin: null`, which must never match an
    // allowlist entry regardless of scheme.
    const ctx = makeContext("POST", "http://localhost:4000/handle/alice", "null");
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });

  it("rejects an origin that merely has an allowed origin as a string prefix", () => {
    // `http://localhost:5173.evil.com` starts with the allowed origin as a
    // substring — the guard must match the whole origin, not a prefix.
    const ctx = makeContext(
      "POST",
      "http://localhost:4000/handle/alice",
      "http://localhost:5173.evil.com",
    );
    const result = guard(ctx) as { error: string };
    expect(ctx.set.status).toBe(403);
    expect(result.error).toBe("forbidden");
  });
});
