import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createAssetsStub } from "../services/invite-assets";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Local dev default owner from resolveBootstrapOwnerProfileId (OSN_ENV unset).
const BOOTSTRAP_OWNER = "usr_dev_bootstrap_owner";
const SLUG = "cire-wedding";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp(opts?: { inviteLimiter?: RateLimiterBackend }) {
  const db = createDb(":memory:");
  seedDb(db);
  const assets = createAssetsStub();
  const app = createApp(db, {
    osnTestKey: auth.key,
    assets,
    // Generous per-test limiter so the shared module default can't bleed across
    // tests; the rate-limit test below injects a tight one.
    inviteLimiter:
      opts?.inviteLimiter ?? createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { db, app, assets };
}

const emptyText = JSON.stringify({
  heroTitle: null,
  heroSubtitle: null,
  storyEyebrow: null,
  storyHeading: null,
  storyBody: null,
});

async function authHeaders(profileId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await auth.sign(profileId)}` };
}

const orgBase = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/invite`;

describe("GET /api/invite/:slug (public)", () => {
  it("returns all-null defaults for an uncustomised wedding, no auth needed", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `/api/invite/${SLUG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hero: { title: null; imageUrl: null };
      story: { heading: null };
    };
    expect(body.hero.title).toBeNull();
    expect(body.hero.imageUrl).toBeNull();
    expect(body.story.heading).toBeNull();
  });

  it("404s for an unknown slug", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, "/api/invite/no-such-wedding");
    expect(res.status).toBe(404);
  });
});

describe("PUT /invite/text (organiser)", () => {
  const payload = {
    heroTitle: "Anita & Ben",
    heroSubtitle: null,
    storyEyebrow: null,
    storyHeading: "Where it started",
    storyBody: "  ", // whitespace ⇒ cleared to default
  };

  it("401s without a token", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(401);
  });

  it("403s for a non-owner (never 401)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders("usr_someone_else")) },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
  });

  it("saves overrides for the owner and surfaces them on the public read", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify(payload),
    });
    expect(put.status).toBe(200);

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      hero: { title: string | null };
      story: { heading: string | null; body: string | null };
    };
    expect(body.hero.title).toBe("Anita & Ben");
    expect(body.story.heading).toBe("Where it started");
    // Whitespace-only body normalised back to the default (null).
    expect(body.story.body).toBeNull();
  });

  it("rejects an over-long field with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, heroTitle: "x".repeat(200) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("invite image upload + serve + remove", () => {
  it("uploads a PNG, serves it publicly, then removes it", async () => {
    const { app } = buildApp();

    const up = await appRequest(app, `${orgBase}/image/hero`, {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });
    expect(up.status).toBe(200);
    const { imageUrl } = (await up.json()) as { imageUrl: string };
    expect(imageUrl).toContain(`/api/invite/${SLUG}/image/hero`);

    // Public read now reports the hero image URL.
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as { hero: { imageUrl: string | null } };
    expect(body.hero.imageUrl).toContain("/image/hero");

    // Serving endpoint returns the bytes with the sniffed content type.
    const img = await appRequest(app, imageUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    // Remove resets the slot.
    const del = await appRequest(app, `${orgBase}/image/hero`, {
      method: "DELETE",
      headers: await authHeaders(BOOTSTRAP_OWNER),
    });
    expect(del.status).toBe(200);
    const after = await appRequest(app, `/api/invite/${SLUG}`);
    expect(((await after.json()) as { hero: { imageUrl: null } }).hero.imageUrl).toBeNull();
  });

  it("rejects a non-image body with 415", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/image/hero`, {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), // "<html"
    });
    expect(res.status).toBe(415);
  });

  it("400s for an unknown slot", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/image/footer`, {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });
    expect(res.status).toBe(400);
  });

  it("404s serving an image for a slug with none set", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `/api/invite/${SLUG}/image/story`);
    expect(res.status).toBe(404);
  });
});

describe("invite write rate limiting (IB-S-L1)", () => {
  it("429s once the per-IP limit is exceeded", async () => {
    const { app } = buildApp({
      inviteLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const put = (body: string) =>
      appRequest(app, `${orgBase}/text`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
    // No token needed — the limiter runs before auth, so a second hit from the
    // same IP is rejected with 429 regardless of credentials.
    expect((await put(emptyText)).status).not.toBe(429);
    expect((await put(emptyText)).status).toBe(429);
  });
});
