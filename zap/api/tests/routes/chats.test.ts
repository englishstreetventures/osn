import { generateArcKeyPair } from "@shared/crypto";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createChatsRoutes } from "../../src/routes/chats";
import { createTestLayer } from "../helpers/db";

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
    .sign(testPrivateKey);
}

const json = (body: unknown) => JSON.stringify(body);

function req(
  app: ReturnType<typeof createChatsRoutes>,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body ? { body: json(opts.body) } : {}),
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: Response): Promise<any> => res.json();

describe("chats routes", () => {
  let app: ReturnType<typeof createChatsRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let aliceToken: string;
  let bobToken: string;

  beforeEach(async () => {
    layer = createTestLayer();
    app = createChatsRoutes(layer, "", undefined, testPublicKey);
    aliceToken = await makeToken("usr_alice");
    bobToken = await makeToken("usr_bob");
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  it("GET /chats returns 401 without token", async () => {
    const res = await req(app, "GET", "/chats");
    expect(res.status).toBe(401);
  });

  it("POST /chats returns 401 without token", async () => {
    const res = await req(app, "POST", "/chats", { body: { type: "group" } });
    expect(res.status).toBe(401);
  });

  it("GET /chats/:id returns 401 without token", async () => {
    const res = await req(app, "GET", "/chats/chat_123");
    expect(res.status).toBe(401);
  });

  it("POST /chats/:id/messages returns 401 without token", async () => {
    const res = await req(app, "POST", "/chats/chat_123/messages", {
      body: { ciphertext: "x", nonce: "y" },
    });
    expect(res.status).toBe(401);
  });

  // ── Create chat ─────────────────────────────────────────────────────────

  it("POST /chats creates a group chat and returns 201", async () => {
    const res = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", title: "Test Group" },
    });
    expect(res.status).toBe(201);
    const data = await body(res);
    expect(data.chat.type).toBe("group");
    expect(data.chat.title).toBe("Test Group");
    expect(data.chat.id).toMatch(/^chat_/);
  });

  it("POST /chats returns 422 for invalid type", async () => {
    const res = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "invalid" },
    });
    expect(res.status).toBe(422);
  });

  // ── Get chat (membership gated) ─────────────────────────────────────────

  it("GET /chats/:id returns chat for member", async () => {
    // Create a chat as alice.
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", title: "Members Only" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "GET", `/chats/${chatId}`, { token: aliceToken });
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.chat.id).toBe(chatId);
  });

  it("GET /chats/:id returns 404 for non-member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", title: "Private" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "GET", `/chats/${chatId}`, { token: bobToken });
    expect(res.status).toBe(404);
  });

  it("GET /chats/:id returns 404 for nonexistent chat", async () => {
    const res = await req(app, "GET", "/chats/chat_nonexistent", { token: aliceToken });
    expect(res.status).toBe(404);
  });

  // ── List chats ──────────────────────────────────────────────────────────

  it("GET /chats returns only user's chats", async () => {
    // Create two chats as alice.
    await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", title: "Chat A" },
    });
    await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "dm" },
    });

    const res = await req(app, "GET", "/chats", { token: aliceToken });
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.chats).toHaveLength(2);

    // Bob should see no chats.
    const bobRes = await req(app, "GET", "/chats", { token: bobToken });
    const bobData = await body(bobRes);
    expect(bobData.chats).toHaveLength(0);
  });

  // ── Update chat ─────────────────────────────────────────────────────────

  it("PATCH /chats/:id updates title for admin", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", title: "Old" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "PATCH", `/chats/${chatId}`, {
      token: aliceToken,
      body: { title: "New Title" },
    });
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.chat.title).toBe("New Title");
  });

  it("PATCH /chats/:id returns 404 for non-member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", title: "Hidden" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "PATCH", `/chats/${chatId}`, {
      token: bobToken,
      body: { title: "Nope" },
    });
    expect(res.status).toBe(404);
  });

  // ── Members ─────────────────────────────────────────────────────────────

  it("GET /chats/:id/members returns 404 for non-member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "GET", `/chats/${chatId}/members`, { token: bobToken });
    expect(res.status).toBe(404);
  });

  it("GET /chats/:id/members returns members for member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "GET", `/chats/${chatId}/members`, { token: aliceToken });
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.members).toHaveLength(1);
  });

  it("POST /chats/:id/members adds member and returns 201", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "POST", `/chats/${chatId}/members`, {
      token: aliceToken,
      body: { profileId: "usr_bob" },
    });
    expect(res.status).toBe(201);
    const data = await body(res);
    expect(data.member.profileId).toBe("usr_bob");
  });

  it("POST /chats/:id/members returns 403 for non-admin", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", memberProfileIds: ["usr_bob"] },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "POST", `/chats/${chatId}/members`, {
      token: bobToken,
      body: { profileId: "usr_charlie" },
    });
    expect(res.status).toBe(403);
  });

  it("POST /chats/:id/members returns 409 for duplicate", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", memberProfileIds: ["usr_bob"] },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "POST", `/chats/${chatId}/members`, {
      token: aliceToken,
      body: { profileId: "usr_bob" },
    });
    expect(res.status).toBe(409);
  });

  it("DELETE /chats/:id/members/:profileId removes member and returns 204", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group", memberProfileIds: ["usr_bob"] },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "DELETE", `/chats/${chatId}/members/usr_bob`, {
      token: aliceToken,
    });
    expect(res.status).toBe(204);
  });

  // ── Messages ────────────────────────────────────────────────────────────

  it("POST /chats/:id/messages sends a message and returns 201", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "POST", `/chats/${chatId}/messages`, {
      token: aliceToken,
      body: { ciphertext: "dGVzdA==", nonce: "bm9uY2U=" },
    });
    expect(res.status).toBe(201);
    const data = await body(res);
    expect(data.message.ciphertext).toBe("dGVzdA==");
  });

  it("POST /chats/:id/messages returns 403 for non-member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "POST", `/chats/${chatId}/messages`, {
      token: bobToken,
      body: { ciphertext: "x", nonce: "y" },
    });
    expect(res.status).toBe(403);
  });

  it("GET /chats/:id/messages returns messages for member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    // Send a message first.
    await req(app, "POST", `/chats/${chatId}/messages`, {
      token: aliceToken,
      body: { ciphertext: "dGVzdA==", nonce: "bm9uY2U=" },
    });

    const res = await req(app, "GET", `/chats/${chatId}/messages`, { token: aliceToken });
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.messages).toHaveLength(1);
  });

  it("GET /chats/:id/messages returns 403 for non-member", async () => {
    const createRes = await req(app, "POST", "/chats", {
      token: aliceToken,
      body: { type: "group" },
    });
    const chatId = (await body(createRes)).chat.id;

    const res = await req(app, "GET", `/chats/${chatId}/messages`, { token: bobToken });
    expect(res.status).toBe(403);
  });

  it("GET /chats/:id/messages returns 404 for nonexistent chat", async () => {
    const res = await req(app, "GET", "/chats/chat_nope/messages", { token: aliceToken });
    expect(res.status).toBe(404);
  });
});
