import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { Effect } from "effect";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

import { _resetServiceKeysForTests } from "../../src/lib/arc-middleware";
import { createInternalRoutes } from "../../src/routes/internal";
import { createTestLayer, seedChat, seedMember } from "../helpers/db";

/**
 * Route-level coverage for the `/internal` group: the shared-secret
 * registration gate and the ARC-gated `account-export` DSAR endpoint (C-H1).
 * Message content is never read — only chat-membership metadata is emitted.
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
    allowedScopes: "account:export",
  };
}

describe("zap internal routes — register-service gates", () => {
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

describe("zap internal routes — ARC-gated account-export", () => {
  it("returns 401 without an ARC token", async () => {
    const res = await post(createInternalRoutes(createTestLayer()), "/internal/account-export", {
      account_id: "acc_x",
      profile_ids: ["usr_x"],
    });
    expect(res.status).toBe(401);
  });

  it("exports chat memberships as NDJSON with a valid ARC token", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer);

    const reg = await post(app, "/internal/register-service", registerBody(), `Bearer ${SECRET}`);
    expect(reg.status).toBe(200);

    // Seed a chat + membership for the profile being exported.
    const chat = await Effect.runPromise(seedChat({ type: "group" }).pipe(Effect.provide(layer)));
    await Effect.runPromise(seedMember(chat.id, "usr_gone", "admin").pipe(Effect.provide(layer)));

    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_gone", profile_ids: ["usr_gone"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as {
      section: string;
      record: { chatId: string; role: string; joinedAt: string | null };
    };
    expect(parsed.section).toBe("zap.chats");
    expect(parsed.record.chatId).toBe(chat.id);
    expect(parsed.record.role).toBe("admin");
    // Message content must never appear in the export.
    expect(text).not.toContain("ciphertext");
  });

  it("returns an empty body for an empty profile set", async () => {
    const app = createInternalRoutes(createTestLayer());
    await post(app, "/internal/register-service", registerBody(), `Bearer ${SECRET}`);

    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_gone", profile_ids: [] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("rejects an ARC token missing the account:export scope", async () => {
    const app = createInternalRoutes(createTestLayer());
    await post(
      app,
      "/internal/register-service",
      { ...registerBody(), allowedScopes: "account:erase" },
      `Bearer ${SECRET}`,
    );
    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:erase",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_x", profile_ids: ["usr_x"] },
      `ARC ${arc}`,
    );
    // requireArc reports every failure as an opaque 401 (no scope oracle).
    expect(res.status).toBe(401);
  });
});
