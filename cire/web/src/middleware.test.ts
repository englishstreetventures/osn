import type { APIContext, MiddlewareNext } from "astro";
import { describe, expect, it } from "vitest";

import { cspHeaderName } from "./lib/security-headers";
import { onRequest } from "./middleware";

// The middleware only uses `next()`, so a minimal context cast is sufficient.
const fakeContext = {} as APIContext;

/**
 * Run the middleware and assert it returned a `Response` (its declared return
 * type is `Response | void`; ours always resolves to the downstream Response).
 */
async function run(next: MiddlewareNext): Promise<Response> {
  const res = await onRequest(fakeContext, next);
  expect(res).toBeInstanceOf(Response);
  return res as Response;
}

describe("onRequest middleware", () => {
  it("attaches the security headers to the downstream SSR response", async () => {
    const downstream = new Response("<html>invite</html>", {
      headers: { "Content-Type": "text/html" },
    });
    const next = (() => Promise.resolve(downstream)) as unknown as MiddlewareNext;

    const res = await run(next);

    expect(res.headers.get(cspHeaderName())).toContain("frame-ancestors 'none'");
    expect(res.headers.get(cspHeaderName())).toContain(
      "script-src 'self' 'unsafe-inline' https://assets.pinterest.com https://challenges.cloudflare.com",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    // The downstream response is passed through (headers added in place).
    expect(res.headers.get("Content-Type")).toBe("text/html");
  });

  it("hardens a redirect response too (the bare-domain 302)", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/some-slug" },
    });
    const next = (() => Promise.resolve(redirect)) as unknown as MiddlewareNext;

    const res = await run(next);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/some-slug");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get(cspHeaderName())).toContain("frame-ancestors 'none'");
  });
});
