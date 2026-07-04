import { generateArcKeyPair } from "@shared/crypto";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { describe, it, expect, beforeAll, vi } from "vitest";

import { createTestLayer } from "../helpers/db";

/**
 * Route-level coverage for the `/account` group (T-R1). The DSAR-critical
 * handlers were rewired from per-request `Effect.provide(dbLayer)` to a
 * factory-scoped `ManagedRuntime` with `as Effect.Effect<…, Db>` casts —
 * these tests prove the runtime wiring the casts assert: one request per
 * handler through `runtime.runPromise`, plus the 401/403 gates.
 */
vi.mock("../../src/lib/osn-bridge", () => ({
  OsnBridgeError: class OsnBridgeError {
    _tag = "OsnBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  verifyStepUp: vi.fn(() => Effect.succeed({ ok: true, accountId: "acc_test" } as const)),
  notifyAppLeft: vi.fn(() => Effect.succeed({ closed: true } as const)),
}));

import { createAccountRoutes } from "../../src/routes/account";

let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateArcKeyPair();
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;
});

async function makeToken(profileId: string): Promise<string> {
  return new SignJWT({ sub: profileId })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .setAudience("osn-access")
    .sign(testPrivateKey);
}

function makeApp() {
  return createAccountRoutes(createTestLayer(), "http://unused.test/jwks", testPublicKey);
}

describe("account routes — auth gates", () => {
  it.each([
    ["DELETE", "/account"],
    ["POST", "/account/restore"],
    ["GET", "/account/deletion-status"],
  ] as const)("%s %s returns 401 without a bearer token", async (method, path) => {
    const init: RequestInit =
      method === "DELETE"
        ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
        : { method };
    const res = await makeApp().handle(new Request(`http://localhost${path}`, init));
    expect(res.status).toBe(401);
  });

  it("DELETE /account returns 403 without a step-up token", async () => {
    const token = await makeToken("usr_gate");
    const res = await makeApp().handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("step_up_required");
  });
});

describe("account routes — runtime wiring (ManagedRuntime)", () => {
  it("GET /deletion-status reaches the DB through the factory runtime", async () => {
    const token = await makeToken("usr_status");
    const res = await makeApp().handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scheduled: boolean }).scheduled).toBe(false);
  });

  it("POST /restore is a no-op 200 when nothing is scheduled", async () => {
    const token = await makeToken("usr_restore");
    const res = await makeApp().handle(
      new Request("http://localhost/account/restore", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cancelled: boolean }).cancelled).toBe(false);
  });

  it("DELETE /account schedules erasure (202) with verified step-up", async () => {
    const app = makeApp();
    const token = await makeToken("usr_delete");
    const res = await app.handle(
      new Request("http://localhost/account", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ step_up_token: "stub-step-up" }),
      }),
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { scheduled_for: string; already_pending: boolean };
    expect(json.already_pending).toBe(false);
    expect(json.scheduled_for).toBeTruthy();

    // Same runtime, same DB: the status endpoint now sees the scheduled row.
    const status = await app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(((await status.json()) as { scheduled: boolean }).scheduled).toBe(true);
  });
});
