import { describe, it, expect, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  weddings,
  weddingHosts,
  weddingInviteCustomisations,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createAssetsStub } from "../services/invite-assets";
import { VARIANT_BLUR } from "../services/invite-image-transform";
import type {
  ImagesBindingLike,
  ImageTransformHandle,
  OutputFormat,
} from "../services/invite-image-transform";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Fixed local dev owner of the seeded sample wedding (DEV_OWNER_PROFILE_ID).
const BOOTSTRAP_OWNER = "usr_dev_bootstrap_owner";
const SLUG = "cire-wedding";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp(opts?: { inviteLimiter?: RateLimiterBackend; images?: ImagesBindingLike }) {
  const db = createDb(":memory:");
  seedDb(db);
  const assets = createAssetsStub();
  const app = createApp(db, {
    osnTestKey: auth.key,
    assets,
    images: opts?.images,
    // Generous per-test limiter so the shared module default can't bleed across
    // tests; the rate-limit test below injects a tight one.
    inviteLimiter:
      opts?.inviteLimiter ?? createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { db, app, assets };
}

// Distinct bytes from the uploaded PNG so a test can tell a transformed serve
// apart from the raw-original fallback.
const TRANSFORMED = new Uint8Array([0xaa, 0xbb, 0xcc]);

/** Stub Images binding. Echoes the requested format as content-type, records the
 *  transform widths, and can be made to throw to exercise the fallback path. */
function createImagesStub(opts?: { fail?: boolean }): ImagesBindingLike & {
  widths: (number | undefined)[];
  blurs: (number | undefined)[];
} {
  const widths: (number | undefined)[] = [];
  const blurs: (number | undefined)[] = [];
  return {
    widths,
    blurs,
    input() {
      const handle: ImageTransformHandle = {
        transform(t) {
          widths.push(t.width);
          blurs.push(t.blur);
          return handle;
        },
        output(o: { format: OutputFormat }) {
          if (opts?.fail) return Promise.reject(new Error("transform boom"));
          return Promise.resolve({
            response: () => new Response(TRANSFORMED, { headers: { "Content-Type": o.format } }),
            contentType: () => o.format,
          });
        },
      };
      return handle;
    },
  };
}

async function uploadHero(app: ReturnType<typeof buildApp>["app"]): Promise<void> {
  const up = await appRequest(app, `${orgBase}/image/hero`, {
    method: "POST",
    headers: await authHeaders(BOOTSTRAP_OWNER),
    body: PNG,
  });
  expect(up.status).toBe(200);
}

const emptyText = JSON.stringify({
  heroTitle: null,
  heroSubtitle: null,
  storyEyebrow: null,
  storyHeading: null,
  storyBody: null,
  inviteMessage: null,
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

  it("is served no-store so organiser edits are never masked by a cached body", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `/api/invite/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("PUT /invite/text (organiser)", () => {
  const payload = {
    heroTitle: "Anita & Ben",
    heroSubtitle: null,
    storyEyebrow: null,
    storyHeading: "Where it started",
    storyBody: "  ", // whitespace ⇒ cleared to default
    inviteMessage: null,
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

  it("persists the host's invite message and returns it on the organiser GET", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, inviteMessage: "  Come celebrate with us in Goa!  " }),
    });
    expect(put.status).toBe(200);
    // The PUT echoes the saved customisation, trimmed.
    const putBody = (await put.json()) as { inviteMessage: string | null };
    expect(putBody.inviteMessage).toBe("Come celebrate with us in Goa!");

    // And the organiser GET reflects it (the guest public read never exposes it).
    const got = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const gotBody = (await got.json()) as { inviteMessage: string | null };
    expect(gotBody.inviteMessage).toBe("Come celebrate with us in Goa!");
  });

  it("normalises a whitespace-only invite message to null", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, inviteMessage: "   \n  " }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { inviteMessage: string | null };
    expect(body.inviteMessage).toBeNull();
  });

  it("rejects an over-long invite message with 400 (cap 600)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, inviteMessage: "x".repeat(601) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("co-host invite access (weddingMember)", () => {
  const COHOST = "usr_cohost_carol";

  function seedCohost(db: ReturnType<typeof buildApp>["db"]) {
    db.insert(weddingHosts)
      .values({
        id: "whost_invite_carol",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: BOOTSTRAP_OWNER,
        createdAt: new Date(),
      })
      .run();
  }

  it("lets a co-host read the invite customisation", async () => {
    const { app, db } = buildApp();
    seedCohost(db);
    const res = await appRequest(app, orgBase, { headers: await authHeaders(COHOST) });
    expect(res.status).toBe(200);
  });

  it("lets a co-host customise the invite text (not view-only)", async () => {
    const { app, db } = buildApp();
    seedCohost(db);
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(COHOST)) },
      body: JSON.stringify({
        heroTitle: "Co-host edit",
        heroSubtitle: null,
        storyEyebrow: null,
        storyHeading: null,
        storyBody: null,
        inviteMessage: null,
      }),
    });
    expect(res.status).toBe(200);
  });

  it("still 403s a stranger on the invite read", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, orgBase, { headers: await authHeaders("usr_stranger") });
    expect(res.status).toBe(403);
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

describe("event image upload + serve + remove (migration 0019)", () => {
  // A seeded event id under the bootstrap wedding — every seeded event is scoped
  // to BOOTSTRAP_WEDDING_ID / SLUG, so this id is owned by that wedding.
  const EVENT_ID = eventsData.catholic.id;
  const eventImagePath = (eventId: string) =>
    `/api/invite/${SLUG}/event/${encodeURIComponent(eventId)}/image`;
  const orgEventImagePath = (eventId: string) =>
    `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events/${encodeURIComponent(eventId)}/image`;

  it("uploads a PNG to an event, serves it publicly, surfaces it on /events, then removes it", async () => {
    const { app } = buildApp();

    const up = await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });
    expect(up.status).toBe(200);
    const { imageUrl } = (await up.json()) as { imageUrl: string };
    expect(imageUrl).toContain(`/api/invite/${SLUG}/event/${EVENT_ID}/image`);
    // The cache version is the key-derived FNV digest, not a timestamp.
    expect(imageUrl).toMatch(/\?v=[0-9a-f]+$/);

    // The organiser events list now reports the image URL.
    const eventsRes = await appRequest(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`,
      { headers: await authHeaders(BOOTSTRAP_OWNER) },
    );
    expect(eventsRes.status).toBe(200);
    const rows = (await eventsRes.json()) as { id: string; imageUrl: string | null }[];
    const row = rows.find((e) => e.id === EVENT_ID);
    expect(row?.imageUrl).toContain(`/api/invite/${SLUG}/event/${EVENT_ID}/image`);

    // Serving endpoint returns the bytes with the sniffed content type.
    const img = await appRequest(app, imageUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    // Remove clears the event image.
    const del = await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "DELETE",
      headers: await authHeaders(BOOTSTRAP_OWNER),
    });
    expect(del.status).toBe(200);

    const after = await appRequest(app, `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`, {
      headers: await authHeaders(BOOTSTRAP_OWNER),
    });
    const afterRow = ((await after.json()) as { id: string; imageUrl: string | null }[]).find(
      (e) => e.id === EVENT_ID,
    );
    expect(afterRow?.imageUrl).toBeNull();
  });

  it("re-upload REPLACES (one image per event) and serves the new bytes", async () => {
    const { app } = buildApp();
    const PNG2 = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09, 0x08, 0x07, 0x06,
    ]);

    await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });
    const up2 = await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG2,
    });
    expect(up2.status).toBe(200);
    const { imageUrl } = (await up2.json()) as { imageUrl: string };
    const img = await appRequest(app, imageUrl);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG2);
  });

  it("404s serving an event image that has none set", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, eventImagePath(EVENT_ID));
    expect(res.status).toBe(404);
  });

  it("404s serving an image for an unknown event id", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, eventImagePath("no-such-event"));
    expect(res.status).toBe(404);
  });

  it("404s serving an event from ANOTHER wedding (ownership scoping)", async () => {
    const { app, db } = buildApp();
    // A second wedding with its own event, with an image uploaded directly.
    db.insert(weddings)
      .values({
        id: "wed_other",
        slug: "other-wedding",
        displayName: "Other",
        ownerOsnProfileId: "usr_other_owner",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    db.insert(events)
      .values({
        id: "other-event",
        weddingId: "wed_other",
        slug: "other-event-slug",
        name: "Other Event",
        startAt: "2026-01-01T00:00:00Z",
        endAt: "2026-01-01T01:00:00Z",
        timezone: "UTC",
        eventImageKey: "assets/wed_other/event-deadbeef",
      })
      .run();

    // Requesting the other wedding's event id under THIS slug must 404 — the
    // join scopes the event id to the slug's wedding, so it matches no row.
    const res = await appRequest(app, eventImagePath("other-event"));
    expect(res.status).toBe(404);
  });

  it("rejects uploading to an event from ANOTHER wedding with 404 (ownership)", async () => {
    const { app, db } = buildApp();
    db.insert(weddings)
      .values({
        id: "wed_other2",
        slug: "other-wedding-2",
        displayName: "Other 2",
        ownerOsnProfileId: "usr_other_owner2",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    db.insert(events)
      .values({
        id: "other-event-2",
        weddingId: "wed_other2",
        slug: "other-event-2-slug",
        name: "Other Event 2",
        startAt: "2026-01-01T00:00:00Z",
        endAt: "2026-01-01T01:00:00Z",
        timezone: "UTC",
      })
      .run();

    // The bootstrap owner tries to upload onto wed_other2's event via the
    // bootstrap wedding's organiser path — the service's event∈wedding check
    // rejects it (EventNotFound → 404), and nothing is written.
    const res = await appRequest(app, orgEventImagePath("other-event-2"), {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });
    expect(res.status).toBe(404);
  });

  it("rejects a non-image event upload with 415", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), // "<html"
    });
    expect(res.status).toBe(415);
  });

  it("rejects an oversize event upload with 413 (declared Content-Length)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "POST",
      headers: {
        ...(await authHeaders(BOOTSTRAP_OWNER)),
        "content-length": String(6 * 1024 * 1024),
      },
      body: PNG,
    });
    expect(res.status).toBe(413);
  });

  it("401s an event upload without a token", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, orgEventImagePath(EVENT_ID), { method: "POST", body: PNG });
    expect(res.status).toBe(401);
  });

  it("403s an event upload for a non-member (never 401)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, orgEventImagePath(EVENT_ID), {
      method: "POST",
      headers: await authHeaders("usr_someone_else"),
      body: PNG,
    });
    expect(res.status).toBe(403);
  });
});

