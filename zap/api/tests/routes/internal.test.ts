import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import type { Chat } from "@zap/db/schema";
import { Effect } from "effect";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

import { _resetServiceKeysForTests } from "../../src/lib/arc-middleware";
import { createInternalRoutes } from "../../src/routes/internal";
import {
  createTestLayer,
  seedChat,
  seedMember,
  seedC2bChat,
  seedC2bMessage,
  seedMessage,
} from "../helpers/db";

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

  it("includes c2b message bodies in the export but not c2c ciphertext", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer);

    const reg = await post(app, "/internal/register-service", registerBody(), `Bearer ${SECRET}`);
    expect(reg.status).toBe(200);

    // Seed a c2b chat with two members and two plaintext messages.
    const c2bChat = await Effect.runPromise(
      seedC2bChat({ type: "group" }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2bChat.id, "usr_exported", "member").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2bChat.id, "usr_host", "admin").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_host", "Hello from host!").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_exported", "Hi there!").pipe(Effect.provide(layer)),
    );

    // Seed a c2c chat with a ciphertext message — this must NOT appear in the export.
    const c2cChat = await Effect.runPromise(
      seedChat({ type: "group" }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2cChat.id, "usr_exported", "member").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMessage(c2cChat.id, "usr_exported", "SECRET_CIPHERTEXT_XYZ", new Date()).pipe(
        Effect.provide(layer),
      ),
    );

    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_exported", profile_ids: ["usr_exported"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();

    // Must contain c2b message bodies.
    expect(text).toContain("Hello from host!");
    expect(text).toContain("Hi there!");

    // Must contain the new zap.c2b_messages section.
    expect(text).toContain("zap.c2b_messages");

    // The c2c ciphertext must NEVER appear.
    expect(text).not.toContain("SECRET_CIPHERTEXT_XYZ");
    expect(text).not.toContain("ciphertext");

    // Parse and validate structure of c2b_messages lines.
    const lines = text.split("\n").filter(Boolean);
    const c2bLines = lines.filter((l) => {
      const parsed = JSON.parse(l) as { section: string };
      return parsed.section === "zap.c2b_messages";
    });
    expect(c2bLines).toHaveLength(2);
    for (const line of c2bLines) {
      const parsed = JSON.parse(line) as {
        section: string;
        record: { chatId: string; body: string; createdAt: string };
      };
      expect(parsed.section).toBe("zap.c2b_messages");
      expect(parsed.record.chatId).toBe(c2bChat.id);
      expect(typeof parsed.record.body).toBe("string");
      expect(typeof parsed.record.createdAt).toBe("string");
    }
  });

  it("c2b export is bounded and ordered newest-first (P-W1 hardening)", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer);

    const reg = await post(app, "/internal/register-service", registerBody(), `Bearer ${SECRET}`);
    expect(reg.status).toBe(200);

    const c2bChat = await Effect.runPromise(
      seedC2bChat({ type: "group" }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2bChat.id, "usr_bounded", "member").pipe(Effect.provide(layer)),
    );

    // Seed 3 messages with distinct timestamps (oldest → newest).
    const t0 = new Date("2024-01-01T00:00:00Z");
    const t1 = new Date("2024-01-02T00:00:00Z");
    const t2 = new Date("2024-01-03T00:00:00Z");
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_bounded", "msg-oldest", t0).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_bounded", "msg-middle", t1).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_bounded", "msg-newest", t2).pipe(Effect.provide(layer)),
    );

    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_bounded", profile_ids: ["usr_bounded"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);

    const text = await res.text();
    const c2bLines = text
      .split("\n")
      .filter(Boolean)
      .filter((l) => (JSON.parse(l) as { section: string }).section === "zap.c2b_messages");

    // All 3 seeded bodies must be present (well under the 5 000 cap).
    expect(c2bLines).toHaveLength(3);
    expect(text).toContain("msg-oldest");
    expect(text).toContain("msg-middle");
    expect(text).toContain("msg-newest");

    // Ordered newest-first: first c2b line's body should be the most recent.
    const firstRecord = (
      JSON.parse(c2bLines[0]!) as { record: { body: string; createdAt: string } }
    ).record;
    expect(firstRecord.body).toBe("msg-newest");
    expect(firstRecord.createdAt).toBe(t2.toISOString());
  });
});

// ---------------------------------------------------------------------------
// ARC-gated /internal/chats* (chat:c2b scope)
// ---------------------------------------------------------------------------

const C2B_KID = "test-cire-kid";

/**
 * Helper: register cire-api's key with the chat:c2b scope and return a signed
 * ARC token for it.  Mirrors the pattern in the account-export suite above.
 */
async function registerC2bAndMintToken(
  app: ReturnType<typeof createInternalRoutes>,
  privKey: CryptoKey,
  pubKeyJwk: string,
): Promise<string> {
  const reg = await post(
    app,
    "/internal/register-service",
    {
      serviceId: "cire-api",
      keyId: C2B_KID,
      publicKeyJwk: pubKeyJwk,
      allowedScopes: "chat:c2b",
    },
    `Bearer ${SECRET}`,
  );
  if (reg.status !== 200) throw new Error(`register-service failed: ${reg.status}`);
  return signArcToken(privKey, {
    iss: "cire-api",
    aud: "zap-api",
    scope: "chat:c2b",
    kid: C2B_KID,
  });
}

