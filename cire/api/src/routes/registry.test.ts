import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingEntitlements, weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createAssetsStub, MAX_IMAGE_BYTES } from "../services/invite-assets";
import type { LinkPreviewOptions } from "../services/link-preview";
import type { RegistryItemDto, RegistrySnapshot } from "../services/registry";
import { appRequest, jsonBody } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/**
 * `grantRegistry` defaults to FALSE — the opposite of the other module tests, and
 * deliberately so. Shipping locked is the headline property of this feature, so
 * the default fixture is the production one (no grant anywhere), and a test that
 * wants the feature has to say so.
 */
function buildApp({
  grantRegistry = false,
  linkPreview,
  assets,
}: {
  grantRegistry?: boolean;
  linkPreview?: LinkPreviewOptions;
  assets?: ReturnType<typeof createAssetsStub>;
} = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_viewer",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  if (grantRegistry) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "registry",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
  }

  return createApp(db, {
    osnTestKey: auth.key,
    // A FRESH limiter per app. The module-level default is shared process-wide,
    // so without this the tenth preview request in this file would 429 whichever
    // test happened to run last.
    registryPreviewLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    registryImageLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    registryLinkPreviewOptions: linkPreview,
    assets,
  });
}
type App = ReturnType<typeof buildApp>;