describe("invite image transforms (Cloudflare Images)", () => {
  it("falls back to the original bytes when no IMAGES binding is present", async () => {
    // No `images` ⇒ the serve route serves the raw R2 original (today's
    // behaviour), unchanged — the critical local-dev / test path.
    const app = buildApp().app;
    await uploadHero(app);
    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  it("serves a transformed variant when the IMAGES binding is present", async () => {
    const images = createImagesStub();
    const app = buildApp({ images }).app;
    await uploadHero(app);

    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
      headers: { accept: "image/avif,image/webp,*/*" },
    });
    expect(img.status).toBe(200);
    // AVIF negotiated from Accept; transformed bytes (not the original PNG).
    expect(img.headers.get("content-type")).toBe("image/avif");
    expect(img.headers.get("vary")).toBe("Accept");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(TRANSFORMED);
    // `hero` variant ⇒ 1600px render width, served SHARP (no blur).
    expect(images.widths).toEqual([1600]);
    expect(images.blurs).toEqual([undefined]);
  });

  it("blurs the hero-bg backdrop variant (server-side radius, never client input)", async () => {
    const images = createImagesStub();
    const app = buildApp({ images }).app;
    await uploadHero(app);

    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero-bg`, {
      headers: { accept: "image/webp,*/*" },
    });
    expect(img.status).toBe(200);
    // hero-bg ⇒ hero width (1600) WITH the server-chosen blur radius applied.
    expect(images.widths).toEqual([1600]);
    expect(images.blurs).toEqual([VARIANT_BLUR["hero-bg"]]);
    expect(images.blurs[0]).toBeGreaterThan(0);
  });

  it("negotiates WebP when AVIF is not advertised", async () => {
    const images = createImagesStub();
    const app = buildApp({ images }).app;
    await uploadHero(app);

    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero`, {
      headers: { accept: "image/webp,*/*" },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/webp");
    // No ?variant ⇒ default `card` (800px).
    expect(images.widths).toEqual([800]);
  });

  it("falls back to the original (never 500s) when a transform fails", async () => {
    const images = createImagesStub({ fail: true });
    const app = buildApp({ images }).app;
    await uploadHero(app);

    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=card`, {
      headers: { accept: "image/avif,*/*" },
    });
    expect(img.status).toBe(200);
    // Transform threw ⇒ raw R2 original, with its stored content-type.
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });
});

// ── Cache API short-circuit (Worker edge cache) ──────────────────────────────

/** Map-backed `caches.default` stub. Records put/match calls so a test can assert
 *  the binding only ran on a miss. Matches by the cache key's URL (what the real
 *  Cache API keys on). */
function createCacheStub() {
  const store = new Map<string, Response>();
  const calls = { match: 0, put: 0 };
  const def = {
    async match(req: Request | string): Promise<Response | undefined> {
      calls.match += 1;
      const url = typeof req === "string" ? req : req.url;
      const hit = store.get(url);
      return hit ? hit.clone() : undefined;
    },
    async put(req: Request | string, res: Response): Promise<void> {
      calls.put += 1;
      const url = typeof req === "string" ? req : req.url;
      store.set(url, res);
    },
  };
  return { calls, store, caches: { default: def } as unknown as CacheStorage };
}

/** Install a stub `globalThis.caches` for the duration of `fn`, restoring after. */
async function withCaches<T>(stub: CacheStorage, fn: () => Promise<T>): Promise<T> {
  const original = (globalThis as { caches?: CacheStorage }).caches;
  (globalThis as { caches?: CacheStorage }).caches = stub;
  try {
    return await fn();
  } finally {
    (globalThis as { caches?: CacheStorage }).caches = original;
  }
}

describe("invite image transforms — Cache API short-circuit", () => {
  it("caches the first transform, then serves the second request from cache without re-invoking the binding", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const app = buildApp({ images }).app;
      await uploadHero(app);

      const accept = { accept: "image/avif,image/webp,*/*" };

      // First request → miss → binding runs once + result cached.
      const first = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("image/avif");
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(TRANSFORMED);
      expect(images.widths).toEqual([1600]); // binding called once
      expect(cache.calls.put).toBe(1); // cached on miss

      // Second identical request → hit → served from cache, binding NOT called again.
      const second = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
        headers: accept,
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("content-type")).toBe("image/avif");
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(TRANSFORMED);
      expect(images.widths).toEqual([1600]); // still one call — no re-invocation
      expect(cache.calls.put).toBe(1); // no second write
    });
  });

  it("keys a different variant separately (binding called again, new cache entry)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const app = buildApp({ images }).app;
      await uploadHero(app);

      await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`);
      await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=thumb`);

      // Two distinct variants ⇒ two binding invocations + two cache entries.
      expect(images.widths).toEqual([1600, 320]);
      expect(cache.store.size).toBe(2);
    });
  });

  it("keys a different negotiated format separately (AVIF vs WebP cached apart)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const app = buildApp({ images }).app;
      await uploadHero(app);

      const avif = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=card`, {
        headers: { accept: "image/avif,*/*" },
      });
      const webp = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=card`, {
        headers: { accept: "image/webp,*/*" },
      });

      expect(avif.headers.get("content-type")).toBe("image/avif");
      expect(webp.headers.get("content-type")).toBe("image/webp");
      // Same variant, different format ⇒ two binding calls + two cache entries.
      expect(images.widths.length).toBe(2);
      expect(cache.store.size).toBe(2);

      // A WebP-only client must NOT get the AVIF entry: repeat WebP hits cache,
      // binding count unchanged.
      const webp2 = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=card`, {
        headers: { accept: "image/webp,*/*" },
      });
      expect(webp2.headers.get("content-type")).toBe("image/webp");
      expect(images.widths.length).toBe(2);
    });
  });

  it("a re-upload (bumped updatedAt) creates a second cache entry and re-runs the binding (T-S1)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const built = buildApp({ images });
      const app = built.app;
      await uploadHero(app);

      const accept = { accept: "image/avif,image/webp,*/*" };

      // First request → miss → binding runs once, one cache entry written under
      // the current server `updatedAt`.
      const first = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(images.widths).toEqual([1600]); // binding ran once
      expect(cache.store.size).toBe(1);

      // Simulate a re-upload by advancing the wedding's stored `updatedAt`. After
      // the S-M1 fix the cache version is derived from this DB value (NOT the
      // client ?v=), so a bump must mint a fresh key — the new image can't be
      // served the stale cached transform.
      built.db
        .update(weddingInviteCustomisations)
        .set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(weddingInviteCustomisations.weddingId, BOOTSTRAP_WEDDING_ID))
        .run();

      // Same request URL (same ?variant, same Accept) → because the server
      // version changed, this is a MISS against a new key → binding re-runs and a
      // SECOND cache entry is created.
      const second = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
        headers: accept,
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("content-type")).toBe("image/avif");
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(TRANSFORMED);
      expect(images.widths).toEqual([1600, 1600]); // binding ran a second time
      expect(cache.store.size).toBe(2); // new version ⇒ distinct cache entry
    });
  });

  it("ignores the client ?v= for cache keying — looping ?v= does NOT re-bill transforms (S-M1)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const app = buildApp({ images }).app;
      await uploadHero(app);

      const accept = { accept: "image/avif,image/webp,*/*" };

      // First request primes the cache (server-derived version).
      const first = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero&v=1`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(images.widths).toEqual([1600]);
      expect(cache.store.size).toBe(1);

      // An attacker loops distinct ?v= values on the same valid slug. The cache
      // is already primed (above), so each MUST hit the SAME server-derived entry
      // — the binding never re-runs and no new entries are minted, so the
      // per-(slug,slot,variant,format) live transform count stays at exactly 1.
      const responses = await Promise.all(
        [2, 3, 4, 5].map((v) =>
          appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero&v=${v}`, {
            headers: accept,
          }),
        ),
      );
      const bodies = await Promise.all(responses.map((r) => r.arrayBuffer()));
      for (const res of responses) expect(res.status).toBe(200);
      for (const body of bodies) expect(new Uint8Array(body)).toEqual(TRANSFORMED);
      expect(images.widths).toEqual([1600]); // still exactly one transform
      expect(cache.store.size).toBe(1); // no extra cache entries
    });
  });

  it("serves correctly via the binding when the Cache API is absent (no caches global)", async () => {
    // No stub installed ⇒ `caches` is undefined in this runtime; the route must
    // still serve the transform (just without caching).
    const images = createImagesStub();
    const app = buildApp({ images }).app;
    await uploadHero(app);

    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
      headers: { accept: "image/avif,*/*" },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/avif");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(TRANSFORMED);
    expect(images.widths).toEqual([1600]);
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

describe("PUT /invite/theme (organiser)", () => {
  const validTheme = {
    headingFont: "cormorant",
    bodyFont: "system-sans",
    heroAccentColor: "#d4af37",
    heroSurfaceColor: "oklch(22.7% 0.0275 152.78)",
    storyAccentColor: null,
    storySurfaceColor: null,
    detailsAccentColor: "rgb(212, 175, 55)",
    detailsSurfaceColor: null,
    heroBlur: 28,
    titleBackdropOpacity: 0,
    titleBackdropBlur: 0,
  };

  it("401s without a token", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTheme),
    });
    expect(res.status).toBe(401);
  });

  it("403s for a non-owner (never 401)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders("usr_someone_else")) },
      body: JSON.stringify(validTheme),
    });
    expect(res.status).toBe(403);
  });

  it("persists the theme for the owner and surfaces it on the public read", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify(validTheme),
    });
    expect(put.status).toBe(200);

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      theme: {
        headingFont: string | null;
        bodyFont: string | null;
        hero: { accentColor: string | null; surfaceColor: string | null };
        story: { accentColor: string | null; surfaceColor: string | null };
        details: { accentColor: string | null; surfaceColor: string | null };
      };
    };
    expect(body.theme.headingFont).toBe("cormorant");
    expect(body.theme.bodyFont).toBe("system-sans");
    expect(body.theme.hero.accentColor).toBe("#d4af37");
    expect(body.theme.hero.surfaceColor).toBe("oklch(22.7% 0.0275 152.78)");
    expect(body.theme.story.accentColor).toBeNull();
    expect(body.theme.details.accentColor).toBe("rgb(212, 175, 55)");
  });

  it("defaults to a null theme when never customised", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      theme: {
        headingFont: string | null;
        hero: { accentColor: string | null; surfaceColor: string | null };
      };
    };
    expect(body.theme.headingFont).toBeNull();
    expect(body.theme.hero.accentColor).toBeNull();
    expect(body.theme.hero.surfaceColor).toBeNull();
  });

  it("rejects a colour outside the allow-list with 400 (CSS-injection guard)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...validTheme,
        // url() would be a CSS-injection / exfil vector if it ever reached a style.
        heroAccentColor: "red; background:url(https://evil.example/x)",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a named colour (not in the allow-list) with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, heroSurfaceColor: "rebeccapurple" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown font with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, headingFont: "comic-sans-from-a-cdn" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body missing a field with 400 (total replace, not partial merge)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      // Omits detailsSurfaceColor — the body is total, so this must be a 400, not
      // a partial update (guards against an accidental Schema.optional refactor).
      body: JSON.stringify({
        headingFont: "default",
        bodyFont: "default",
        heroAccentColor: null,
        heroSurfaceColor: null,
        storyAccentColor: null,
        storySurfaceColor: null,
        detailsAccentColor: null,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an over-long colour past the 64-char cap with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      // Pattern-shaped (rgb(...)) but 64+ chars — exercises the length guard, not
      // just the character allow-list.
      body: JSON.stringify({
        ...validTheme,
        heroAccentColor: `rgb(${" ".repeat(80)}0, 0, 0)`,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("does not persist a partially-valid body (one bad colour rejects the whole write)", async () => {
    const { app } = buildApp();
    const bad = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, storySurfaceColor: "javascript:alert(1)" }),
    });
    expect(bad.status).toBe(400);

    // The valid fields in the same body must NOT have leaked through.
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as { theme: { headingFont: string | null } };
    expect(body.theme.headingFont).toBeNull();
  });
});

