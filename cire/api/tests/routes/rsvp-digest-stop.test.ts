import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, hostRsvpNotices, weddingHosts } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { deriveDigestStopKey, signDigestStopToken } from "../../src/lib/digest-stop";
import { TEST_CF_IP } from "../test-helpers";

const SECRET = "test-oidc-client-secret";
const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

function build(options: { secret?: string | null } = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [osnProfileId, role] of [
    [EDITOR, "editor"],
    [VIEWER, "viewer"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${role}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  const app = createApp(db, {
    // A non-empty allowlist, so the CSRF origin guard is live for this app.
    allowedOrigins: ["https://cireweddings.test"],
    digestStopSecret: options.secret === undefined ? SECRET : options.secret,
    digestStopLimiter: createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 }),
  });
  return { db, app };
}

async function tokenFor(osnProfileId: string, secret = SECRET): Promise<string> {
  const key = await deriveDigestStopKey(secret);
  return signDigestStopToken(key, { weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId });
}

function call(
  app: ReturnType<typeof build>["app"],
  method: "GET" | "POST",
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = `http://localhost/api/rsvp-digest/stop?t=${encodeURIComponent(token)}`;
  const allHeaders = { "cf-connecting-ip": TEST_CF_IP, ...headers };
  return Promise.resolve(
    app.fetch(
      method === "GET"
        ? new Request(url, { headers: allHeaders })
        : new Request(url, {
            method: "POST",
            headers: allHeaders,
            body: "List-Unsubscribe=One-Click",
          }),
    ),
  );
}

function digestSetting(db: TestDb, osnProfileId: string) {
  return db
    .select({ enabled: hostRsvpNotices.digestEnabled })
    .from(hostRsvpNotices)
    .where(
      and(
        eq(hostRsvpNotices.weddingId, BOOTSTRAP_WEDDING_ID),
        eq(hostRsvpNotices.osnProfileId, osnProfileId),
      ),
    )
    .get();
}

describe("GET /api/rsvp-digest/stop", () => {
  it("asks to confirm and changes nothing — link scanners fetch every link", async () => {
    const { db, app } = build();
    const res = await call(app, "GET", await tokenFor(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    const body = await res.text();
    expect(body).toContain('<form method="post">');
    expect(digestSetting(db, OWNER)).toBeUndefined();
  });

  it("answers 400 for a token signed with another secret", async () => {
    const { app } = build();
    const res = await call(app, "GET", await tokenFor(OWNER, "another-secret"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not recognised");
  });
});

describe("POST /api/rsvp-digest/stop", () => {
  it.each([
    ["the owner", OWNER],
    ["an editor co-host", EDITOR],
  ])("turns the digest off for %s", async (_label, who) => {
    const { db, app } = build();
    const res = await call(app, "POST", await tokenFor(who), {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not get the daily RSVP summary");
    expect(digestSetting(db, who)?.enabled).toBe(false);
  });

  it.each([
    ["a viewer, who is never mailed", VIEWER],
    ["someone with no seat", STRANGER],
  ])("writes nothing for %s, and answers as if it did", async (_label, who) => {
    const { db, app } = build();
    const res = await call(app, "POST", await tokenFor(who));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not get the daily RSVP summary");
    expect(digestSetting(db, who)).toBeUndefined();
  });

  it("is reached with no Origin or a foreign one while the origin guard is live", async () => {
    // A mail provider's one-click POST has no Origin; the confirm page's form
    // posts from the API's own origin, which is not a portal origin.
    const { db, app } = build();
    const token = await tokenFor(OWNER);
    expect((await call(app, "POST", token)).status).toBe(200);
    expect((await call(app, "POST", token, { Origin: "https://api.cire.test" })).status).toBe(200);
    expect(digestSetting(db, OWNER)?.enabled).toBe(false);
  });

  it("refuses a bad token before touching anything", async () => {
    const { db, app } = build();
    const res = await call(app, "POST", "not-a-token");
    expect(res.status).toBe(400);
    expect(digestSetting(db, OWNER)).toBeUndefined();
  });

  it("answers 503 when stop links are off", async () => {
    const { db, app } = build({ secret: null });
    const res = await call(app, "POST", await tokenFor(OWNER));
    expect(res.status).toBe(503);
    expect(digestSetting(db, OWNER)).toBeUndefined();
  });
});