function get(
  app: ReturnType<typeof createInternalRoutes>,
  path: string,
  auth?: string,
  query?: Record<string, string>,
) {
  const url = new URL(`http://localhost${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return app.handle(
    new Request(url.toString(), {
      method: "GET",
      headers: auth ? { authorization: auth } : {},
    }),
  );
}

describe("zap internal routes — ARC-gated /internal/chats (chat:c2b)", () => {
  // ── 401 guards ──────────────────────────────────────────────────────────

  it("POST /internal/chats → 401 without any token", async () => {
    const res = await post(createInternalRoutes(createTestLayer()), "/internal/chats", {
      memberProfileIds: ["usr_a", "usr_b"],
      createdByProfileId: "usr_a",
    });
    expect(res.status).toBe(401);
  });

  it("POST /internal/chats/:id/messages → 401 without any token", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer()),
      "/internal/chats/chat_fake/messages",
      { senderProfileId: "usr_a", body: "hello" },
    );
    expect(res.status).toBe(401);
  });

  it("GET /internal/chats/:id/messages → 401 without any token", async () => {
    const res = await get(
      createInternalRoutes(createTestLayer()),
      "/internal/chats/chat_fake/messages",
    );
    expect(res.status).toBe(401);
  });

  it("POST /internal/chats → 401 with an account:export-scoped token (wrong scope)", async () => {
    const app = createInternalRoutes(createTestLayer());
    // Register with account:export — not chat:c2b.
    await post(
      app,
      "/internal/register-service",
      { serviceId: "osn-api", keyId: KID, publicKeyJwk, allowedScopes: "account:export" },
      `Bearer ${SECRET}`,
    );
    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_a", "usr_b"], createdByProfileId: "usr_a" },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(401);
  });

  it("POST /internal/chats/:id/messages → 401 with an account:export-scoped token (wrong scope)", async () => {
    const app = createInternalRoutes(createTestLayer());
    await post(
      app,
      "/internal/register-service",
      { serviceId: "osn-api", keyId: KID, publicKeyJwk, allowedScopes: "account:export" },
      `Bearer ${SECRET}`,
    );
    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await post(
      app,
      "/internal/chats/chat_fake/messages",
      { senderProfileId: "usr_a", body: "hello" },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(401);
  });

  it("GET /internal/chats/:id/messages → 401 with an account:export-scoped token (wrong scope)", async () => {
    const app = createInternalRoutes(createTestLayer());
    await post(
      app,
      "/internal/register-service",
      { serviceId: "osn-api", keyId: KID, publicKeyJwk, allowedScopes: "account:export" },
      `Bearer ${SECRET}`,
    );
    const arc = await signArcToken(privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:export",
      kid: KID,
    });
    const res = await get(app, "/internal/chats/chat_fake/messages", `ARC ${arc}`);
    expect(res.status).toBe(401);
  });

  it("GET /internal/chats/:id/messages → 422 with a non-numeric limit param", async () => {
    const app = createInternalRoutes(createTestLayer());
    const arc = await registerC2bAndMintToken(app, privateKey, publicKeyJwk);
    const res = await get(app, "/internal/chats/chat_fake/messages", `ARC ${arc}`, {
      limit: "abc",
    });
    // Elysia rejects the non-numeric query param before reaching the handler.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // ── provision ────────────────────────────────────────────────────────────

  it("POST /internal/chats → 201 + chatId with a valid chat:c2b token", async () => {
    const app = createInternalRoutes(createTestLayer());
    const arc = await registerC2bAndMintToken(app, privateKey, publicKeyJwk);

    const res = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_guest", "usr_host"], createdByProfileId: "usr_host" },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { chatId: string };
    expect(typeof body.chatId).toBe("string");
    expect(body.chatId).toMatch(/^chat_/);
  });

  // ── send + list roundtrip ────────────────────────────────────────────────

  it("POST messages → 201, GET messages returns the body", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer);
    const arc = await registerC2bAndMintToken(app, privateKey, publicKeyJwk);

    // Provision a c2b chat first.
    const provRes = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_guest", "usr_host"], createdByProfileId: "usr_host" },
      `ARC ${arc}`,
    );
    expect(provRes.status).toBe(201);
    const { chatId } = (await provRes.json()) as { chatId: string };

    // Send a message.
    const sendRes = await post(
      app,
      `/internal/chats/${chatId}/messages`,
      { senderProfileId: "usr_host", body: "Hello from host!" },
      `ARC ${arc}`,
    );
    expect(sendRes.status).toBe(201);
    const sent = (await sendRes.json()) as { messageId: string; createdAt: string };
    expect(typeof sent.messageId).toBe("string");
    expect(sent.messageId).toMatch(/^msg_/);
    expect(typeof sent.createdAt).toBe("string");

    // List messages — should include the one we just sent.
    const listRes = await get(app, `/internal/chats/${chatId}/messages`, `ARC ${arc}`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      messages: { id: string; senderProfileId: string; body: string; createdAt: string }[];
    };
    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]!.id).toBe(sent.messageId);
    expect(listed.messages[0]!.body).toBe("Hello from host!");
    expect(listed.messages[0]!.senderProfileId).toBe("usr_host");
  });

  // ── 409 on c2c chat ──────────────────────────────────────────────────────

  it("POST messages to a c2c chat → 409", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer);
    const arc = await registerC2bAndMintToken(app, privateKey, publicKeyJwk);

    // Seed a c2c (default class) chat with a member.
    const c2cChat = await Effect.runPromise(
      seedChat({ type: "group" }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2cChat.id, "usr_host", "member").pipe(Effect.provide(layer)),
    );

    const res = await post(
      app,
      `/internal/chats/${c2cChat.id}/messages`,
      { senderProfileId: "usr_host", body: "should be rejected" },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(409);
  });
});
