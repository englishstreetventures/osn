import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";

import { originGuard } from "../../src/lib/origin-guard";

const ALLOWED = ["https://pulse.example"];

const makeApp = (allowed: readonly string[] = ALLOWED) =>
  new Elysia({ aot: false })
    .use(originGuard(allowed))
    .get("/read", () => ({ ok: true }))
    .post("/write", () => ({ ok: true }))
    .delete("/write", () => ({ ok: true }));

const call = (
  app: ReturnType<typeof makeApp>,
  method: string,
  headers: Record<string, string> = {},
) => app.handle(new Request("http://localhost/write", { method, headers }));

const SESSION = "pulse_web_session=tok_abc123";

describe("originGuard", () => {
  it("passes a state-changing request that carries no session cookie", async () => {
    // The iOS app sends a bearer token and no Origin header at all. Guarding it
    // would 403 every native write.
    const res = await call(makeApp(), "POST");
    expect(res.status).toBe(200);
  });

  it("passes an unauthenticated share/exposure ping with an unrelated cookie", async () => {
    const res = await call(makeApp(), "POST", { cookie: "ab_bucket=3" });
    expect(res.status).toBe(200);
  });

  it("403s a cookie-carrying write with no Origin header", async () => {
    const res = await call(makeApp(), "POST", { cookie: SESSION });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("403s a cookie-carrying write from an origin outside the allowlist", async () => {
    const res = await call(makeApp(), "POST", {
      cookie: SESSION,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: "Origin not allowed" });
  });

  it("passes a cookie-carrying write from an allowed origin", async () => {
    const res = await call(makeApp(), "POST", {
      cookie: SESSION,
      origin: "https://pulse.example",
    });
    expect(res.status).toBe(200);
  });

  it("guards DELETE as well as POST", async () => {
    const res = await call(makeApp(), "DELETE", { cookie: SESSION });
    expect(res.status).toBe(403);
  });

  it("never fires on a GET, cookie or not", async () => {
    const res = await makeApp().handle(
      new Request("http://localhost/read", { headers: { cookie: SESSION } }),
    );
    expect(res.status).toBe(200);
  });

  it("is disabled by an empty allowlist (local dev, no corsOrigins)", async () => {
    const res = await call(makeApp([]), "POST", { cookie: SESSION });
    expect(res.status).toBe(200);
  });
});
