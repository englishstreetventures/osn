import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryClaims,
  registryItems,
  registrySettings,
  weddingEntitlements,
} from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { createAssetsStub } from "../../src/services/invite-assets";
import type {
  ImagesBindingLike,
  ImageTransformHandle,
  OutputFormat,
} from "../../src/services/invite-image-transform";
import { registryGuestService } from "../../src/services/registry";
import type { HouseholdRegistryDto, PublicRegistryDto } from "../../src/services/registry";
import { appRequest, jsonBody, recordStatements } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

const SLUG = "cire-wedding";
const OTHER_WEDDING_ID = "wed_other";
const OTHER_SLUG = "other-wedding";

/** Seeded households of the bootstrap wedding. */
const FAMILY = "TESTONE-IVY-AA11";
const OTHER_HOUSEHOLD = "TESTTWO-OAK-BB22";
/** Minted below, on the SECOND wedding — the cross-tenant cookie. */
const FOREIGN_FAMILY = "OTHERWD-ELM-EE55";

const PAN = "reg_pan";
const BOWL = "reg_bowl";
const OTHER_ITEM = "reg_other_pan";
const PAN_IMAGE = "registry-pan";

/** The claim another household already holds — the identity that must never leak. */
const FOREIGN_NOTE = "Bought it in the Boxing Day sale";
const FOREIGN_DISPLAY_NAME = "Auntie Ros";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
/** Distinct from `PNG` so a transformed serve is distinguishable from the original. */
const TRANSFORMED = new Uint8Array([0xaa, 0xbb, 0xcc]);

