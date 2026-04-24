import { makeLogEmailLive } from "@shared/email";
import { Layer } from "effect";
import { describe, it, expect, beforeAll } from "vitest";

import { createAuthRoutes } from "../../src/routes/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

function buildEmailCapture(baseLayer: ReturnType<typeof createTestLayer>) {
  const rec = makeLogEmailLive();
  return {
    layer: Layer.merge(baseLayer, rec.layer),
    code: () => {
      const all = rec.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/code is: (\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    },
  };
}

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/** Register a user and return an access token for authenticated CDL endpoints. */
async function registerAndGetAccessToken(
  app: ReturnType<typeof createAuthRoutes>,
  captured: { code: () => string | undefined },
  email: string,
  handle: string,
): Promise<string> {
  await app.handle(
    new Request("http://localhost/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, handle }),
    }),
  );
  const completeRes = await app.handle(
    new Request("http://localhost/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: captured.code() }),
    }),
  );
  const json = (await completeRes.json()) as { session: { access_token: string } };
  return json.session.access_token;
}

describe("cross-device login routes", () => {
  it("POST /login/cross-device/begin returns 200 with requestId + secret", async () => {
    const base = createTestLayer();
    const { layer } = buildEmailCapture(base);
    const app = createAuthRoutes(config, layer);

    const res = await app.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requestId: string;
      cdlSecret: string;
      expiresAt: number;
    };
    expect(body.requestId).toMatch(/^cdl_[a-f0-9]{12}$/);
    expect(body.cdlSecret).toHaveLength(64);
    expect(body.expiresAt).toBeGreaterThan(0);
  });

  it("POST /login/cross-device/:requestId/status returns pending before approval", async () => {
    const base = createTestLayer();
    const { layer } = buildEmailCapture(base);
    const app = createAuthRoutes(config, layer);

    const beginRes = await app.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    const { requestId, cdlSecret: secret } = (await beginRes.json()) as {
      requestId: string;
      cdlSecret: string;
    };

    const statusRes = await app.handle(
      new Request(`http://localhost/login/cross-device/${requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(statusRes.status).toBe(200);
    const body = (await statusRes.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("full lifecycle: begin → approve → poll returns session with Set-Cookie", async () => {
    const base = createTestLayer();
    const cap = buildEmailCapture(base);
    const app = createAuthRoutes(config, cap.layer);

    // Register user (device A)
    const accessToken = await registerAndGetAccessToken(
      app,
      cap,
      "cdl-route@example.com",
      "cdl_route_user",
    );

    // Device B begins CDL
    const beginRes = await app.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    const { requestId, cdlSecret: secret } = (await beginRes.json()) as {
      requestId: string;
      cdlSecret: string;
    };

    // Device A approves
    const approveRes = await app.handle(
      new Request(`http://localhost/login/cross-device/${requestId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as { success: boolean };
    expect(approveBody.success).toBe(true);

    // Device B polls and gets session
    const statusRes = await app.handle(
      new Request(`http://localhost/login/cross-device/${requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      status: string;
      session: { access_token: string; token_type: string; expires_in: number };
      profile: { handle: string };
    };
    expect(statusBody.status).toBe("approved");
    expect(statusBody.session.access_token).toBeTruthy();
    expect(statusBody.session.token_type).toBe("Bearer");
    expect(statusBody.profile.handle).toBe("cdl_route_user");

    // Set-Cookie header present
    const cookie = statusRes.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("osn_session");
  });

  it("approve returns 401 without access token", async () => {
    const base = createTestLayer();
    const { layer } = buildEmailCapture(base);
    const app = createAuthRoutes(config, layer);

    const beginRes = await app.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    const { requestId, cdlSecret: secret } = (await beginRes.json()) as {
      requestId: string;
      cdlSecret: string;
    };

    const res = await app.handle(
      new Request(`http://localhost/login/cross-device/${requestId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("reject returns 200 and marks request as rejected", async () => {
    const base = createTestLayer();
    const cap = buildEmailCapture(base);
    const app = createAuthRoutes(config, cap.layer);

    const accessToken = await registerAndGetAccessToken(
      app,
      cap,
      "cdl-reject@example.com",
      "cdl_reject",
    );

    const beginRes = await app.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    const { requestId, cdlSecret: secret } = (await beginRes.json()) as {
      requestId: string;
      cdlSecret: string;
    };

    const rejectRes = await app.handle(
      new Request(`http://localhost/login/cross-device/${requestId}/reject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(rejectRes.status).toBe(200);

    const statusRes = await app.handle(
      new Request(`http://localhost/login/cross-device/${requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      }),
    );
    const body = (await statusRes.json()) as { status: string };
    expect(body.status).toBe("rejected");
  });

  it("rate limits begin endpoint", async () => {
    const base = createTestLayer();
    const { layer } = buildEmailCapture(base);
    const app = createAuthRoutes(config, layer);

    // 5 requests pass, 6th is rate-limited
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
      const res = await app.handle(
        new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
      );
      expect(res.status).toBe(200);
    }
    const res = await app.handle(
      new Request("http://localhost/login/cross-device/begin", { method: "POST" }),
    );
    expect(res.status).toBe(429);
  });
});
