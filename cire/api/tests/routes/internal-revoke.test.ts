import { describe, it, expect } from "bun:test";

import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import type { Db } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { organiserSessionService } from "../../src/services/organiser-session";
import { appRequest } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";

const SECRET = "test-internal-revoke-secret-0123456789abcdef";
const REVOKE_PATH = "/internal/revoke-organiser-sessions";

const freshDb = (): Db => {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
};

/** True when `token` still resolves to a live session in `db`. */
function isLive(db: Db, token: string): Promise<boolean> {
  return Effect.runPromise(
    organiserSessionService.validate(token).pipe(
      Effect.provideService(DbService, db),
      Effect.map(() => true),
      Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(false)),
    ),
  );
}

const post = (
  app: ReturnType<typeof createApp>,
  bearer: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  appRequest(app, REVOKE_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** A limiter whose bucket is already empty, counting what spends it. */
function exhaustedLimiter(): RateLimiterBackend & { readonly checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    check: async (key: string) => {
      checks.push(key);
      return false;
    },
  };
}

describe("POST /internal/revoke-organiser-sessions", () => {
  it("answers 503 when no revoke secret is configured — disabled, never open", async () => {
    const app = createApp(freshDb()); // no internalRevokeSecret
    const res = await post(app, SECRET, { osnProfileId: "usr_x" });
    expect(res.status).toBe(503);
  });

  it("rejects a missing bearer token", async () => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(app, null, { osnProfileId: "usr_x" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(app, "not-the-secret", { osnProfileId: "usr_x" });
    expect(res.status).toBe(401);
  });

  it("rejects a body with no osnProfileId", async () => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(app, SECRET, {});
    expect(res.status).toBe(400);
  });

  it("revokes every live session for the profile on a valid call", async () => {
    const db = freshDb();
    const browser = await seedOrganiserSession(db, "usr_target");
    const phone = await seedOrganiserSession(db, "usr_target");
    const other = await seedOrganiserSession(db, "usr_bystander");
    const app = createApp(db, { internalRevokeSecret: SECRET });

    const res = await post(app, SECRET, { osnProfileId: "usr_target" });
    expect(res.status).toBe(200);

    // Both of the target's sessions are gone…
    expect(await isLive(db, browser)).toBe(false);
    expect(await isLive(db, phone)).toBe(false);
    // …and a different organiser's session is untouched.
    expect(await isLive(db, other)).toBe(true);
  });

  it("is idempotent — a profile with no sessions still succeeds", async () => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(app, SECRET, { osnProfileId: "usr_nobody" });
    expect(res.status).toBe(200);
  });

  it("answers 503 when the configured secret is shorter than 32 characters", async () => {
    const short = SECRET.slice(0, 31);
    const app = createApp(freshDb(), { internalRevokeSecret: short });
    const res = await post(app, short, { osnProfileId: "usr_x" });
    expect(res.status).toBe(503);
  });

  it("never rate-limits a caller holding the secret", async () => {
    const db = freshDb();
    const session = await seedOrganiserSession(db, "usr_target");
    const limiter = exhaustedLimiter();
    const app = createApp(db, { internalRevokeSecret: SECRET, internalRevokeLimiter: limiter });

    const res = await post(app, SECRET, { osnProfileId: "usr_target" });

    expect(res.status).toBe(200);
    expect(limiter.checks).toEqual([]);
    expect(await isLive(db, session)).toBe(false);
  });

  it.each([
    ["a wrong secret", "not-the-secret"],
    ["no secret", null],
  ] as const)("spends the per-IP limiter on %s, and answers 429 past it", async (_, bearer) => {
    const limiter = exhaustedLimiter();
    const app = createApp(freshDb(), {
      internalRevokeSecret: SECRET,
      internalRevokeLimiter: limiter,
    });

    const res = await post(app, bearer, { osnProfileId: "usr_x" });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(limiter.checks).toHaveLength(1);
  });

  it("answers 429 to a wrong secret from an address it cannot resolve", async () => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(
      app,
      "not-the-secret",
      { osnProfileId: "usr_x" },
      { "cf-connecting-ip": "not-an-address" },
    );
    expect(res.status).toBe(429);
  });

  it.each([
    ["not a usr_ id", { osnProfileId: "acc_x" }],
    ["an empty id", { osnProfileId: "" }],
    ["the bare prefix", { osnProfileId: "usr_" }],
    ["an id over 64 characters", { osnProfileId: `usr_${"a".repeat(61)}` }],
    ["an id that is not a string", { osnProfileId: 42 }],
  ] as const)("answers 400 to a body with %s", async (_, body) => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(app, SECRET, body);
    expect(res.status).toBe(400);
  });

  it("accepts an id of exactly 64 characters", async () => {
    const app = createApp(freshDb(), { internalRevokeSecret: SECRET });
    const res = await post(app, SECRET, { osnProfileId: `usr_${"a".repeat(60)}` });
    expect(res.status).toBe(200);
  });
});