/** Stub Images binding — records the transform widths so re-billing is countable. */
function createImagesStub(): ImagesBindingLike & { widths: (number | undefined)[] } {
  const widths: (number | undefined)[] = [];
  return {
    widths,
    input() {
      const handle: ImageTransformHandle = {
        transform(t) {
          widths.push(t.width);
          return handle;
        },
        output(o: { format: OutputFormat }) {
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

/** Stub Cache API. `caches` is undefined in bun:test unless a test installs one. */
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

async function withCaches<T>(stub: CacheStorage, fn: () => Promise<T>): Promise<T> {
  const original = (globalThis as { caches?: CacheStorage }).caches;
  (globalThis as { caches?: CacheStorage }).caches = stub;
  try {
    return await fn();
  } finally {
    (globalThis as { caches?: CacheStorage }).caches = original;
  }
}

/**
 * Two weddings, both with a registry, so every cross-tenant assertion has a real
 * target rather than a fabricated id.
 *
 * The bootstrap wedding's gates are the knobs — `entitled` and `published` — and
 * BOTH default to on, the opposite of `registry.test.ts`. That file's subject is
 * the feature staying locked; this one's is what a guest sees once a couple has
 * deliberately opened it, so the interesting fixture here is the open one and
 * every locked case says so explicitly.
 *
 * The second wedding is always fully open: it exists to prove that a cookie from
 * it buys nothing on the first, which it cannot do if it is itself invisible.
 */
function buildApp(
  opts: {
    entitled?: boolean;
    /** False: the couple never saved the registry, so it has no settings row. */
    opened?: boolean;
    published?: boolean;
    shippingAddress?: string | null;
    shippingVisibleFrom?: string | null;
    /** The couple's intent, and Stripe's capability — two different things. */
    cashGiftsEnabled?: boolean;
    stripeChargesEnabled?: boolean;
    images?: ImagesBindingLike;
  } = {},
) {
  const {
    entitled = true,
    opened = true,
    published = true,
    shippingAddress = null,
    shippingVisibleFrom = null,
    cashGiftsEnabled = false,
    stripeChargesEnabled = false,
    images,
  } = opts;
  const db = createDb(":memory:");
  seedDb(db);
  const assets = createAssetsStub();
  const now = new Date();

  insertWedding(db, {
    id: OTHER_WEDDING_ID,
    slug: OTHER_SLUG,
    displayName: "Other",
    createdAt: now,
    updatedAt: now,
    owners: ["usr_bob"],
  });
  db.insert(families)
    .values({
      id: "fam_other",
      weddingId: OTHER_WEDDING_ID,
      publicId: FOREIGN_FAMILY,
      familyName: "Elmwood",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  for (const weddingId of entitled
    ? [BOOTSTRAP_WEDDING_ID, OTHER_WEDDING_ID]
    : [OTHER_WEDDING_ID]) {
    db.insert(weddingEntitlements)
      .values({
        weddingId,
        entitlement: "registry",
        source: "comp",
        grantedAt: now,
        grantedBy: "usr_dev_bootstrap_owner",
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
  }

  if (opened) {
    db.insert(registrySettings)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        published,
        headline: "Gifts",
        message: "Your presence is the present.",
        cashGiftsEnabled,
        stripeChargesEnabled,
        shippingAddress,
        shippingVisibleFrom,
        // Present so a leak test has something to catch: no guest payload may
        // carry the couple's Stripe account, published or not.
        stripeAccountId: "acct_secret_123",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  db.insert(registrySettings)
    .values({
      weddingId: OTHER_WEDDING_ID,
      published: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(registryItems)
    .values([
      {
        id: PAN,
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Copper pan",
        description: "The heavy one",
        imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`,
        imageCrop: null,
        externalUrl: "https://shop.example/pan",
        priceMinor: 12_000,
        quantityWanted: 2,
        category: "Kitchen",
        // Deliberately NOT in insertion order — the read must sort.
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: BOWL,
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: "Mixing bowl",
        quantityWanted: 1,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: OTHER_ITEM,
        weddingId: OTHER_WEDDING_ID,
        title: "Other pan",
        quantityWanted: 5,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  // One claim already on the pan, held by a DIFFERENT household of the same
  // wedding. Everything about it — who, how many, the note, the name — is what
  // the public read must reduce to a bare count.
  const [neighbour] = db
    .select({ id: families.id })
    .from(families)
    .where(eq(families.publicId, OTHER_HOUSEHOLD))
    .all();
  db.insert(registryClaims)
    .values({
      id: "rcl_neighbour",
      weddingId: BOOTSTRAP_WEDDING_ID,
      itemId: PAN,
      familyId: (neighbour as { id: string }).id,
      quantity: 1,
      status: "reserved",
      note: FOREIGN_NOTE,
      displayName: FOREIGN_DISPLAY_NAME,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const app = createApp(db, {
    assets,
    images,
    // Fresh limiters per app: the module-level defaults are process-wide, so
    // without these the 21st guest write in this file would 429 whichever test
    // happened to run last (and `/api/claim`'s budget is only 5/min).
    registryGuestLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    claimLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { app, assets, db };
}

type App = ReturnType<typeof buildApp>["app"];

/** Claim a code and keep the `cire_session` cookie it mints. */
async function guestCookie(app: App, publicId = FAMILY): Promise<string> {
  const res = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId }),
  });
  expect(res.status).toBe(200);
  const token = /cire_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  expect(token).toBeTruthy();
  return `cire_session=${token}`;
}

const guestBase = (slug = SLUG) => `/api/invite/${slug}/registry`;

function claim(app: App, cookie: string, body: unknown, slug = SLUG, itemId = PAN) {
  return appRequest(app, `${guestBase(slug)}/items/${itemId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function release(app: App, cookie: string, slug = SLUG, itemId = PAN) {
  return appRequest(app, `${guestBase(slug)}/items/${itemId}/claim`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
}

async function mine(app: App, cookie: string, slug = SLUG): Promise<HouseholdRegistryDto> {
  const res = await appRequest(app, `${guestBase(slug)}/mine`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as HouseholdRegistryDto;
}

async function listView(app: App, cookie: string, slug = SLUG): Promise<PublicRegistryDto> {
  const res = await appRequest(app, guestBase(slug), { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as PublicRegistryDto;
}

describe("the guest registry is one 404, whatever the reason", () => {
  // Unknown slug, feature not bought, list not published: three completely
  // different facts, and all three must answer identically. Anything else lets
  // a caller enumerate which weddings exist and which of them are quietly
  // drafting a gift list — from the image route, which is unauthenticated, and
  // from the gated routes to any guest who holds a code for one wedding.
  const scenarios = [
    ["an unknown slug", () => buildApp(), "no-such-wedding"],
    ["a wedding without the entitlement", () => buildApp({ entitled: false }), SLUG],
    ["an unpublished registry", () => buildApp({ published: false }), SLUG],
    // Entitled, but the couple never saved the registry: no settings row, which
    // reads as the defaults (unpublished), never as a fault.
    ["a registry never opened", () => buildApp({ opened: false }), SLUG],
  ] as const;

  for (const [label, make, slug] of scenarios) {
    it(`${label} → the same 404 on the public image route`, async () => {
      const { app } = make();
      const res = await appRequest(app, `${guestBase(slug)}/image/${PAN_IMAGE}`);
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
    });

    it(`${label} → the same 404 on every session-gated route`, async () => {
      const { app } = make();
      const cookie = await guestCookie(app);

      for (const path of [guestBase(slug), `${guestBase(slug)}/mine`]) {
        const read = await appRequest(app, path, { headers: { Cookie: cookie } });
        expect(read.status).toBe(404);
        expect(await jsonBody(read)).toEqual({ error: "registry_not_found" });
      }

      const claimed = await claim(app, cookie, { quantity: 1 }, slug);
      expect(claimed.status).toBe(404);
      expect(await jsonBody(claimed)).toEqual({ error: "registry_not_found" });

      const released = await release(app, cookie, slug);
      expect(released.status).toBe(404);
      expect(await jsonBody(released)).toEqual({ error: "registry_not_found" });
    });
  }

  it("reads a household's list with the household check inside the gate", async () => {
    // Gate (with the household), then the items and the claim counts
    // together: two hops, never a third for the household or the currency.
    const { app, db } = buildApp();
    const cookie = await guestCookie(app);
    const statements = recordStatements(db);
    await listView(app, cookie);
    // The session read joins `weddings` for its live-wedding check; it is
    // sessionAuth's, not the registry gate's, so it is left out of the count.
    const registryReads = statements.filter(
      (s) => /"registry_|"weddings"/.test(s.sql) && !/from "sessions"/.test(s.sql),
    );
    expect(registryReads).toHaveLength(3);
    expect(registryReads[0]!.sql).toContain('"families"');
    const householdOnly = statements.filter(
      (s) => /from "families"/.test(s.sql) && !s.sql.includes('"weddings"'),
    );
    expect(householdOnly).toEqual([]);
  });

  it("decides all of it in one statement", async () => {
    // Every guest route pays this gate, and the image route pays it per image.
    for (const [opts, slug, visible] of [
      [{}, SLUG, true],
      [{ opened: false }, SLUG, false],
      [{ entitled: false }, SLUG, false],
      [{}, "no-such-wedding", false],
    ] as const) {
      const { db } = buildApp(opts);
      const statements = recordStatements(db);
      const exit = await Effect.runPromiseExit(
        registryGuestService.visibleWeddingId(slug).pipe(Effect.provideService(DbService, db)),
      );
      expect(Exit.isSuccess(exit)).toBe(visible);
      expect(statements).toHaveLength(1);
    }
  });

  it("401s the session-gated routes with no cookie at all, before the slug is read", async () => {
    const { app } = buildApp();
    // The LIST is one of them: a gift list names what a couple want and what it
    // costs, and they only ever showed it to the people they invited.
    expect((await appRequest(app, guestBase())).status).toBe(401);
    expect((await appRequest(app, `${guestBase()}/mine`)).status).toBe(401);
    const res = await appRequest(app, `${guestBase()}/items/${PAN}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/invite/:slug/registry (sessionAuth)", () => {
  it("returns the couple's copy and the list in sort order, to a household of this wedding", async () => {
    const { app } = buildApp();
    const body = await listView(app, await guestCookie(app));
    expect(body.headline).toBe("Gifts");
    expect(body.message).toBe("Your presence is the present.");
    expect(body.cashGiftsEnabled).toBe(false);
    expect(body.currency).toBe("AUD");
    // Inserted pan-then-bowl, sortOrder 1-then-0: the read sorts.
    expect(body.items.map((i) => i.id)).toEqual([BOWL, PAN]);
  });

  it("is never cached — a stale list has two households buying the same pan", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, guestBase(), {
      headers: { Cookie: await guestCookie(app) },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports the claimed total as an aggregate and nothing else about it", async () => {
    const { app } = buildApp();
    const body = await listView(app, await guestCookie(app));
    const pan = body.items.find((i) => i.id === PAN);
    expect(pan?.quantityWanted).toBe(2);
    expect(pan?.quantityClaimed).toBe(1); // the neighbour's claim, counted only
    expect(body.items.find((i) => i.id === BOWL)?.quantityClaimed).toBe(0);

    // Exhaustive key set, so a field added to the DTO later cannot slip out to
    // guests without this failing first.
    expect(Object.keys(pan ?? {}).toSorted()).toEqual(
      [
        "category",
        "description",
        "externalUrl",
        "id",
        "imageCrop",
        "imageName",
        "kind",
        "priceMinor",
        "quantityClaimed",
        "quantityWanted",
        "sortOrder",
        "title",
      ].toSorted(),
    );
    // The last segment of the key, never the key: the serve route rebuilds
    // `assets/<weddingId>/<name>` itself, so the payload names no wedding.
    expect(pan?.imageName).toBe(PAN_IMAGE);
  });

  it("leaks no claimant, note, gift log, Stripe id or shipping address", async () => {
    const { app } = buildApp({ shippingAddress: "12 Wattle St, Fitzroy" });
    const raw = await (
      await appRequest(app, guestBase(), { headers: { Cookie: await guestCookie(app) } })
    ).text();
    for (const secret of [
      FOREIGN_NOTE,
      FOREIGN_DISPLAY_NAME,
      "acct_secret_123",
      "12 Wattle St",
      "rcl_neighbour",
      BOOTSTRAP_WEDDING_ID,
    ]) {
      expect(raw).not.toContain(secret);
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(
      ["cashGiftsEnabled", "currency", "headline", "items", "message"].toSorted(),
    );
  });
});

describe("whether a guest may give money", () => {
  /**
   * The DTO ANDs the couple's intent with Stripe's capability, so the guest
   * surface never has to reason about the two separately. Drop the AND and
   * every guest of a couple whose Stripe capability lapsed gets a live
   * give-money form whose every press ends in a 409 they cannot act on.
   */
  it("is false when the couple said yes but Stripe cannot take a charge", async () => {
    const { app } = buildApp({ cashGiftsEnabled: true, stripeChargesEnabled: false });
    const body = await listView(app, await guestCookie(app));
    expect(body.cashGiftsEnabled).toBe(false);
  });

  it("is false when Stripe is ready but the couple never said yes", async () => {
    const { app } = buildApp({ cashGiftsEnabled: false, stripeChargesEnabled: true });
    const body = await listView(app, await guestCookie(app));
    expect(body.cashGiftsEnabled).toBe(false);
  });

  it("is true only when both are", async () => {
    const { app } = buildApp({ cashGiftsEnabled: true, stripeChargesEnabled: true });
    const body = await listView(app, await guestCookie(app));
    expect(body.cashGiftsEnabled).toBe(true);
  });
});

describe("GET /api/invite/:slug/registry/mine", () => {
  it("returns this household's own claims and nobody else's", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    expect((await mine(app, cookie)).claims).toEqual([]); // the neighbour's claim is not ours

    expect((await claim(app, cookie, { quantity: 1, note: "ours" })).status).toBe(200);
    expect((await mine(app, cookie)).claims).toEqual([
      { itemId: PAN, quantity: 1, status: "reserved", note: "ours", displayName: null },
    ]);
  });

  it("still shows a household its own note after the couple hid it", async () => {
    const { app, db } = buildApp();
    const cookie = await guestCookie(app);
    expect((await claim(app, cookie, { quantity: 1, note: "ours" })).status).toBe(200);
    // A hide is the couple's view of their own log; the guest is not told, and
    // their own record of what they wrote is unchanged.
    db.update(registryClaims)
      .set({ noteHiddenAt: new Date(), noteHiddenByOsnProfileId: "usr_dev_bootstrap_owner" })
      .run();
    expect((await mine(app, cookie)).claims).toEqual([
      { itemId: PAN, quantity: 1, status: "reserved", note: "ours", displayName: null },
    ]);
  });

  it("is never cached", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${guestBase()}/mine`, {
      headers: { Cookie: await guestCookie(app) },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the shipping address is earned, not published", () => {
  it("ships to a household with a live claim once no embargo stands", async () => {
    const { app } = buildApp({ shippingAddress: "12 Wattle St, Fitzroy" });
    const cookie = await guestCookie(app);
    expect((await mine(app, cookie)).shippingAddress).toBeUndefined(); // nothing claimed yet

    expect((await claim(app, cookie, { quantity: 1 })).status).toBe(200);
    expect((await mine(app, cookie)).shippingAddress).toBe("12 Wattle St, Fitzroy");
  });

  it("withholds it until the couple's date has passed, then hands it over", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

    const embargoed = buildApp({
      shippingAddress: "12 Wattle St, Fitzroy",
      shippingVisibleFrom: future,
    });
    const embargoedCookie = await guestCookie(embargoed.app);
    expect((await claim(embargoed.app, embargoedCookie, { quantity: 1 })).status).toBe(200);
    // Claimed, but the couple asked for nothing to arrive yet.
    expect((await mine(embargoed.app, embargoedCookie)).shippingAddress).toBeUndefined();

    const lifted = buildApp({
      shippingAddress: "12 Wattle St, Fitzroy",
      shippingVisibleFrom: past,
    });
    const liftedCookie = await guestCookie(lifted.app);
    expect((await claim(lifted.app, liftedCookie, { quantity: 1 })).status).toBe(200);
    expect((await mine(lifted.app, liftedCookie)).shippingAddress).toBe("12 Wattle St, Fitzroy");
  });

  it("counts the named day itself as lifted, not as one more day of waiting", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { app } = buildApp({
      shippingAddress: "12 Wattle St, Fitzroy",
      shippingVisibleFrom: today,
    });
    const cookie = await guestCookie(app);
    expect((await claim(app, cookie, { quantity: 1 })).status).toBe(200);
    expect((await mine(app, cookie)).shippingAddress).toBe("12 Wattle St, Fitzroy");
  });

  it("takes it back when the household releases its last claim", async () => {
    const { app } = buildApp({ shippingAddress: "12 Wattle St, Fitzroy" });
    const cookie = await guestCookie(app);
    expect((await claim(app, cookie, { quantity: 1 })).status).toBe(200);
    expect((await release(app, cookie)).status).toBe(200);
    expect((await mine(app, cookie)).shippingAddress).toBeUndefined();
  });

  it("never ships an address the couple never set", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    expect((await claim(app, cookie, { quantity: 1 })).status).toBe(200);
    expect((await mine(app, cookie)).shippingAddress).toBeUndefined();
  });
});

describe("claim → purchased → release, over HTTP", () => {
  it("runs the round trip, and a release is a tombstone the re-claim reuses", async () => {
    const { app, db } = buildApp();
    const cookie = await guestCookie(app);

    expect((await claim(app, cookie, { quantity: 1, displayName: "The Testfamilys" })).status).toBe(
      200,
    );
    expect((await mine(app, cookie)).claims[0]?.status).toBe("reserved");
    expect((await listView(app, cookie)).items.find((i) => i.id === PAN)?.quantityClaimed).toBe(2);

    // "Mark purchased" is the SAME endpoint with a different status — one unique
    // (item, family) row in two states, so there is no second write path to drift.
    const purchased = await claim(app, cookie, { quantity: 1, status: "purchased" });
    expect(purchased.status).toBe(200);
    expect(await jsonBody(purchased)).toEqual({ ok: true });
    const afterPurchase = await mine(app, cookie);
    expect(afterPurchase.claims[0]?.status).toBe("purchased");
    expect(afterPurchase.claims[0]?.displayName).toBeNull(); // omitted ⇒ cleared

    expect((await release(app, cookie)).status).toBe(200);
    expect((await mine(app, cookie)).claims).toEqual([]); // released ⇒ not a claim
    expect((await listView(app, cookie)).items.find((i) => i.id === PAN)?.quantityClaimed).toBe(1);

    // The row survives as `released` rather than being deleted…
    const [family] = db
      .select({ id: families.id })
      .from(families)
      .where(eq(families.publicId, FAMILY))
      .all();
    const rows = db
      .select({ id: registryClaims.id, status: registryClaims.status })
      .from(registryClaims)
      .where(
        and(
          eq(registryClaims.itemId, PAN),
          eq(registryClaims.familyId, (family as { id: string }).id),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("released");
    const tombstoneId = rows[0]?.id;

    // …and the re-claim reuses it, rather than colliding with the unique index.
    expect((await claim(app, cookie, { quantity: 1 })).status).toBe(200);
    const after = db
      .select({ id: registryClaims.id, status: registryClaims.status })
      .from(registryClaims)
      .where(
        and(
          eq(registryClaims.itemId, PAN),
          eq(registryClaims.familyId, (family as { id: string }).id),
        ),
      )
      .all();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(tombstoneId as string);
    expect(after[0]?.status).toBe("reserved");
  });

  it("409s an over-claim, counting what other households already hold", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    // Two wanted, one already spoken for by the neighbour: asking for two is one
    // too many, and the caller may not see why (that would name the neighbour).
    const res = await claim(app, cookie, { quantity: 2 });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "item_fully_claimed" });

    expect((await claim(app, cookie, { quantity: 1 })).status).toBe(200);
  });

  it("404s an item id that belongs to no item, with the item-shaped code", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    const res = await claim(app, cookie, { quantity: 1 }, SLUG, "reg_nope");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_item_not_found" });
  });
});

describe("guest claim request bodies", () => {
  it("400s a quantity outside 1..99, at either end", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    for (const quantity of [0, -1, 100, 1.5, "1"]) {
      const res = await claim(app, cookie, { quantity });
      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
    }
  });

  it("400s a malformed body rather than surfacing a framework parse error", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${guestBase()}/items/${PAN}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await guestCookie(app) },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("defaults an empty body to one reserved, and bounds the free text", async () => {
    const { app } = buildApp();
    const cookie = await guestCookie(app);
    expect((await claim(app, cookie, {})).status).toBe(200);
    expect((await mine(app, cookie)).claims[0]).toEqual({
      itemId: PAN,
      quantity: 1,
      status: "reserved",
      note: null,
      displayName: null,
    });

    expect((await claim(app, cookie, { note: "x".repeat(1001) })).status).toBe(400);
    expect((await claim(app, cookie, { displayName: "x".repeat(121) })).status).toBe(400);
    expect((await claim(app, cookie, { status: "released" })).status).toBe(400);
  });
});

describe("a cookie for one wedding buys nothing on another", () => {
  it("cannot claim another wedding's item", async () => {
    const { app } = buildApp();
    // A real, valid session — for the OTHER wedding's household.
    const foreign = await guestCookie(app, FOREIGN_FAMILY);
    const res = await claim(app, foreign, { quantity: 1 });
    expect(res.status).toBe(404);
    // The SAME code an unpublished or unentitled registry gives. The
    // family is checked BEFORE the item, so a holder of any valid cookie learns
    // neither whether this wedding has a list nor whether the item id they
    // guessed exists on it.
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
  });

  it("cannot release another wedding's claim", async () => {
    const { app } = buildApp();
    const local = await guestCookie(app);
    expect((await claim(app, local, { quantity: 1 })).status).toBe(200);

    const foreign = await guestCookie(app, FOREIGN_FAMILY);
    const res = await release(app, foreign);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
    // The local household's claim is untouched.
    expect((await mine(app, local)).claims).toHaveLength(1);
  });

  it("cannot read another wedding's list at all", async () => {
    // The whole point of the gate: one leaked code must not open every couple's
    // list on the platform. The family is checked against the WEDDING, and the
    // failure is the same 404 an unpublished list gets — a distinct code would
    // confirm to any cookie-holder which weddings have a list.
    const { app } = buildApp();
    const foreign = await guestCookie(app, FOREIGN_FAMILY);
    const res = await appRequest(app, guestBase(), { headers: { Cookie: foreign } });
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: "registry_not_found" });
    // And the couple's own words are not in the body either.
    expect(raw).not.toContain("Your presence is the present.");
  });

  it("cannot read its own household on another wedding's slug either", async () => {
    // Answers the same 404 as an unpublished list, so no cookie-holder can
    // walk slugs and learn which weddings have a published gift list.
    const { app } = buildApp({ shippingAddress: "12 Wattle St, Fitzroy" });
    const local = await guestCookie(app);
    expect((await claim(app, local, { quantity: 1 })).status).toBe(200);

    const foreign = await guestCookie(app, FOREIGN_FAMILY);
    const res = await appRequest(app, `${guestBase()}/mine`, { headers: { Cookie: foreign } });
    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: "registry_not_found" });
    // And nothing of this wedding's household leaks in the body.
    expect(raw).not.toContain("12 Wattle St");
  });

  it("works the other way round too — the bootstrap cookie is useless next door", async () => {
    const { app } = buildApp();
    const local = await guestCookie(app);
    const res = await claim(app, local, { quantity: 1 }, OTHER_SLUG, OTHER_ITEM);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
  });
});

describe("GET /api/invite/:slug/registry/image/:name", () => {
  function plant(assets: ReturnType<typeof createAssetsStub>, key: string) {
    assets._store.set(key, { bytes: PNG.buffer.slice(0) as ArrayBuffer, contentType: "image/png" });
  }

  it("serves a published registry's image to anyone, no cookie", async () => {
    const { app, assets } = buildApp();
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);
    const res = await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Public bytes, but for an hour, not a year: no gate sees a browser's or a
    // proxy's copy again, so its lifetime is how long an unpublish takes to
    // reach it.
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("tells a Worker-cache hit the same hour the miss carried", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const { app, assets } = buildApp({ images });
      plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);

      const miss = await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`);
      expect(miss.headers.get("cache-control")).toBe("public, max-age=3600");
      const hit = await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`);
      expect(hit.status).toBe(200);
      // Served from the Worker cache: the transform ran once.
      expect(images.widths).toHaveLength(1);
      expect(hit.headers.get("cache-control")).toBe("public, max-age=3600");
    });
  });

  // Why the Worker's own copy may keep a year while the browser's may not: every
  // lookup in it runs after the gate, so each way the couple can withdraw an
  // image — the whole list, or the one gift that shows it — takes effect at once
  // over a warm Worker cache.
  const closings = [
    [
      "the list is unpublished",
      (db: ReturnType<typeof buildApp>["db"]) =>
        db
          .update(registrySettings)
          .set({ published: false })
          .where(eq(registrySettings.weddingId, BOOTSTRAP_WEDDING_ID))
          .run(),
    ],
    [
      "the wedding loses the entitlement",
      (db: ReturnType<typeof buildApp>["db"]) =>
        db
          .delete(weddingEntitlements)
          .where(
            and(
              eq(weddingEntitlements.weddingId, BOOTSTRAP_WEDDING_ID),
              eq(weddingEntitlements.entitlement, "registry"),
            ),
          )
          .run(),
    ],
    [
      // The list stays published: the gate checks that an item of this wedding
      // still names the image, not only that the list is open.
      "the gift is deleted",
      (db: ReturnType<typeof buildApp>["db"]) =>
        db.delete(registryItems).where(eq(registryItems.id, PAN)).run(),
    ],
  ] as const;

  for (const [label, close] of closings) {
    it(`stops serving the moment ${label}, though the Worker cache holds the bytes`, async () => {
      const cache = createCacheStub();
      await withCaches(cache.caches, async () => {
        const images = createImagesStub();
        const { app, assets, db } = buildApp({ images });
        plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);

        expect((await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`)).status).toBe(200);
        expect(cache.store.size).toBe(1);

        close(db);
        const res = await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`);
        expect(res.status).toBe(404);
        expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
        expect(cache.store.size).toBe(1);
      });
    });
  }

  it("refuses every name that is not a registry key, and never leaves the prefix", async () => {
    const { app, assets } = buildApp();
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);
    plant(assets, `assets/${OTHER_WEDDING_ID}/registry-secret`);
    // These reach the handler as one path segment and are refused by name.
    for (const name of [
      "..%2Fwed_other%2Fregistry-secret",
      "hero-1234",
      "registry-",
      "registry-abc.jpg",
    ]) {
      const res = await appRequest(app, `${guestBase()}/image/${name}`);
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
    }
    // These collapse in the URL parser before routing, so they match no route
    // at all — still 404, but the framework's, not ours.
    for (const name of [
      "../wed_other/registry-secret",
      "registry-secret/../../wed_other/registry-secret",
    ]) {
      expect((await appRequest(app, `${guestBase()}/image/${name}`)).status).toBe(404);
    }
    // Not simply refusing everything.
    expect((await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`)).status).toBe(200);
  });

  it("404s a listed name with no object behind it, same body as everything else", async () => {
    // The item names the image, so the gate passes and the R2 read is what
    // fails: the row outlived its object.
    const { app, db } = buildApp();
    db.update(registryItems)
      .set({ imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/registry-missing` })
      .where(eq(registryItems.id, BOWL))
      .run();
    const res = await appRequest(app, `${guestBase()}/image/registry-missing`);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
  });

  it("404s an object no item of this wedding names, though R2 still holds it", async () => {
    // A picture from a deleted gift waiting for the reconcile sweep, or a
    // well-formed name somebody guessed: the bytes exist, but no gift shows them.
    const { app, assets, db } = buildApp();
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/registry-orphan`);
    expect((await appRequest(app, `${guestBase()}/image/registry-orphan`)).status).toBe(404);

    // An item that names an image under ANOTHER wedding's prefix does not count
    // either: the key is rebuilt from this slug's wedding, and must match whole.
    // Both objects exist, so only the gate can refuse.
    plant(assets, `assets/${OTHER_WEDDING_ID}/registry-elsewhere`);
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/registry-elsewhere`);
    db.update(registryItems)
      .set({ imageKey: `assets/${OTHER_WEDDING_ID}/registry-elsewhere` })
      .where(eq(registryItems.id, BOWL))
      .run();
    const res = await appRequest(app, `${guestBase()}/image/registry-elsewhere`);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
  });

  it("404s this wedding's image when only another wedding's item names it", async () => {
    // The item check is scoped to the slug's wedding: a row of wedding B
    // holding wedding A's key opens nothing on A's list. Writes refuse such a
    // key already; this is the gate holding without them.
    const { app, assets, db } = buildApp();
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/registry-cross`);
    db.update(registryItems)
      .set({ imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/registry-cross` })
      .where(eq(registryItems.id, OTHER_ITEM))
      .run();
    const res = await appRequest(app, `${guestBase()}/image/registry-cross`);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "registry_not_found" });
  });

  it("stops serving a replaced picture's old name, over a warm Worker cache", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const { app, assets, db } = buildApp({ images: createImagesStub() });
      plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);
      expect((await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`)).status).toBe(200);

      // Saving a new picture mints a new name. The old object stays in R2 until
      // the sweep and in the Worker cache for a year; neither may answer for it.
      plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/registry-pan-new`);
      db.update(registryItems)
        .set({ imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/registry-pan-new` })
        .where(eq(registryItems.id, PAN))
        .run();

      expect((await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`)).status).toBe(404);
      expect((await appRequest(app, `${guestBase()}/image/registry-pan-new`)).status).toBe(200);
    });
  });

  it("revalidates with a 304 only after the gate, never instead of it", async () => {
    const { app, assets, db } = buildApp();
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);
    const url = `${guestBase()}/image/${PAN_IMAGE}`;
    const first = await appRequest(app, url);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);

    // The browser's hour ran out; it asks with the tag it holds.
    const again = { headers: { "If-None-Match": etag! } };
    const fresh = await appRequest(app, url, again);
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("cache-control")).toBe("public, max-age=3600");

    // The gift is withdrawn: the same question now gets the same 404 as
    // everything else, not a 304 telling the browser to keep the picture.
    db.delete(registryItems).where(eq(registryItems.id, PAN)).run();
    const gone = await appRequest(app, url, again);
    expect(gone.status).toBe(404);
    expect(await jsonBody(gone)).toEqual({ error: "registry_not_found" });
  });

  it("gates each request with one statement, through the image index", async () => {
    const { app, assets, db } = buildApp();
    plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);
    const statements = recordStatements(db);
    expect((await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`)).status).toBe(200);
    // Slug, entitlement, settings and item in one read: this route runs it on
    // every image request that reaches the Worker, dozens to a page.
    expect(statements).toHaveLength(1);
    // bun:sqlite's planner, not D1's, but the same engine: the item check is a
    // probe of `(wedding_id, image_key)`, not a walk of the wedding's items.
    const plan = (
      db.$client.query(`EXPLAIN QUERY PLAN ${statements[0]!.sql}`).all() as Array<{
        detail: string;
      }>
    )
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(
      /SEARCH registry_items USING (COVERING )?INDEX registry_items_wedding_image_idx \(wedding_id=\? AND image_key=\?\)/,
    );
    expect(plan).not.toMatch(/SCAN registry_items/);
  });

  it("ignores the client ?v= for cache keying — looping ?v= re-bills nothing (S-M1)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const { app, assets } = buildApp({ images });
      plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);

      const accept = { accept: "image/avif,image/webp,*/*" };
      const first = await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}?v=1`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(TRANSFORMED);
      expect(images.widths).toHaveLength(1);
      expect(cache.store.size).toBe(1);

      // The slug is public, so anyone can loop `?v=`. The version is derived from
      // the server-built key, so every one of these hits the SAME entry: the
      // Images binding — billed per call — never runs again.
      for (const v of [2, 3, 4, 5]) {
        const res = await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}?v=${v}`, {
          headers: accept,
        });
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(TRANSFORMED);
      }
      expect(images.widths).toHaveLength(1);
      expect(cache.store.size).toBe(1);
    });
  });

  it("keys the cache per image name, so two gifts never share one entry", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const { app, assets, db } = buildApp({ images });
      db.update(registryItems)
        .set({ imageKey: `assets/${BOOTSTRAP_WEDDING_ID}/registry-bowl` })
        .where(eq(registryItems.id, BOWL))
        .run();
      plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/${PAN_IMAGE}`);
      plant(assets, `assets/${BOOTSTRAP_WEDDING_ID}/registry-bowl`);

      await appRequest(app, `${guestBase()}/image/${PAN_IMAGE}`);
      await appRequest(app, `${guestBase()}/image/registry-bowl`);
      expect(cache.store.size).toBe(2);
    });
  });
});
