import { describe, expect, it } from "vitest";
import { healthRoutes } from "../src/elysia/health";

describe("healthRoutes", () => {
  it("GET /health returns 200", async () => {
    const app = healthRoutes({ serviceName: "test-svc" });
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("test-svc");
  });

  it("GET /ready without probe returns 200", async () => {
    const app = healthRoutes({ serviceName: "test-svc" });
    const res = await app.handle(new Request("http://localhost/ready"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("GET /ready with passing probe returns 200", async () => {
    const app = healthRoutes({
      serviceName: "test-svc",
      probe: async () => true,
    });
    const res = await app.handle(new Request("http://localhost/ready"));
    expect(res.status).toBe(200);
  });

  it("GET /ready with failing probe returns 503", async () => {
    const app = healthRoutes({
      serviceName: "test-svc",
      probe: async () => false,
    });
    const res = await app.handle(new Request("http://localhost/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("not_ready");
  });

  // S-H1: /ready must NOT leak internal probe error messages. The
  // response body on a thrown probe must be identical to the response
  // body on a `return false` probe — no `reason`, no `error`, no
  // `stack`. Operators see the underlying cause in logs.
  it("GET /ready with throwing probe returns 503 WITHOUT leaking error detail", async () => {
    const app = healthRoutes({
      serviceName: "test-svc",
      probe: () => {
        throw new Error(
          "postgres://user:password@internal-db.local:5432/prod — connection refused",
        );
      },
    });
    const res = await app.handle(new Request("http://localhost/ready"));
    expect(res.status).toBe(503);
    const text = await res.text();
    // The secret must not appear in the body.
    expect(text).not.toContain("password");
    expect(text).not.toContain("internal-db.local");
    expect(text).not.toContain("connection refused");
    // Shape is fixed.
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.status).toBe("not_ready");
    expect(body.service).toBe("test-svc");
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("stack");
  });

  it("GET /ready with false-returning probe and throwing probe are indistinguishable", async () => {
    const falseApp = healthRoutes({ serviceName: "svc", probe: () => false });
    const throwApp = healthRoutes({
      serviceName: "svc",
      probe: () => {
        throw new Error("anything");
      },
    });
    const falseBody = await (await falseApp.handle(new Request("http://localhost/ready"))).json();
    const throwBody = await (await throwApp.handle(new Request("http://localhost/ready"))).json();
    expect(falseBody).toEqual(throwBody);
  });
});
