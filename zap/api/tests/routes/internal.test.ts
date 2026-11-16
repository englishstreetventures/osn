import * as sharedCrypto from "@shared/crypto";
import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { Effect } from "effect";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import { _resetServiceKeysForTests } from "../../src/lib/arc-middleware";
import { MAX_EXPORT_PROFILE_IDS } from "../../src/lib/limits";
import { createInternalRoutes } from "../../src/routes/internal";
import {
  createCapturingTestLayer,
  createTestLayer,
  seedChat,
  seedMember,
  seedC2bChat,
  seedC2bMessage,
  seedMessage,
} from "../helpers/db";
import { osnArc } from "../helpers/osn-arc";

/**
 * Route-level coverage for the `/internal` group: the shared-secret
 * registration gate and the ARC-gated `account-export` DSAR endpoint.
 * Message content is never read — only chat-membership metadata is emitted.
 */

// The same secret the osn-api stand-in mints its kid MAC under, and long
// enough to key one.
const SECRET = "test-internal-secret-of-32-chars!";
const KID = "test-osn-kid";

let privateKey: CryptoKey;
let publicKeyJwk: string;

beforeAll(async () => {
  const pair = await generateArcKeyPair();
  privateKey = pair.privateKey;
  publicKeyJwk = await exportKeyToJwk(pair.publicKey);
});

let osn: Awaited<ReturnType<typeof osnArc>>;

/** A token osn-api signed with its published key, without the `ARC ` prefix. */
const osnToken = async (scope: string, claims: { iss?: string; aud?: string } = {}) =>
  (await osn.token(scope, claims)).replace(/^ARC /, "");

beforeEach(async () => {
  _resetServiceKeysForTests();
  osn = await osnArc();
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
});

afterEach(() => {
  osn.restore();
  vi.restoreAllMocks();
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
    serviceId: "cire-api",
    keyId: KID,
    publicKeyJwk,
    allowedScopes: "chat:c2b",
  };
}

