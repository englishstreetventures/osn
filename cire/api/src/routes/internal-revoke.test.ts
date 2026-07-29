import { describe, it, expect } from "bun:test";

import { Effect } from "effect";

import { createApp } from "../app";
import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { organiserSessionService } from "../services/organiser-session";
import { appRequest } from "../test-helpers";

const SECRET = "test-internal-revoke-secret";
const REVOKE_PATH = "/internal/revoke-organiser-sessions";

const freshDb = (): Db => {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
};

/** Mints an organiser session directly against `db`, returning its raw token. */
function seedSession(db: Db, osnProfileId: string): Promise<string> {
  return Effect.runPromise(
    organiserSessionService
      .create({
        osnProfileId,
        osnSub: `pw_${osnProfileId}`,
        email: `${osnProfileId}@example.test`,
        handle: osnProfileId,
        displayName: "Organiser",
        avatarUrl: null,
      })
      .pipe(Effect.provideService(DbService, db))
      .pipe(Effect.map((s) => s.token)),
  );
}

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

const post = (app: ReturnType<typeof createApp>, bearer: string | null, body: unknown) =>
  appRequest(app, REVOKE_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

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
    const browser = await seedSession(db, "usr_target");
    const phone = await seedSession(db, "usr_target");
    const other = await seedSession(db, "usr_bystander");
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
});
