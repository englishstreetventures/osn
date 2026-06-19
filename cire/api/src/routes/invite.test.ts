import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingHosts, weddingInviteCustomisations } from "@cire/db";
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
    heroImageStyle: "blurred",
    heroTitleBackdrop: "none",
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

describe("hero display options", () => {
  const validTheme = {
    headingFont: "default",
    bodyFont: "default",
    heroAccentColor: null,
    heroSurfaceColor: null,
    storyAccentColor: null,
    storySurfaceColor: null,
    detailsAccentColor: null,
    detailsSurfaceColor: null,
    heroImageStyle: "blurred",
    heroTitleBackdrop: "none",
  };

  it("defaults to blurred / none on a never-customised wedding", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      heroDisplay: { imageStyle: string; titleBackdrop: string };
    };
    expect(body.heroDisplay.imageStyle).toBe("blurred");
    expect(body.heroDisplay.titleBackdrop).toBe("none");
  });

  it("persists regular / solid and surfaces them on the public read", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...validTheme,
        heroImageStyle: "regular",
        heroTitleBackdrop: "solid",
      }),
    });
    expect(put.status).toBe(200);

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      heroDisplay: { imageStyle: string; titleBackdrop: string };
    };
    expect(body.heroDisplay.imageStyle).toBe("regular");
    expect(body.heroDisplay.titleBackdrop).toBe("solid");
  });

  it("echoes the saved hero display back on the organiser theme PUT response", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...validTheme,
        heroImageStyle: "regular",
        heroTitleBackdrop: "solid",
      }),
    });
    const body = (await put.json()) as {
      heroDisplay: { imageStyle: string; titleBackdrop: string };
    };
    expect(body.heroDisplay.imageStyle).toBe("regular");
    expect(body.heroDisplay.titleBackdrop).toBe("solid");
  });

  it("rejects an unknown hero image style with 400 (closed enum)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, heroImageStyle: "sepia" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown title backdrop with 400 (closed enum)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, heroTitleBackdrop: "frosted" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body missing heroImageStyle with 400 (total body)", async () => {
    const { app } = buildApp();
    const { heroImageStyle: _omit, ...withoutStyle } = validTheme;
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify(withoutStyle),
    });
    expect(res.status).toBe(400);
  });
});