describe("zap internal routes — register-service gates", () => {
  it("returns 501 when INTERNAL_SERVICE_SECRET is unset", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/register-service",
      registerBody(),
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(501);
  });

  it("returns 401 for a wrong shared secret", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/register-service",
      registerBody(),
      "Bearer wrong-secret-oops",
    );
    expect(res.status).toBe(401);
  });

  it("rejects scopes outside the inbound allowlist", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/register-service",
      { ...registerBody(), allowedScopes: "admin:everything" },
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("zap internal routes — ARC-gated account-export", () => {
  it("returns 401 without an ARC token", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/account-export",
      {
        account_id: "acc_x",
        profile_ids: ["usr_x"],
      },
    );
    expect(res.status).toBe(401);
  });

  it("exports chat memberships as NDJSON with a valid ARC token", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, osn.verification);

    // Seed a chat + membership for the profile being exported.
    const chat = await Effect.runPromise(seedChat({ type: "group" }).pipe(Effect.provide(layer)));
    await Effect.runPromise(seedMember(chat.id, "usr_gone", "admin").pipe(Effect.provide(layer)));

    const arc = await osnToken("account:export");
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
    const app = createInternalRoutes(createTestLayer(), osn.verification);

    const arc = await osnToken("account:export");
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
    const app = createInternalRoutes(createTestLayer(), osn.verification);
    const arc = await osnToken("account:erase");
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
    const app = createInternalRoutes(layer, osn.verification);

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

    const arc = await osnToken("account:export");
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
    const app = createInternalRoutes(layer, osn.verification);

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

    const arc = await osnToken("account:export");
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

  it("binds the profile ids as one parameter in both export reads, at the cap", async () => {
    // The c2b read also binds the chat class and its row limit, so the id
    // list has to cost one parameter for the read to fit D1's 100 at the cap.
    const { layer, captured } = createCapturingTestLayer();
    const app = createInternalRoutes(layer, osn.verification);
    const profileIds = Array.from({ length: MAX_EXPORT_PROFILE_IDS }, (_, i) => `usr_cap_${i}`);
    const c2bChat = await Effect.runPromise(
      seedC2bChat({ type: "group" }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2bChat.id, profileIds.at(-1)!, "member").pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, profileIds.at(-1)!, "Last profile's message").pipe(
        Effect.provide(layer),
      ),
    );
    captured.length = 0;

    const arc = await osnToken("account:export");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_cap", profile_ids: profileIds },
      `ARC ${arc}`,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("zap.chats");
    expect(text).toContain("Last profile's message");
    const reads = captured.filter((c) => c.sql.includes('"chat_members"."profile_id" in'));
    expect(reads.map((c) => c.params.length).toSorted()).toEqual([1, 3]);
  });

  it("rejects profile_ids over the export cap with 400", async () => {
    const app = createInternalRoutes(createTestLayer(), osn.verification);

    const arc = await osnToken("account:export");
    const overCap = Array.from({ length: MAX_EXPORT_PROFILE_IDS + 1 }, (_, i) => `usr_${i}`);
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_x", profile_ids: overCap },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `profile_ids exceeds max of ${MAX_EXPORT_PROFILE_IDS}`,
    });
  });

  it("keeps two distinct c2b messages that share a body and same-second createdAt (groupBy, not DISTINCT)", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, osn.verification);

    const c2bChat = await Effect.runPromise(
      seedC2bChat({ type: "group" }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedMember(c2bChat.id, "usr_dup", "member").pipe(Effect.provide(layer)),
    );

    // Both timestamps round to the same integer second once stored (the
    // `createdAt` column is second-resolution) — two genuinely different
    // messages, same body, same stored second.
    const first = new Date("2024-06-01T12:00:00.100Z");
    const second = new Date("2024-06-01T12:00:00.900Z");
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_dup", "same body text", first).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedC2bMessage(c2bChat.id, "usr_dup", "same body text", second).pipe(Effect.provide(layer)),
    );

    const arc = await osnToken("account:export");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_dup", profile_ids: ["usr_dup"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const c2bLines = text
      .split("\n")
      .filter(Boolean)
      .filter((l) => (JSON.parse(l) as { section: string }).section === "zap.c2b_messages");

    // A `.distinct()` on the projected {chatId, body, createdAt} columns
    // would collapse these into one row, silently dropping a message from
    // the DSAR export. `.groupBy(messages.id)` must keep both.
    expect(c2bLines).toHaveLength(2);
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
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/chats",
      {
        memberProfileIds: ["usr_a", "usr_b"],
        createdByProfileId: "usr_a",
      },
    );
    expect(res.status).toBe(401);
  });

  it("POST /internal/chats/:id/messages → 401 without any token", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/chats/chat_fake/messages",
      { senderProfileId: "usr_a", body: "hello" },
    );
    expect(res.status).toBe(401);
  });

  it("GET /internal/chats/:id/messages → 401 without any token", async () => {
    const res = await get(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/chats/chat_fake/messages",
    );
    expect(res.status).toBe(401);
  });

  it("POST /internal/chats → 401 with an account:export-scoped token (wrong scope)", async () => {
    const app = createInternalRoutes(createTestLayer(), osn.verification);
    // osn-api may use account:export here, never chat:c2b.
    const arc = await osnToken("account:export");
    const res = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_a", "usr_b"], createdByProfileId: "usr_a" },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(401);
  });

  it("POST /internal/chats/:id/messages → 401 with an account:export-scoped token (wrong scope)", async () => {
    const app = createInternalRoutes(createTestLayer(), osn.verification);
    const arc = await osnToken("account:export");
    const res = await post(
      app,
      "/internal/chats/chat_fake/messages",
      { senderProfileId: "usr_a", body: "hello" },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(401);
  });

  it("GET /internal/chats/:id/messages → 401 with an account:export-scoped token (wrong scope)", async () => {
    const app = createInternalRoutes(createTestLayer(), osn.verification);
    const arc = await osnToken("account:export");
    const res = await get(app, "/internal/chats/chat_fake/messages", `ARC ${arc}`);
    expect(res.status).toBe(401);
  });

  it("GET /internal/chats/:id/messages → 422 with a non-numeric limit param", async () => {
    const app = createInternalRoutes(createTestLayer(), osn.verification);
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
    const app = createInternalRoutes(createTestLayer(), osn.verification);
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
    const app = createInternalRoutes(layer, osn.verification);
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
    // The wire-level half of the `storedNow` contract: the timestamp the POST
    // reports and the one the GET reports are the same string. Untruncated,
    // the write would answer "…:00.123Z" and every later read "…:00.000Z".
    expect(listed.messages[0]!.createdAt).toBe(sent.createdAt);
  });

  // ── unknown cursor ───────────────────────────────────────────────────────

  it("GET messages with an unknown before cursor → 400", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, osn.verification);
    const arc = await registerC2bAndMintToken(app, privateKey, publicKeyJwk);

    const provRes = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_guest", "usr_host"], createdByProfileId: "usr_host" },
      `ARC ${arc}`,
    );
    const { chatId } = (await provRes.json()) as { chatId: string };
    await post(
      app,
      `/internal/chats/${chatId}/messages`,
      { senderProfileId: "usr_host", body: "Hello" },
      `ARC ${arc}`,
    );

    // Previously this answered 200 with page 1, so a caller paginating with a
    // stale cursor looped over the newest page instead of being told.
    const res = await get(app, `/internal/chats/${chatId}/messages`, `ARC ${arc}`, {
      before: "msg_nonexistent",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "Invalid cursor" });
  });

  // ── 409 on c2c chat ──────────────────────────────────────────────────────

  it("POST messages to a c2c chat → 409", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, osn.verification);
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