async function req(
  app: App,
  method: string,
  path: string,
  profileId: string | undefined,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry`;
const ITEM = { title: "Copper pan", priceMinor: 12_000, quantityWanted: 2 };

/** Create one item on an entitled app and return it. */
async function seedItem(app: App): Promise<RegistryItemDto> {
  const res = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
  expect(res.status).toBe(200);
  return ((await res.json()) as { item: RegistryItemDto }).item;
}

describe("registry ships locked", () => {
  // This block is the point of the whole PR: with no entitlement row — which is
  // every wedding in production — nothing is reachable. If any of these ever go
  // green as 200, the feature has silently launched.
  const routes: Array<[string, string, unknown?]> = [
    ["GET", base],
    ["PUT", `${base}/settings`, { published: true }],
    ["POST", `${base}/items`, ITEM],
    ["PATCH", `${base}/items/reorder`, { orderedIds: ["reg_x"] }],
    ["PATCH", `${base}/items/reg_x`, { title: "x" }],
    ["DELETE", `${base}/items/reg_x`],
    ["POST", `${base}/gifts/claim/rcl_x/thanked`, { thanked: true }],
    ["POST", `${base}/link-preview`, { url: "https://shop.example/pan" }],
    ["POST", `${base}/image`],
    ["POST", `${base}/image/from-url`, { url: "https://cdn.example/pan.jpg" }],
    ["GET", `${base}/image/registry-abc`],
  ];

  for (const [method, path, body] of routes) {
    it(`${method} ${path.replace(base, "…")} → 402 payment_required`, async () => {
      const res = await req(buildApp(), method, path, OWNER, body);
      expect(res.status).toBe(402);
      expect(await jsonBody(res)).toEqual({ error: "payment_required", entitlement: "registry" });
    });
  }

  it("401 without a token, before the entitlement gate is consulted", async () => {
    expect((await req(buildApp(), "GET", base, undefined)).status).toBe(401);
  });

  it("a stranger gets 403, not 402 — the role gate runs first", async () => {
    // Ordering matters: a 402 to a non-member would leak which weddings exist
    // and which features they hold.
    expect((await req(buildApp(), "GET", base, STRANGER)).status).toBe(403);
  });
});

describe("registry routes (entitled)", () => {
  it("viewer may read, editor may write, viewer may not write", async () => {
    const app = buildApp({ grantRegistry: true });
    expect((await req(app, "GET", base, VIEWER)).status).toBe(200);

    const viewerWrite = await req(app, "POST", `${base}/items`, VIEWER, ITEM);
    expect(viewerWrite.status).toBe(403);
    expect(((await viewerWrite.json()) as { error: string }).error).toBe("read_only_role");

    expect((await req(app, "POST", `${base}/items`, EDITOR, ITEM)).status).toBe(200);
  });

  it("reads back an unpublished, empty registry", async () => {
    const res = await req(buildApp({ grantRegistry: true }), "GET", base, OWNER);
    const body = (await res.json()) as RegistrySnapshot;
    expect(body.settings.published).toBe(false);
    expect(body.items).toEqual([]);
    expect(body.gifts).toEqual([]);
    expect(body.currency).toBe("AUD");
    expect(body.contributionsPrimaryMinor).toBe(0);
  });

  it("runs the item lifecycle end to end", async () => {
    const app = buildApp({ grantRegistry: true });
    const item = await seedItem(app);
    expect(item.title).toBe("Copper pan");
    expect(item.quantityWanted).toBe(2);
    expect(item.quantityClaimed).toBe(0);

    const patched = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      title: "Copper saucepan",
      priceMinor: null,
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { item: RegistryItemDto }).item.priceMinor).toBeNull();

    expect((await req(app, "DELETE", `${base}/items/${item.id}`, EDITOR)).status).toBe(200);
    const after = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(after.items).toEqual([]);
  });

  it("404s an item id from another wedding", async () => {
    const app = buildApp({ grantRegistry: true });
    const item = await seedItem(app);
    // wed_other has no entitlement, so its own routes 402 — the tenancy check
    // that matters is that BOOTSTRAP's route refuses an id it does not own.
    const res = await req(app, "PATCH", `${base}/items/reg_not_mine`, EDITOR, { title: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("registry_item_not_found");
    // The real item is untouched.
    const snap = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(snap.items[0]!.id).toBe(item.id);
  });

  it("rejects a non-https external URL", async () => {
    // `external_url` reaches an <a href> on the guest site. A javascript: or
    // data: value there is a script sink (precedent CON-S-L2), so the scheme is
    // checked at the boundary, not just the shape.
    const app = buildApp({ grantRegistry: true });
    for (const externalUrl of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://shop.example/thing",
      "not a url",
    ]) {
      const res = await req(app, "POST", `${base}/items`, EDITOR, { title: "T", externalUrl });
      expect(res.status).toBe(400);
    }
    const ok = await req(app, "POST", `${base}/items`, EDITOR, {
      title: "T",
      externalUrl: "https://shop.example/thing",
    });
    expect(ok.status).toBe(200);
  });

  it("rejects a malformed body and an out-of-range quantity", async () => {
    const app = buildApp({ grantRegistry: true });
    expect((await req(app, "POST", `${base}/items`, EDITOR, { title: "" })).status).toBe(400);
    expect(
      (await req(app, "POST", `${base}/items`, EDITOR, { title: "T", quantityWanted: 0 })).status,
    ).toBe(400);
    expect(
      (await req(app, "POST", `${base}/items`, EDITOR, { title: "T", quantityWanted: 1000 }))
        .status,
    ).toBe(400);
    // Malformed JSON degrades to the schema's 400, not a framework parse error.
    const raw = await appRequest(app, `${base}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: "{ not json",
    });
    expect(raw.status).toBe(400);
  });

  it("reorders items", async () => {
    const app = buildApp({ grantRegistry: true });
    const a = await seedItem(app);
    const bRes = await req(app, "POST", `${base}/items`, EDITOR, { title: "Kettle" });
    const b = ((await bRes.json()) as { item: RegistryItemDto }).item;

    expect(
      (await req(app, "PATCH", `${base}/items/reorder`, EDITOR, { orderedIds: [b.id, a.id] }))
        .status,
    ).toBe(200);
    const snap = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(snap.items.map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it("saves settings but refuses to enable cash gifts without a live Stripe account", async () => {
    const app = buildApp({ grantRegistry: true });
    const saved = await req(app, "PUT", `${base}/settings`, EDITOR, {
      published: true,
      message: "No boxed gifts please",
    });
    expect(saved.status).toBe(200);

    // Offering a contribute button that cannot take money is worse than not
    // offering one — the guest believes they paid.
    const cash = await req(app, "PUT", `${base}/settings`, EDITOR, { cashGiftsEnabled: true });
    expect(cash.status).toBe(409);
    expect(((await cash.json()) as { error: string }).error).toBe("stripe_not_ready");

    const snap = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(snap.settings.published).toBe(true);
    expect(snap.settings.cashGiftsEnabled).toBe(false);
  });

  it("400s an image key that names another wedding's upload", async () => {
    // The schema pins the SHAPE (`assets/<segment>/registry-<name>`), so only the
    // service can tell whose upload it is. A distinct code, not the generic 400,
    // because the portal has to explain this one.
    const app = buildApp({ grantRegistry: true });
    const foreign = await req(app, "POST", `${base}/items`, EDITOR, {
      title: "T",
      imageKey: "assets/wed_other/registry-abc",
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toBe("image_key_not_in_wedding");

    const own = await req(app, "POST", `${base}/items`, EDITOR, {
      title: "T",
      imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/registry-abc`,
    });
    expect(own.status).toBe(200);

    // The update path is gated the same way.
    const item = ((await own.json()) as { item: RegistryItemDto }).item;
    const patched = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      imageKey: "assets/wed_other/registry-abc",
    });
    expect(patched.status).toBe(400);
    expect(((await patched.json()) as { error: string }).error).toBe("image_key_not_in_wedding");
  });

  it("refuses a key naming a different slot of the caller's OWN wedding", async () => {
    // S-M1. The wedding half of the key is right, so the ownership check passes —
    // what stops it is the slot. Without that, an editor could point an item at
    // their own invite hero and have deleting the item reap the hero's object.
    const app = buildApp({ grantRegistry: true });
    const created = await req(app, "POST", `${base}/items`, EDITOR, {
      title: "T",
      imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/hero-0000`,
    });
    expect(created.status).toBe(400);

    const ok = await req(app, "POST", `${base}/items`, EDITOR, { title: "T" });
    expect(ok.status).toBe(200);
    const item = ((await ok.json()) as { item: RegistryItemDto }).item;
    const patched = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/story-0000`,
    });
    expect(patched.status).toBe(400);
  });

  it("reports whether the gift log has another page, and ignores a junk offset", async () => {
    const app = buildApp({ grantRegistry: true });
    const first = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(first.giftsHasMore).toBe(false);

    // `giftsOffset` is caller-supplied, so every unparseable value has to read as
    // page one rather than 500 or NaN reaching the query.
    for (const raw of ["abc", "-3", "1e9", ""]) {
      const res = await req(app, "GET", `${base}?giftsOffset=${raw}`, OWNER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as RegistrySnapshot;
      expect(body.gifts).toEqual([]);
      expect(body.giftsHasMore).toBe(false);
    }
  });

  it("400s an unknown gift kind in the path rather than guessing a table", async () => {
    const app = buildApp({ grantRegistry: true });
    const res = await req(app, "POST", `${base}/gifts/wishes/rcl_x/thanked`, EDITOR, {
      thanked: true,
    });
    expect(res.status).toBe(400);
  });

  it("404s a thank-you for a gift that is not this wedding's", async () => {
    const app = buildApp({ grantRegistry: true });
    const res = await req(app, "POST", `${base}/gifts/claim/rcl_nope/thanked`, EDITOR, {
      thanked: true,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("registry_gift_not_found");
  });
});

describe("POST /registry/link-preview", () => {
  const previewPath = `${base}/link-preview`;

  /** Every test here injects both seams — nothing in this file touches a network. */
  function options(handler: (url: string) => Response, addresses = ["93.184.216.34"]) {
    return {
      fetchImpl: ((input: string) => Promise.resolve(handler(input))) as unknown as typeof fetch,
      resolveHost: () => Promise.resolve(addresses),
    } satisfies LinkPreviewOptions;
  }

  const PAGE =
    "<title>Copper saucepan</title>" +
    '<meta property="og:site_name" content="Kitchen Co">' +
    '<meta property="og:image" content="https://cdn.example/pan.jpg">' +
    '<img src="/gallery/pan-2.jpg" width="800">';

  const okOptions = () =>
    options(
      () =>
        new Response(PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

  it("401 without a token", async () => {
    const res = await req(buildApp({ grantRegistry: true }), "POST", previewPath, undefined, {
      url: "https://shop.example/pan",
    });
    expect(res.status).toBe(401);
  });

  it("403 for a viewer — a read-only co-host cannot spend our outbound budget", async () => {
    const app = buildApp({ grantRegistry: true, linkPreview: okOptions() });
    const res = await req(app, "POST", previewPath, VIEWER, { url: "https://shop.example/pan" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("403 for a stranger", async () => {
    const app = buildApp({ grantRegistry: true, linkPreview: okOptions() });
    expect(
      (await req(app, "POST", previewPath, STRANGER, { url: "https://shop.example/pan" })).status,
    ).toBe(403);
  });

  it("returns the title, site name and ranked images", async () => {
    const app = buildApp({ grantRegistry: true, linkPreview: okOptions() });
    const res = await req(app, "POST", previewPath, EDITOR, { url: "https://shop.example/pan" });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      title: "Copper saucepan",
      siteName: "Kitchen Co",
      images: ["https://cdn.example/pan.jpg", "https://shop.example/gallery/pan-2.jpg"],
    });
  });

  it("400s a non-https or malformed url at the boundary, before any fetch", async () => {
    let fetched = 0;
    const app = buildApp({
      grantRegistry: true,
      linkPreview: {
        fetchImpl: (() => {
          fetched += 1;
          return Promise.reject(new Error("must not fetch"));
        }) as unknown as typeof fetch,
        resolveHost: () => Promise.resolve(["93.184.216.34"]),
      },
    });
    for (const url of [
      "http://shop.example/pan",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "https://user:pw@shop.example/pan",
      "not a url",
      42,
    ]) {
      const res = await req(app, "POST", previewPath, EDITOR, { url });
      expect(res.status).toBe(400);
    }
    expect(fetched).toBe(0);
  });

  it("400s `blocked_url` — with no reason — when the host resolves inward", async () => {
    // The code is stable and machine-readable; the RULE that fired is not
    // disclosed, or this becomes an internal-network scanner with an oracle.
    const app = buildApp({
      grantRegistry: true,
      linkPreview: options(() => new Response("", { status: 200 }), ["169.254.169.254"]),
    });
    const res = await req(app, "POST", previewPath, EDITOR, { url: "https://rebind.example/pan" });
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "blocked_url" });
  });

  it("502s when the page cannot be fetched", async () => {
    const app = buildApp({
      grantRegistry: true,
      linkPreview: options(() => new Response("nope", { status: 500 })),
    });
    const res = await req(app, "POST", previewPath, EDITOR, { url: "https://shop.example/pan" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("preview_fetch_failed");
  });

  it("415s a document that is not HTML", async () => {
    const app = buildApp({
      grantRegistry: true,
      linkPreview: options(
        () =>
          new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    });
    const res = await req(app, "POST", previewPath, EDITOR, {
      url: "https://shop.example/pan.pdf",
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_content_type");
  });

  it("422s an HTML page with no usable image", async () => {
    const app = buildApp({
      grantRegistry: true,
      linkPreview: options(
        () =>
          new Response("<title>Bare</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    });
    const res = await req(app, "POST", previewPath, EDITOR, { url: "https://shop.example/pan" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("no_images_found");
  });

  it("429s past the per-organiser budget, and the budget is per user", async () => {
    // An outbound-fetch amplifier gets its OWN limiter — the registry writes must
    // not be able to exhaust it, and it must not be able to exhaust them.
    const db = createDb(":memory:");
    seedDb(db);
    const now = new Date();
    db.insert(weddingHosts)
      .values({
        id: "whost_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: EDITOR,
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: now,
      })
      .run();
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "registry",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .run();
    const app = createApp(db, {
      osnTestKey: auth.key,
      registryPreviewLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
      registryLinkPreviewOptions: okOptions(),
    });

    const body = { url: "https://shop.example/pan" };
    expect((await req(app, "POST", previewPath, EDITOR, body)).status).toBe(200);
    expect((await req(app, "POST", previewPath, EDITOR, body)).status).toBe(200);
    const limited = await req(app, "POST", previewPath, EDITOR, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");

    // The owner has their own budget, and the registry writes have their own limiter.
    expect((await req(app, "POST", previewPath, OWNER, body)).status).toBe(200);
    expect((await req(app, "POST", `${base}/items`, EDITOR, ITEM)).status).toBe(200);
  });
});

describe("registry image saves", () => {
  const uploadPath = `${base}/image`;
  const fromUrlPath = `${base}/image/from-url`;

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const HTML = new TextEncoder().encode("<!doctype html><title>nope</title>");

  /** POST raw bytes — the upload leg takes a body, not JSON. */
  async function upload(
    app: App,
    bytes: Uint8Array,
    profileId: string | undefined,
    contentType = "image/png",
    contentLength?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (contentLength !== undefined) headers["Content-Length"] = contentLength;
    if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
    return appRequest(app, uploadPath, { method: "POST", headers, body: bytes });
  }

  /** Injected fetch + DNS — no test here reaches a network. */
  function remote(
    body: BodyInit,
    init: ResponseInit = { status: 200, headers: { "content-type": "image/png" } },
    addresses = ["93.184.216.34"],
  ): LinkPreviewOptions {
    return {
      fetchImpl: (() => Promise.resolve(new Response(body, init))) as unknown as typeof fetch,
      resolveHost: () => Promise.resolve(addresses),
    };
  }

  it("stores an upload and hands back a key the item routes accept", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });
    const res = await upload(app, PNG, EDITOR);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { imageKey: string; imageUrl: string };
    expect(saved.imageKey).toStartWith(`assets/${BOOTSTRAP_WEDDING_ID}/registry-`);
    expect(assets._store.size).toBe(1);

    // The whole point of returning a key: the create body already takes one, and
    // the ownership check in the service passes because we minted it here.
    const created = await req(app, "POST", `${base}/items`, EDITOR, {
      title: "Copper pan",
      imageKey: saved.imageKey,
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { item: RegistryItemDto }).item.imageKey).toBe(
      saved.imageKey,
    );
  });

  it("rejects a disallowed format on its signature, not on the header it claims", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });
    // Both of these arrive as `Content-Type: image/png`.
    expect((await upload(app, GIF, EDITOR)).status).toBe(415);
    const lying = await upload(app, HTML, EDITOR);
    expect(lying.status).toBe(415);
    expect(((await lying.json()) as { error: string }).error).toBe("unsupported_image_type");
    expect(assets._store.size).toBe(0);
  });

  it("413s an over-cap upload on the declared length AND on the real one", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });

    // A lie big enough to refuse before reading a byte.
    const preCheck = await upload(app, PNG, EDITOR, "image/png", String(MAX_IMAGE_BYTES + 1));
    expect(preCheck.status).toBe(413);

    // Chunked, so there is no `Content-Length` to pre-check against: the only
    // thing left is the service weighing what actually arrived.
    const oversize = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversize.set(PNG, 0);
    const real = await appRequest(app, uploadPath, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversize);
          controller.close();
        },
      }),
      // Required by the Request constructor for a streamed body.
      duplex: "half",
    } as RequestInit);
    expect(real.status).toBe(413);
    expect(((await real.json()) as { error: string }).error).toBe("image_too_large");
    expect(assets._store.size).toBe(0);
  });

  it("400s an empty upload body", async () => {
    const app = buildApp({ grantRegistry: true, assets: createAssetsStub() });
    expect((await upload(app, new Uint8Array(0), EDITOR)).status).toBe(400);
  });

  it("copies a picked candidate into R2 and stores no url", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets, linkPreview: remote(PNG) });
    const res = await req(app, "POST", fromUrlPath, EDITOR, { url: "https://cdn.example/pan.png" });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { imageKey: string; imageUrl: string };
    expect(saved.imageKey).toStartWith(`assets/${BOOTSTRAP_WEDDING_ID}/registry-`);
    expect(assets._store.size).toBe(1);
    // Nothing that reaches the client (or the row) names the shop's CDN.
    expect(JSON.stringify(saved)).not.toContain("cdn.example");
  });

  it("400s `blocked_url` for a candidate whose host resolves inward", async () => {
    // The candidate came out of OUR preview and is still re-guarded: this body is
    // client-controlled, and nothing in it proves a preview ever ran.
    const assets = createAssetsStub();
    const app = buildApp({
      grantRegistry: true,
      assets,
      linkPreview: remote(PNG, { status: 200 }, ["169.254.169.254"]),
    });
    const res = await req(app, "POST", fromUrlPath, EDITOR, {
      url: "https://rebind.example/pan.png",
    });
    expect(res.status).toBe(400);
    // No reason disclosed — that is what keeps this from being a network scanner.
    expect(await jsonBody(res)).toEqual({ error: "blocked_url" });
    expect(assets._store.size).toBe(0);
  });

  it("400s a non-https candidate at the boundary, before any fetch", async () => {
    let fetched = 0;
    const app = buildApp({
      grantRegistry: true,
      assets: createAssetsStub(),
      linkPreview: {
        fetchImpl: (() => {
          fetched += 1;
          return Promise.reject(new Error("must not fetch"));
        }) as unknown as typeof fetch,
        resolveHost: () => Promise.resolve(["93.184.216.34"]),
      },
    });
    for (const url of [
      "http://cdn.example/pan.png",
      "javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "file:///etc/passwd",
      "https://user:pw@cdn.example/pan.png",
      "not a url",
      42,
    ]) {
      expect((await req(app, "POST", fromUrlPath, EDITOR, { url })).status).toBe(400);
    }
    expect(fetched).toBe(0);
  });

  it("415s a candidate url that serves a document rather than an image", async () => {
    const assets = createAssetsStub();
    const app = buildApp({
      grantRegistry: true,
      assets,
      // A 200 and an `image/png` header over HTML — the sniff is the only honest
      // signal in the response.
      linkPreview: remote(HTML, { status: 200, headers: { "content-type": "image/png" } }),
    });
    const res = await req(app, "POST", fromUrlPath, EDITOR, { url: "https://cdn.example/pan.png" });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_image_type");
    expect(assets._store.size).toBe(0);
  });

  it("502s when the candidate cannot be fetched", async () => {
    const app = buildApp({
      grantRegistry: true,
      assets: createAssetsStub(),
      linkPreview: remote("gone", { status: 404, headers: { "content-type": "text/plain" } }),
    });
    const res = await req(app, "POST", fromUrlPath, EDITOR, { url: "https://cdn.example/pan.png" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("image_fetch_failed");
  });

  it("401 unauthenticated, 403 for a viewer, 403 for a stranger", async () => {
    const app = buildApp({
      grantRegistry: true,
      assets: createAssetsStub(),
      linkPreview: remote(PNG),
    });
    expect((await upload(app, PNG, undefined)).status).toBe(401);
    expect(
      (await req(app, "POST", fromUrlPath, undefined, { url: "https://cdn.example/pan.png" }))
        .status,
    ).toBe(401);

    const viewerUpload = await upload(app, PNG, VIEWER);
    expect(viewerUpload.status).toBe(403);
    expect(((await viewerUpload.json()) as { error: string }).error).toBe("read_only_role");
    expect(
      (await req(app, "POST", fromUrlPath, VIEWER, { url: "https://cdn.example/pan.png" })).status,
    ).toBe(403);
    expect((await upload(app, PNG, STRANGER)).status).toBe(403);
  });

  it("429s past the per-organiser image budget, independently of the preview budget", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const now = new Date();
    db.insert(weddingHosts)
      .values({
        id: "whost_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: EDITOR,
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: now,
      })
      .run();
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "registry",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .run();
    const app = createApp(db, {
      osnTestKey: auth.key,
      assets: createAssetsStub(),
      registryImageLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
      registryPreviewLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
      registryLinkPreviewOptions: remote(PNG),
    });

    expect((await upload(app, PNG, EDITOR)).status).toBe(200);
    expect((await upload(app, PNG, EDITOR)).status).toBe(200);
    const limited = await upload(app, PNG, EDITOR);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");

    // The preview keeps its own budget, and so does the other organiser.
    expect(
      (await req(app, "POST", `${base}/link-preview`, EDITOR, { url: "https://shop.example/pan" }))
        .status,
    ).not.toBe(429);
    expect((await upload(app, PNG, OWNER)).status).toBe(200);
  });
});

describe("GET /registry/image/:name", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  async function uploadOne(app: App): Promise<string> {
    const res = await appRequest(app, `${base}/image`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: PNG,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { imageKey: string }).imageKey;
  }

  function nameOf(key: string): string {
    return key.slice(key.lastIndexOf("/") + 1);
  }

  it("serves the bytes to any member, viewer included", async () => {
    const app = buildApp({ grantRegistry: true, assets: createAssetsStub() });
    const key = await uploadOne(app);
    const res = await req(app, "GET", `${base}/image/${nameOf(key)}`, VIEWER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Organiser-only bytes: no shared cache may keep a copy.
    expect(res.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("404s a name that is not a registry key, and never leaves the wedding's prefix", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });
    const key = await uploadOne(app);
    // Plant an object under ANOTHER wedding and try to reach it by every spelling
    // a client controls. The key is rebuilt server-side, so none of these can.
    assets._store.set("assets/wed_other/registry-secret", {
      bytes: PNG.buffer.slice(0) as ArrayBuffer,
      contentType: "image/png",
    });
    for (const name of [
      "../wed_other/registry-secret",
      "..%2Fwed_other%2Fregistry-secret",
      "hero-1234",
      "registry-secret/../../wed_other/registry-secret",
    ]) {
      const res = await req(app, "GET", `${base}/image/${name}`, EDITOR);
      expect(res.status).toBe(404);
    }
    // The wedding's own image still serves — the guard is not simply refusing all.
    expect((await req(app, "GET", `${base}/image/${nameOf(key)}`, EDITOR)).status).toBe(200);
  });

  it("404s a well-formed name with no object behind it", async () => {
    const app = buildApp({ grantRegistry: true, assets: createAssetsStub() });
    const res = await req(app, "GET", `${base}/image/registry-does-not-exist`, EDITOR);
    expect(res.status).toBe(404);
  });

  it("401 unauthenticated, 403 for a stranger", async () => {
    const app = buildApp({ grantRegistry: true, assets: createAssetsStub() });
    const key = await uploadOne(app);
    expect((await req(app, "GET", `${base}/image/${nameOf(key)}`, undefined)).status).toBe(401);
    expect((await req(app, "GET", `${base}/image/${nameOf(key)}`, STRANGER)).status).toBe(403);
  });
});

describe("deleting an item reaps its image", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  it("removes the R2 object, because D1's cascade stops at the row", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });
    const uploaded = await appRequest(app, `${base}/image`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: PNG,
    });
    const { imageKey } = (await uploaded.json()) as { imageKey: string };
    const created = await req(app, "POST", `${base}/items`, EDITOR, { title: "Pan", imageKey });
    const item = ((await created.json()) as { item: RegistryItemDto }).item;
    expect(assets._store.has(imageKey)).toBe(true);

    expect((await req(app, "DELETE", `${base}/items/${item.id}`, EDITOR)).status).toBe(200);
    expect(assets._store.has(imageKey)).toBe(false);
  });

  it("keeps the object while a second item still points at it", async () => {
    // S-M1: the same picture can back two items. The reap fires on the LAST
    // reference, not the first delete — otherwise the survivor loses its picture.
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });
    const uploaded = await appRequest(app, `${base}/image`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: PNG,
    });
    const { imageKey } = (await uploaded.json()) as { imageKey: string };
    const items: RegistryItemDto[] = [];
    for (const title of ["Pan", "Same pan"]) {
      const created = await req(app, "POST", `${base}/items`, EDITOR, { title, imageKey });
      items.push(((await created.json()) as { item: RegistryItemDto }).item);
    }

    expect((await req(app, "DELETE", `${base}/items/${items[0]!.id}`, EDITOR)).status).toBe(200);
    expect(assets._store.has(imageKey)).toBe(true);

    expect((await req(app, "DELETE", `${base}/items/${items[1]!.id}`, EDITOR)).status).toBe(200);
    expect(assets._store.has(imageKey)).toBe(false);
  });

  it("still deletes an item that never had an image", async () => {
    const assets = createAssetsStub();
    const app = buildApp({ grantRegistry: true, assets });
    const item = await seedItem(app);
    expect((await req(app, "DELETE", `${base}/items/${item.id}`, EDITOR)).status).toBe(200);
  });
});
