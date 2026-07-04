import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

import { _resetServiceKeysForTests } from "../../src/lib/arc-middleware";
import { createInternalRoutes } from "../../src/routes/internal";
import { createTestLayer } from "../helpers/db";

/**
 * Route-level coverage for the `/internal` group (T-R1): the shared-secret
 * registration gates and the ARC-gated `account-deleted` purge, whose
 * handler was rewired to the factory-scoped `ManagedRuntime` with an
 * `as Effect.Effect<…, Db>` cast — the happy path proves that wiring.
 */

const SECRET = "test-internal-secret";
const KID = "test-osn-kid";

let privateKey: CryptoKey;
let publicKeyJwk: string;

beforeAll(async () => {
  const pair = await generateArcKeyPair();
  privateKey = pair.privateKey;
  publicKeyJwk = await exportKeyToJwk(pair.publicKey);
});

beforeEach(() => {
  _resetServiceKeysForTests();
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.INTERNAL_SERVICE_SECRET;
});

function post(
  app: ReturnType<typeof createInternalRoutes>,
  path: string,
  body: unknown,
  auth?: string,
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function registerBody() {
  return {
    serviceId: "osn-api",
    keyId: KID,
    publicKeyJwk,
    allowedScopes: "account:erase",
  };
}

describe("internal routes — register-service gates", () => {
  it("returns 501 when INTERNAL_SERVICE_SECRET is unset", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const res = await post(
      createInternalRoutes(createTestLayer()),
      "/internal/register-service",
      registerBody(),
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(501);
  });

  it("returns 401 for a wrong shared secret", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer()),
      "/internal/register-service",
      registerBody(),
      "Bearer wrong-secret-oops",
    );
    expect(res.status).toBe(401);
  });

  it("rejects scopes outside the inbound allowlist", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer()),
      "/internal/register-service",
      { ...registerBody(), allowedScopes: "admin:everything" },
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("internal routes — ARC-gated account-deleted purge", () => {
  it("returns 401 without an ARC token", async () => {
    const res = await post(createInternalRoutes(createTestLayer()), "/internal/account-deleted", {
      accountId: "acc_x",
      profileIds: ["usr_x"],
    });
    expect(res.status).toBe(401);
  });

  it("purges through the factory runtime with a valid ARC token", async () => {
    const app = createInternalRoutes(createTestLayer());
    const reg = await post(app, "/internal/register-service", registerBody(), `Bearer ${SECRET}`);
    expect(reg.status).toBe(200);

    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "pulse-api",
      scope: "account:erase",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-deleted",
      { accountId: "acc_gone", profileIds: ["usr_gone"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; purged: number };
    expect(json.ok).toBe(true);
    // `purged` counts processed profile IDs (one here, even with no seeded
    // rows) — reaching it at all proves the handler ran the purge through
    // runtime.runPromise against the test DB.
    expect(json.purged).toBe(1);
  });

  it("rejects an ARC token missing the account:erase scope", async () => {
    const app = createInternalRoutes(createTestLayer());
    await post(
      app,
      "/internal/register-service",
      { ...registerBody(), allowedScopes: "graph:read" },
      `Bearer ${SECRET}`,
    );
    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "pulse-api",
      scope: "graph:read",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-deleted",
      { accountId: "acc_x", profileIds: ["usr_x"] },
      `ARC ${arc}`,
    );
    // requireArc reports every failure as an opaque 401 (no scope oracle).
    expect(res.status).toBe(401);
  });
});