describe("zap internal routes — the account deletion (osn-api only)", () => {
  const ROUTES = [
    {
      path: "/internal/account-deletion-preview",
      scope: "account:deletion-preview",
      body: { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
    },
    {
      path: "/internal/account-deleted",
      scope: "account:erase",
      body: { accountId: "acc_x", profileIds: ["usr_x"], choices: {}, deleteEverything: false },
    },
  ] as const;

  for (const route of ROUTES) {
    it(`${route.path} refuses no token, another issuer, another audience, another scope, and cire-api's key`, async () => {
      const app = createInternalRoutes(createTestLayer(), osn.verification);
      const pair = await generateArcKeyPair();
      const cire = await registerC2bAndMintToken(
        app,
        pair.privateKey,
        await exportKeyToJwk(pair.publicKey),
      );
      const other = route.scope === "account:erase" ? "account:export" : "account:erase";
      for (const auth of [
        undefined,
        `ARC ${await osnToken(route.scope, { iss: "cire-api" })}`,
        `ARC ${await osnToken(route.scope, { aud: "pulse-api" })}`,
        `ARC ${await osnToken(other)}`,
        `ARC ${cire}`,
      ]) {
        expect((await post(app, route.path, route.body, auth)).status).toBe(401);
      }
      expect(
        (await post(app, route.path, route.body, `ARC ${await osnToken(route.scope)}`)).status,
      ).toBe(200);
    });
  }

  it("refuses a registered key's token that claims osn-api and an account scope", async () => {
    // A key registered under another service, signing a token that claims
    // osn-api: refused, whether by osn-api's published keys, where its kid is
    // unknown, or by the registry, where the key holds no account scope.
    const app = createInternalRoutes(createTestLayer(), osn.verification);
    const pair = await generateArcKeyPair();
    await post(
      app,
      "/internal/register-service",
      {
        serviceId: "cire-api",
        keyId: "shadow-kid",
        publicKeyJwk: await exportKeyToJwk(pair.publicKey),
        allowedScopes: "chat:c2b",
      },
      `Bearer ${SECRET}`,
    );
    const forged = await signArcToken(pair.privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "account:erase",
      kid: "shadow-kid",
    });
    const res = await post(
      app,
      "/internal/account-deleted",
      { accountId: "acc_x", profileIds: ["usr_x"] },
      `ARC ${forged}`,
    );
    expect(res.status).toBe(401);
  });

  it("never takes a token that claims osn-api to the registry, even for a scope a registered key holds", async () => {
    const app = createInternalRoutes(createTestLayer(), osn.verification);
    const pair = await generateArcKeyPair();
    await post(
      app,
      "/internal/register-service",
      {
        serviceId: "cire-api",
        keyId: "shadow-c2b-kid",
        publicKeyJwk: await exportKeyToJwk(pair.publicKey),
        allowedScopes: "chat:c2b",
      },
      `Bearer ${SECRET}`,
    );
    const forged = await signArcToken(pair.privateKey, {
      iss: "osn-api",
      aud: "zap-api",
      scope: "chat:c2b",
      kid: "shadow-c2b-kid",
    });
    const registry = vi.spyOn(sharedCrypto, "verifyArcToken");
    const res = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_a", "usr_b"], createdByProfileId: "usr_a" },
      `ARC ${forged}`,
    );
    expect(res.status).toBe(401);
    expect(registry).not.toHaveBeenCalled();
  });

  it("refuses a published key under a kid with no MAC or a wrong one, before any fetch", async () => {
    const [, expiry] = osn.kid.split(".");
    for (const kid of [
      `${crypto.randomUUID()}.${expiry}`,
      `${crypto.randomUUID()}.${expiry}.${"A".repeat(22)}`,
    ]) {
      const before = osn.fetches();
      const res = await post(
        createInternalRoutes(createTestLayer(), osn.verification),
        "/internal/account-deletion-preview",
        { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
        await osn.tokenUnderKid("account:deletion-preview", kid),
      );
      expect(res.status).toBe(401);
      expect(osn.fetches()).toBe(before);
    }
  });

  it.each([
    ["holds no secret", undefined],
    ["holds a secret too short to key the MAC", "s".repeat(31)],
  ])("admits that kid when Zap %s: the secret is what refuses it", async (_label, secret) => {
    if (secret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = secret;
    const [, expiry] = osn.kid.split(".");
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/account-deletion-preview",
      { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
      await osn.tokenUnderKid("account:deletion-preview", `${crypto.randomUUID()}.${expiry}`),
    );
    expect(res.status).toBe(200);
  });

  it("after an erasure, the other side reads the person's consumer-to-business message as empty and unnamed, and exports only its own", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, osn.verification);
    const pair = await generateArcKeyPair();
    const cire = `ARC ${await registerC2bAndMintToken(app, pair.privateKey, await exportKeyToJwk(pair.publicKey))}`;
    const provisioned = await post(
      app,
      "/internal/chats",
      { memberProfileIds: ["usr_me", "usr_them"], createdByProfileId: "usr_them" },
      cire,
    );
    const { chatId } = (await provisioned.json()) as { chatId: string };
    for (const [sender, body] of [
      ["usr_me", "From me"],
      ["usr_them", "From them"],
    ] as const) {
      const sent = await post(
        app,
        `/internal/chats/${chatId}/messages`,
        { senderProfileId: sender, body },
        cire,
      );
      expect(sent.status).toBe(201);
    }

    const erased = await post(
      app,
      "/internal/account-deleted",
      { accountId: "acc_me", profileIds: ["usr_me"], choices: {}, deleteEverything: false },
      `ARC ${await osnToken("account:erase")}`,
    );
    expect(erased.status).toBe(200);

    const listed = await get(app, `/internal/chats/${chatId}/messages`, cire);
    expect(listed.status).toBe(200);
    const { messages: read } = (await listed.json()) as {
      messages: { senderProfileId: string; body: string }[];
    };
    expect(
      read
        .map((m) => ({ senderProfileId: m.senderProfileId, body: m.body }))
        .toSorted((a, b) => a.body.localeCompare(b.body)),
    ).toEqual([
      { senderProfileId: "deleted", body: "" },
      { senderProfileId: "usr_them", body: "From them" },
    ]);

    const exported = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_them", profile_ids: ["usr_them"] },
      `ARC ${await osnToken("account:export")}`,
    );
    const c2b = (await exported.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { section: string; record: { body: string } })
      .filter((line) => line.section === "zap.c2b_messages");
    expect(c2b.map((line) => line.record.body)).toEqual(["From them"]);
  });

  it("refuses to register a key for osn-api, which publishes its own", async () => {
    const res = await post(
      createInternalRoutes(createTestLayer(), osn.verification),
      "/internal/register-service",
      { ...registerBody(), serviceId: "osn-api" },
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "service_id_reserved" });
  });

  it("the preview answers no actions, and the erasure what Zap kept", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer, osn.verification);
    const preview = await post(
      app,
      "/internal/account-deletion-preview",
      { profileIds: ["usr_x"], deletesAt: 1_900_000_000 },
      `ARC ${await osnToken("account:deletion-preview")}`,
    );
    expect(await preview.json()).toEqual({ openActions: [] });

    const chat = await Effect.runPromise(seedChat({ type: "group" }).pipe(Effect.provide(layer)));
    await Effect.runPromise(seedMember(chat.id, "usr_x", "admin").pipe(Effect.provide(layer)));
    await Effect.runPromise(seedMember(chat.id, "usr_y", "member").pipe(Effect.provide(layer)));
    await Effect.runPromise(
      seedMessage(chat.id, "usr_x", "c2lwaGVy", new Date()).pipe(Effect.provide(layer)),
    );
    const erased = await post(
      app,
      "/internal/account-deleted",
      {
        accountId: "acc_x",
        profileIds: ["usr_x"],
        choices: {},
        deleteEverything: true,
      },
      `ARC ${await osnToken("account:erase")}`,
    );
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({
      kept: [
        {
          what: "Encrypted messages you sent in chats that still have other members, without your name",
          erasedOn: null,
          requestUrl: null,
        },
      ],
    });
  });
});
