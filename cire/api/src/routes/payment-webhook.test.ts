import { describe, it, expect } from "bun:test";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createPaymentWebhookSkeleton } from "./payment-webhook";

// Elysia 1.4.x requires app.fetch (absolute URL) rather than app.handle —
// app.handle delegates to fetch but the Bun adapter only wires up the
// compiled handler on fetch, so handle always 404s on an uncompiled instance.
// All other route tests in this package use app.fetch for the same reason.

describe("payment webhook skeleton (Phase 1 — inert)", () => {
  it("returns 501 not_implemented and never processes", async () => {
    const app = createPaymentWebhookSkeleton();
    const res = await app.fetch(
      new Request("http://localhost/api/payments/webhook", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not_implemented" });
  });
});

// Integration tests: verify the unmounted-by-default invariant via createApp.
// Security contract: POST /api/payments/webhook MUST NOT be reachable unless
// the deployment explicitly opts in via { paymentWebhookEnabled: true }.
describe("payment webhook mount invariant via createApp", () => {
  const db = createDb(":memory:");
  seedDb(db);

  it("returns 404 when paymentWebhookEnabled is absent (default)", async () => {
    const app = createApp(db);
    const res = await app.fetch(
      new Request("http://localhost/api/payments/webhook", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 501 not_implemented when paymentWebhookEnabled is true", async () => {
    const app = createApp(db, { paymentWebhookEnabled: true });
    const res = await app.fetch(
      new Request("http://localhost/api/payments/webhook", {
        method: "POST",
        body: "{}",
        // Origin header required — createApp mounts originGuard which 403s
        // state-changing requests without a matching Origin. The default
        // webOrigin is http://localhost:4321 (same as claim.test.ts).
        headers: { Origin: "http://localhost:4321" },
      }),
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not_implemented" });
  });
});
