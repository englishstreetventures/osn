import { eventRsvps } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { Effect } from "effect";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

import { _resetServiceKeysForTests } from "../../src/lib/arc-middleware";
import { createInternalRoutes } from "../../src/routes/internal";
import { createTestLayer, seedCloseFriend, seedEvent } from "../helpers/db";

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

const seedRsvp = (
  eventId: string,
  profileId: string,
  extra: { status?: "going" | "maybe" | "not_going" | "invited"; shareSourceFirst?: string } = {},
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(eventRsvps).values({
        id: "rsvp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        eventId,
        profileId,
        status: extra.status ?? "going",
        shareSourceFirst: extra.shareSourceFirst ?? null,
        createdAt: new Date(),
      }),
    );
  });

describe("internal routes — ARC-gated account-export", () => {
  async function registerExportKey(app: ReturnType<typeof createInternalRoutes>) {
    const reg = await post(
      app,
      "/internal/register-service",
      { ...registerBody(), allowedScopes: "account:export" },
      `Bearer ${SECRET}`,
    );
    expect(reg.status).toBe(200);
  }

  function exportToken(scope: string) {
    return signArcToken(privateKey, { iss: "osn-api", aud: "pulse-api", scope, kid: KID });
  }

  it("returns 401 without an ARC token", async () => {
    const res = await post(createInternalRoutes(createTestLayer()), "/internal/account-export", {
      account_id: "acc_x",
      profile_ids: ["usr_x"],
    });
    expect(res.status).toBe(401);
  });

  it("rejects an ARC token with the wrong scope", async () => {
    const app = createInternalRoutes(createTestLayer());
    await post(
      app,
      "/internal/register-service",
      { ...registerBody(), allowedScopes: "account:erase" },
      `Bearer ${SECRET}`,
    );
    const arc = await exportToken("account:erase");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_x", profile_ids: ["usr_x"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(401);
  });

  it("streams NDJSON lines for seeded rsvps / events / close-friends", async () => {
    const layer = createTestLayer();
    const app = createInternalRoutes(layer);
    await registerExportKey(app);

    const event = await Effect.runPromise(
      seedEvent({
        title: "Rooftop Session",
        startTime: "2030-06-01T10:00:00.000Z",
        createdByProfileId: "usr_export",
      }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      seedRsvp(event.id, "usr_export", { shareSourceFirst: "instagram" }).pipe(
        Effect.provide(layer),
      ),
    );
    await Effect.runPromise(
      seedCloseFriend("usr_export", "usr_friend").pipe(Effect.provide(layer)),
    );

    const arc = await exportToken("account:export");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_export", profile_ids: ["usr_export"] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const sections = lines.map((l) => l.section);
    expect(sections).toContain("pulse.rsvps");
    expect(sections).toContain("pulse.events_hosted");
    expect(sections).toContain("pulse.close_friends");

    const rsvp = lines.find((l) => l.section === "pulse.rsvps");
    expect(rsvp.record.eventId).toBe(event.id);
    expect(rsvp.record.shareSourceFirst).toBe("instagram");

    const hosted = lines.find((l) => l.section === "pulse.events_hosted");
    expect(hosted.record.id).toBe(event.id);
    expect(hosted.record.title).toBe("Rooftop Session");

    const cf = lines.find((l) => l.section === "pulse.close_friends");
    expect(cf.record.friendId).toBe("usr_friend");
  });

  it("returns 200 with an empty body when profile_ids is empty", async () => {
    const app = createInternalRoutes(createTestLayer());
    await registerExportKey(app);
    const arc = await exportToken("account:export");
    const res = await post(
      app,
      "/internal/account-export",
      { account_id: "acc_none", profile_ids: [] },
      `ARC ${arc}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