describe("hero display sliders (migration 0018)", () => {
  const validTheme = {
    headingFont: "default",
    bodyFont: "default",
    heroAccentColor: null,
    heroSurfaceColor: null,
    storyAccentColor: null,
    storySurfaceColor: null,
    detailsAccentColor: null,
    detailsSurfaceColor: null,
    heroBlur: 28,
    titleBackdropOpacity: 0,
    titleBackdropBlur: 0,
  };

  it("defaults to blur 28 / backdrop 0,0 on a never-customised wedding", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      heroDisplay: { blur: number; titleBackdrop: { opacity: number; blur: number } };
    };
    expect(body.heroDisplay.blur).toBe(28);
    expect(body.heroDisplay.titleBackdrop.opacity).toBe(0);
    expect(body.heroDisplay.titleBackdrop.blur).toBe(0);
  });

  it("persists the three slider values and surfaces them on the public read", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...validTheme,
        heroBlur: 12,
        titleBackdropOpacity: 60,
        titleBackdropBlur: 8,
      }),
    });
    expect(put.status).toBe(200);

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      heroDisplay: { blur: number; titleBackdrop: { opacity: number; blur: number } };
    };
    expect(body.heroDisplay.blur).toBe(12);
    expect(body.heroDisplay.titleBackdrop.opacity).toBe(60);
    expect(body.heroDisplay.titleBackdrop.blur).toBe(8);
  });

  it("echoes the saved hero display back on the organiser theme PUT response", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...validTheme,
        heroBlur: 0,
        titleBackdropOpacity: 100,
        titleBackdropBlur: 20,
      }),
    });
    const body = (await put.json()) as {
      heroDisplay: { blur: number; titleBackdrop: { opacity: number; blur: number } };
    };
    expect(body.heroDisplay.blur).toBe(0);
    expect(body.heroDisplay.titleBackdrop.opacity).toBe(100);
    expect(body.heroDisplay.titleBackdrop.blur).toBe(20);
  });

  it("clamps an out-of-range slider into its bounds (no 400, no abuse)", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      // Over the max on every slider — each is clamped, not rejected.
      body: JSON.stringify({
        ...validTheme,
        heroBlur: 999,
        titleBackdropOpacity: 250,
        titleBackdropBlur: -5,
      }),
    });
    expect(put.status).toBe(200);

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      heroDisplay: { blur: number; titleBackdrop: { opacity: number; blur: number } };
    };
    expect(body.heroDisplay.blur).toBe(40); // clamped to HERO_BLUR_MAX
    expect(body.heroDisplay.titleBackdrop.opacity).toBe(100); // clamped to 100
    expect(body.heroDisplay.titleBackdrop.blur).toBe(0); // clamped up to 0
  });

  it("rejects a non-integer slider with 400 (ParseError)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, heroBlur: "lots" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body missing heroBlur with 400 (total body)", async () => {
    const { app } = buildApp();
    const { heroBlur: _omit, ...withoutBlur } = validTheme;
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify(withoutBlur),
    });
    expect(res.status).toBe(400);
  });

  it("serving the hero-bg backdrop applies the STORED per-wedding blur, not the default (T-0018)", async () => {
    const images = createImagesStub();
    const { app } = buildApp({ images });
    await uploadHero(app);

    // Set a non-default per-wedding blur.
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, heroBlur: 7 }),
    });
    expect(put.status).toBe(200);

    const img = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero-bg`, {
      headers: { accept: "image/webp,*/*" },
    });
    expect(img.status).toBe(200);
    // hero-bg ⇒ 1600px width WITH the stored blur (7), not VARIANT_BLUR default.
    expect(images.widths).toEqual([1600]);
    expect(images.blurs).toEqual([7]);
  });

  it("a blur change busts the served hero-bg cache (re-runs the binding, new entry)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const { app } = buildApp({ images });
      await uploadHero(app);
      const accept = { accept: "image/webp,*/*" };

      // Prime the cache at the default blur.
      const first = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero-bg`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(images.blurs).toEqual([VARIANT_BLUR["hero-bg"]]);
      expect(cache.store.size).toBe(1);

      // Change the blur (bumps updatedAt AND adds blur to the key) → MISS.
      const put = await appRequest(app, `${orgBase}/theme`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ ...validTheme, heroBlur: 5 }),
      });
      expect(put.status).toBe(200);

      const second = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero-bg`, {
        headers: accept,
      });
      expect(second.status).toBe(200);
      // Binding re-ran with the new blur; a distinct cache entry was minted.
      expect(images.blurs).toEqual([VARIANT_BLUR["hero-bg"], 5]);
      expect(cache.store.size).toBe(2);
    });
  });
});

describe("image crop (migration 0021)", () => {
  const EVENT_ID = eventsData.catholic.id;
  const orgEventImagePath = (eventId: string) =>
    `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events/${encodeURIComponent(eventId)}/image`;
  const VALID_CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };

  describe("wedding-slot crop (hero / story)", () => {
    it("saves a crop and surfaces it on the public read + organiser read", async () => {
      const { app } = buildApp();
      await uploadHero(app);

      const put = await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP }),
      });
      expect(put.status).toBe(200);

      // Public guest read carries the crop.
      const pub = await appRequest(app, `/api/invite/${SLUG}`);
      const body = (await pub.json()) as { hero: { imageCrop: typeof VALID_CROP | null } };
      expect(body.hero.imageCrop).toEqual(VALID_CROP);

      // Organiser read (so the builder re-opens the saved crop) carries it too.
      const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
      const orgBody = (await org.json()) as { hero: { imageCrop: typeof VALID_CROP | null } };
      expect(orgBody.hero.imageCrop).toEqual(VALID_CROP);
    });

    it("round-trips the captured source dims (natW/natH) — the distortion fix, no migration", async () => {
      const { app } = buildApp();
      await uploadHero(app);

      // The crop columns are plain JSON TEXT, so the widened shape persists without
      // a schema change. The guest needs natW/natH to render the crop at its true
      // pixel aspect (uniform, never stretched).
      const cropWithDims = { x: 0.1, y: 0.2, w: 0.5, h: 0.4, natW: 4000, natH: 3000 };
      const put = await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: cropWithDims }),
      });
      expect(put.status).toBe(200);

      const pub = await appRequest(app, `/api/invite/${SLUG}`);
      const body = (await pub.json()) as { hero: { imageCrop: typeof cropWithDims | null } };
      expect(body.hero.imageCrop).toEqual(cropWithDims);
    });

    it("rejects an out-of-range crop with 400 and never persists it", async () => {
      const { app } = buildApp();
      await uploadHero(app);

      const bad = await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: { x: 0.8, y: 0, w: 0.5, h: 0.5 } }), // x+w = 1.3
      });
      expect(bad.status).toBe(400);

      const pub = await appRequest(app, `/api/invite/${SLUG}`);
      const body = (await pub.json()) as { hero: { imageCrop: unknown } };
      expect(body.hero.imageCrop).toBeNull();
    });

    it("crop: null resets to the default centre crop", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP }),
      });
      const reset = await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: null }),
      });
      expect(reset.status).toBe(200);
      const pub = await appRequest(app, `/api/invite/${SLUG}`);
      const body = (await pub.json()) as { hero: { imageCrop: unknown } };
      expect(body.hero.imageCrop).toBeNull();
    });

    it("a crop change surfaces immediately on the no-store invite JSON (cache-bust on the guest)", async () => {
      const { app } = buildApp();
      await uploadHero(app);

      // The invite JSON is served `no-store` (asserted elsewhere), so the guest's
      // on-mount revalidation always re-reads it — a crop edit is reflected on the
      // very next read with no stale cache. (Under the CSS-render path the served
      // image BYTES never change with a crop, so there is no image-bytes cache to
      // bust; the crop travels in this always-fresh JSON.)
      const before = await appRequest(app, `/api/invite/${SLUG}`);
      expect(((await before.json()) as { hero: { imageCrop: unknown } }).hero.imageCrop).toBeNull();

      await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP }),
      });

      const after = await appRequest(app, `/api/invite/${SLUG}`);
      expect(after.headers.get("cache-control")).toBe("no-store");
      expect(((await after.json()) as { hero: { imageCrop: unknown } }).hero.imageCrop).toEqual(
        VALID_CROP,
      );
    });

    it("re-uploading an image clears the previous crop", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      await appRequest(app, `${orgBase}/image/hero/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP }),
      });
      // A fresh upload frames a different photo → crop resets to full.
      await uploadHero(app);
      const pub = await appRequest(app, `/api/invite/${SLUG}`);
      const body = (await pub.json()) as { hero: { imageCrop: unknown } };
      expect(body.hero.imageCrop).toBeNull();
    });

    it("does not surface a crop when the slot has no image", async () => {
      const { app } = buildApp();
      // No image uploaded — even a stored crop would be inert; the read is null.
      const pub = await appRequest(app, `/api/invite/${SLUG}`);
      const body = (await pub.json()) as { hero: { imageCrop: unknown; imageUrl: unknown } };
      expect(body.hero.imageUrl).toBeNull();
      expect(body.hero.imageCrop).toBeNull();
    });
  });

  describe("event crop", () => {
    async function uploadEvent(app: ReturnType<typeof buildApp>["app"]) {
      const up = await appRequest(app, orgEventImagePath(EVENT_ID), {
        method: "POST",
        headers: await authHeaders(BOOTSTRAP_OWNER),
        body: PNG,
      });
      expect(up.status).toBe(200);
    }

    it("saves a crop and surfaces it on /events + on the guest claim", async () => {
      const { app } = buildApp();
      await uploadEvent(app);

      const put = await appRequest(app, `${orgEventImagePath(EVENT_ID)}/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP }),
      });
      expect(put.status).toBe(200);

      const eventsRes = await appRequest(
        app,
        `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`,
        { headers: await authHeaders(BOOTSTRAP_OWNER) },
      );
      const rows = (await eventsRes.json()) as {
        id: string;
        imageCrop: typeof VALID_CROP | null;
      }[];
      expect(rows.find((e) => e.id === EVENT_ID)?.imageCrop).toEqual(VALID_CROP);
    });

    it("rejects an out-of-range event crop with 400", async () => {
      const { app } = buildApp();
      await uploadEvent(app);
      const bad = await appRequest(app, `${orgEventImagePath(EVENT_ID)}/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: { x: 0, y: 0, w: 0, h: 0 } }),
      });
      expect(bad.status).toBe(400);
    });

    it("404s saving a crop for an event in ANOTHER wedding (ownership scoping)", async () => {
      const { app, db } = buildApp();
      db.insert(weddings)
        .values({
          id: "wed_other",
          slug: "other-wedding",
          displayName: "Other",
          ownerOsnProfileId: "usr_other_owner",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      db.insert(events)
        .values({
          id: "other-event",
          weddingId: "wed_other",
          slug: "other-event-slug",
          name: "Other Event",
          startAt: "2026-01-01T00:00:00Z",
          endAt: "2026-01-01T01:00:00Z",
          timezone: "UTC",
          eventImageKey: "assets/wed_other/event-deadbeef",
        })
        .run();

      // The owner of the bootstrap wedding can't crop another wedding's event.
      const res = await appRequest(
        app,
        `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events/other-event/image/crop`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
          body: JSON.stringify({ crop: VALID_CROP }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("clears the event crop on re-upload", async () => {
      const { app } = buildApp();
      await uploadEvent(app);
      await appRequest(app, `${orgEventImagePath(EVENT_ID)}/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP }),
      });
      await uploadEvent(app);
      const eventsRes = await appRequest(
        app,
        `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/events`,
        { headers: await authHeaders(BOOTSTRAP_OWNER) },
      );
      const rows = (await eventsRes.json()) as { id: string; imageCrop: unknown }[];
      expect(rows.find((e) => e.id === EVENT_ID)?.imageCrop).toBeNull();
    });
  });
});
