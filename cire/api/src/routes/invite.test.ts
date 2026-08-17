import { describe, it, expect, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  weddings,
  weddingEntitlements,
  weddingHosts,
  weddingInviteCustomisations,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { DESIGNS } from "@cire/invite-designs";
import type { DesignMeta } from "@cire/invite-designs";
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

function buildApp(opts?: {
  inviteLimiter?: RateLimiterBackend;
  images?: ImagesBindingLike;
  inviteDesigns?: readonly DesignMeta[];
}) {
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
    inviteDesigns: opts?.inviteDesigns,
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
  detailsEyebrow: null,
  detailsHeading: null,
  welcomeMessage: null,
  footerMessage: null,
  inviteMessage: null,
});

async function authHeaders(profileId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await auth.sign(profileId)}` };
}

const orgBase = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/invite`;

/**
 * Claim a seeded household's code and return its `cire_session` cookie header.
 * The closing section's image is delivered only to a claimed session (S-H1), so
 * the serve tests need a real one rather than a hand-made token.
 */
async function guestCookie(
  app: ReturnType<typeof buildApp>["app"],
  publicId = "TESTONE-IVY-AA11",
): Promise<string> {
  const res = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = /cire_session=([^;]+)/.exec(setCookie)?.[1];
  expect(token).toBeTruthy();
  return `cire_session=${token}`;
}

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
    detailsEyebrow: null,
    detailsHeading: null,
    welcomeMessage: null,
    footerMessage: null,
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

  it("saves the details header + welcome greeting and surfaces them on the public read", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...payload,
        detailsEyebrow: "Join The Celebration",
        detailsHeading: "The Festivities",
        welcomeMessage: "  So happy you're here!  ", // trimmed on save
      }),
    });
    expect(put.status).toBe(200);

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      details: { eyebrow: string | null; heading: string | null };
      welcome: { message: string | null };
    };
    expect(body.details.eyebrow).toBe("Join The Celebration");
    expect(body.details.heading).toBe("The Festivities");
    expect(body.welcome.message).toBe("So happy you're here!");
  });

  it("reports null details/welcome copy for an uncustomised wedding (built-in defaults)", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      details: { eyebrow: string | null; heading: string | null };
      welcome: { message: string | null };
    };
    expect(body.details.eyebrow).toBeNull();
    expect(body.details.heading).toBeNull();
    expect(body.welcome.message).toBeNull();
  });

  /**
   * The 0057 registry copy columns. Written straight to the row because no write
   * path exists yet — `InviteTextBody` / `InviteThemeBody` have no field for
   * them, and adding one would change what the host portal PUTs. This pins the
   * READ half: the columns reach the guest payload, shaped like the other
   * section copy, and are NOT redacted (the section header is invite furniture,
   * same as details/story — the gift list itself lives behind its own gate).
   */
  it("surfaces the registry section copy + tone on the public read", async () => {
    const { app, db } = buildApp();
    db.insert(weddingInviteCustomisations)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        registryEyebrow: "Gifts",
        registryHeading: "Our Registry",
        registryBody: "Your presence is the present.",
        registryTone: "card",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: weddingInviteCustomisations.weddingId,
        set: {
          registryEyebrow: "Gifts",
          registryHeading: "Our Registry",
          registryBody: "Your presence is the present.",
          registryTone: "card",
        },
      })
      .run();

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      registry: { eyebrow: string | null; heading: string | null; body: string | null };
      theme: { tones: { registry: string | null } };
    };
    expect(body.registry).toEqual({
      eyebrow: "Gifts",
      heading: "Our Registry",
      body: "Your presence is the present.",
    });
    expect(body.theme.tones.registry).toBe("card");
  });

  it("reports null registry copy for a wedding that never set it", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as {
      registry: { eyebrow: string | null; heading: string | null; body: string | null };
    };
    expect(body.registry).toEqual({ eyebrow: null, heading: null, body: null });
  });

  it("saves the footer note (trimmed) and surfaces it on the ORGANISER read", async () => {
    const { app } = buildApp();
    const put = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, footerMessage: "  No boxed gifts please  " }),
    });
    expect(put.status).toBe(200);

    const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await org.json()) as { footer: { message: string | null } };
    expect(body.footer.message).toBe("No boxed gifts please");
  });

  // The delivery point for the closing section. Pinned here (beside the
  // redaction test below) so the pair reads as one contract: withheld from the
  // public payload, handed to a session that claimed a code.
  it("delivers the footer note in the claim response instead", async () => {
    const { app } = buildApp();
    await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, footerMessage: "No boxed gifts please" }),
    });

    const claimed = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
    });
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as { closing: { message: string | null } };
    expect(body.closing.message).toBe("No boxed gifts please");
  });

  // S-H1. The closing section is addressed to the invited household, so it is
  // delivered ONLY in the claim response. `GET /api/invite/:slug` is
  // unauthenticated — anything it returns is readable by anyone with the slug,
  // so the note must not be in it. Asserted on the RAW body, not a parsed field:
  // the point is that the string never crosses the wire.
  it("withholds the footer note from the unauthenticated public read", async () => {
    const { app } = buildApp();
    await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, footerMessage: "No boxed gifts please" }),
    });

    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const raw = await pub.text();
    expect(raw).not.toContain("No boxed gifts please");
    expect((JSON.parse(raw) as { footer: { message: null } }).footer.message).toBeNull();
    // The public shell (hero/story/welcome copy) is unaffected — it is public by
    // design and paints the invite before any code is entered.
    expect(raw).toContain("Anita & Ben");
  });

  // The footer note is the first copy field with NO built-in default: null must
  // survive to the guest site so it renders nothing, rather than falling back.
  it("reports a null footer note for an uncustomised wedding (segment hidden)", async () => {
    const { app } = buildApp();
    const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await org.json()) as { footer: { message: string | null } };
    expect(body.footer.message).toBeNull();
  });

  it("clears the footer note back to hidden when saved as whitespace", async () => {
    const { app } = buildApp();
    const headers = { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) };
    const set = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...payload, footerMessage: "See you there!" }),
    });
    expect(set.status).toBe(200);

    const clear = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...payload, footerMessage: "   " }),
    });
    expect(clear.status).toBe(200);

    const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await org.json()) as { footer: { message: string | null } };
    expect(body.footer.message).toBeNull();
  });

  it("rejects an over-long footer note with 400 (cap 300)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, footerMessage: "x".repeat(301) }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an exactly-at-cap footer note (300 chars)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, footerMessage: "x".repeat(300) }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an over-long welcome greeting with 400 (cap 300)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, welcomeMessage: "x".repeat(301) }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an exactly-at-cap welcome greeting (300 chars)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, welcomeMessage: "x".repeat(300) }),
    });
    expect(res.status).toBe(200);
  });

  // Per-field caps are arguments to the shared copyField factory — pin each new
  // field's specific cap so a transposed/typo'd limit can't slip through (T-S2).
  it("rejects an over-long details eyebrow with 400 (cap 80)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, detailsEyebrow: "x".repeat(81) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an over-long details heading with 400 (cap 160)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...payload, detailsHeading: "x".repeat(161) }),
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
        detailsEyebrow: null,
        detailsHeading: null,
        welcomeMessage: null,
        footerMessage: null,
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

  it("lets a VIEWER co-host read the invite but 403s their writes (read_only_role)", async () => {
    const { app, db } = buildApp();
    const VIEWER = "usr_invite_viewer";
    db.insert(weddingHosts)
      .values({
        id: "whost_invite_viewer",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: VIEWER,
        addedByOsnProfileId: BOOTSTRAP_OWNER,
        role: "viewer",
        createdAt: new Date(),
      })
      .run();

    const read = await appRequest(app, orgBase, { headers: await authHeaders(VIEWER) });
    expect(read.status).toBe(200);

    const write = await appRequest(app, `${orgBase}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(VIEWER)) },
      body: JSON.stringify({
        heroTitle: "Viewer edit",
        heroSubtitle: null,
        storyEyebrow: null,
        storyHeading: null,
        storyBody: null,
        detailsEyebrow: null,
        detailsHeading: null,
        welcomeMessage: null,
        footerMessage: null,
        inviteMessage: null,
      }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "read_only_role" });

    const image = await appRequest(app, `${orgBase.replace("/invite", "")}/invite/image/hero`, {
      method: "POST",
      headers: { "Content-Type": "image/png", ...(await authHeaders(VIEWER)) },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    expect(image.status).toBe(403);
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

  // Slot isolation. Until 0049 there were exactly two slots and the service
  // branched `slot === "hero" ? … : …` everywhere, so a third slot would have
  // been written into the story's columns. These pin each slot to its own.
  it("uploads a footer image, serves it, and surfaces it on the public read", async () => {
    const { app } = buildApp();

    const up = await appRequest(app, `${orgBase}/image/footer`, {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });
    expect(up.status).toBe(200);
    const { imageUrl } = (await up.json()) as { imageUrl: string };
    expect(imageUrl).toContain(`/api/invite/${SLUG}/image/footer`);

    const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await org.json()) as {
      footer: { imageUrl: string | null };
      story: { imageUrl: string | null };
      hero: { imageUrl: string | null };
    };
    expect(body.footer.imageUrl).toContain("/image/footer");
    // The footer's key must NOT have landed in a sibling slot's column.
    expect(body.story.imageUrl).toBeNull();
    expect(body.hero.imageUrl).toBeNull();

    // The bytes need a claimed session (S-H1) — see the gate tests below.
    const img = await appRequest(app, imageUrl, { headers: { Cookie: await guestCookie(app) } });
    expect(img.status).toBe(200);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    const del = await appRequest(app, `${orgBase}/image/footer`, {
      method: "DELETE",
      headers: await authHeaders(BOOTSTRAP_OWNER),
    });
    expect(del.status).toBe(200);
    const after = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    expect(((await after.json()) as { footer: { imageUrl: null } }).footer.imageUrl).toBeNull();
  });

  it("keeps the story image when the footer image is removed", async () => {
    const { app } = buildApp();
    const headers = await authHeaders(BOOTSTRAP_OWNER);

    for (const slot of ["story", "footer"]) {
      const up = await appRequest(app, `${orgBase}/image/${slot}`, {
        method: "POST",
        headers,
        body: PNG,
      });
      expect(up.status).toBe(200);
    }

    const del = await appRequest(app, `${orgBase}/image/footer`, { method: "DELETE", headers });
    expect(del.status).toBe(200);

    const pub = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await pub.json()) as {
      footer: { imageUrl: string | null };
      story: { imageUrl: string | null };
    };
    expect(body.footer.imageUrl).toBeNull();
    expect(body.story.imageUrl).toContain("/image/story");
  });

  it("saves a footer crop into the footer's own column, leaving the story's alone", async () => {
    const { app } = buildApp();
    const headers = await authHeaders(BOOTSTRAP_OWNER);
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1000, natH: 1000 };

    for (const slot of ["story", "footer"]) {
      await appRequest(app, `${orgBase}/image/${slot}`, { method: "POST", headers, body: PNG });
    }

    const put = await appRequest(app, `${orgBase}/image/footer/crop`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ crop }),
    });
    expect(put.status).toBe(200);

    const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await org.json()) as {
      footer: { imageCrop: typeof crop | null };
      story: { imageCrop: typeof crop | null };
    };
    expect(body.footer.imageCrop).toEqual(crop);
    expect(body.story.imageCrop).toBeNull();
  });

  // `mobile` is a hero-only second rectangle (0046). The footer renders at one
  // aspect, so it must be refused rather than silently written to its only crop.
  it("400s a mobile-screen crop on the footer slot", async () => {
    const { app } = buildApp();
    const headers = await authHeaders(BOOTSTRAP_OWNER);
    await appRequest(app, `${orgBase}/image/footer`, { method: "POST", headers, body: PNG });

    const res = await appRequest(app, `${orgBase}/image/footer/crop`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ crop: { x: 0, y: 0, w: 1, h: 1 }, screen: "mobile" }),
    });
    expect(res.status).toBe(400);
  });

  it("reports a null footer image for an uncustomised wedding", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
    const body = (await pub.json()) as {
      footer: { imageUrl: string | null; imageCrop: unknown };
    };
    expect(body.footer.imageUrl).toBeNull();
    expect(body.footer.imageCrop).toBeNull();
  });

  // ── S-H1: the closing motif is session-gated ──────────────────────────────
  it("404s the footer image without a claimed session", async () => {
    const { app } = buildApp();
    await appRequest(app, `${orgBase}/image/footer`, {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });

    // No cookie at all — the same 404 an absent image gives, so an unclaimed
    // visitor cannot even learn whether a closing image exists.
    const anon = await appRequest(app, `/api/invite/${SLUG}/image/footer`);
    expect(anon.status).toBe(404);

    // A garbage cookie is no better than none.
    const bogus = await appRequest(app, `/api/invite/${SLUG}/image/footer`, {
      headers: { Cookie: "cire_session=not-a-real-token" },
    });
    expect(bogus.status).toBe(404);
  });

  it("serves the footer image to a claimed session, marked private", async () => {
    const { app } = buildApp();
    await appRequest(app, `${orgBase}/image/footer`, {
      method: "POST",
      headers: await authHeaders(BOOTSTRAP_OWNER),
      body: PNG,
    });

    const res = await appRequest(app, `/api/invite/${SLUG}/image/footer`, {
      headers: { Cookie: await guestCookie(app) },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // No shared cache may keep a copy of session-gated bytes.
    expect(res.headers.get("cache-control")).toContain("private");
  });

  // The public slots must NOT have been dragged behind the gate — the hero and
  // story paint the invite shell before any code is entered.
  it("still serves hero and story images with no session, publicly cacheable", async () => {
    const { app } = buildApp();
    for (const slot of ["hero", "story"]) {
      await appRequest(app, `${orgBase}/image/${slot}`, {
        method: "POST",
        headers: await authHeaders(BOOTSTRAP_OWNER),
        body: PNG,
      });
      const res = await appRequest(app, `/api/invite/${SLUG}/image/${slot}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("public");
    }
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

  // Was `footer` until that became a real slot (0049) — any name outside
  // INVITE_IMAGE_SLOTS must still be rejected rather than silently mapped.
  it("400s for an unknown slot", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/image/banner`, {
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
    expect(img.headers.get("vary")).toBe("Accept, Origin"); // CROP-S-L1
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

      // Simulate a re-upload by advancing the wedding's stored `imagesUpdatedAt`
      // (what setImage bumps; migration 0029 made it the image cache version).
      // After the S-M1 fix the cache version is derived from this DB value (NOT
      // the client ?v=), so a bump must mint a fresh key — the new image can't
      // be served the stale cached transform.
      built.db
        .update(weddingInviteCustomisations)
        .set({ imagesUpdatedAt: new Date(Date.now() + 60_000) })
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

/** The theme block as the public invite endpoint returns it. */
interface ThemeShape {
  headingFont: string | null;
  bodyFont: string | null;
  headingSize: string | null;
  headingWeight: string | null;
  headingStyle: string | null;
  bodyWeight: string | null;
  bodyStyle: string | null;
  palettePreset: string | null;
  palette: {
    ground: string | null;
    card: string | null;
    ink: string | null;
    gilt: string | null;
    bloom: string | null;
  };
  tones: {
    hero: string | null;
    story: string | null;
    details: string | null;
    welcome: string | null;
    registry: string | null;
  };
}

describe("PUT /invite/theme (organiser)", () => {
  const validTheme = {
    headingFont: "cormorant",
    bodyFont: "system-sans",
    headingSize: "large",
    headingWeight: "bold",
    headingStyle: "italic",
    bodyWeight: null,
    bodyStyle: "normal",
    palettePreset: "jewel",
    paletteGround: "#1b172a",
    paletteCard: "oklch(25.5% 0.052 300)",
    paletteInk: null,
    paletteGilt: "rgb(212, 175, 55)",
    paletteBloom: null,
    heroTone: "ground",
    storyTone: "card",
    detailsTone: null,
    welcomeTone: "raised",
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
    const body = (await pub.json()) as { theme: ThemeShape };
    expect(body.theme.headingFont).toBe("cormorant");
    expect(body.theme.bodyFont).toBe("system-sans");
    expect(body.theme.palettePreset).toBe("jewel");
    // Each seed round-trips in the exact format the organiser picked — the API
    // stores the string, the guest site derives from it.
    expect(body.theme.palette.ground).toBe("#1b172a");
    expect(body.theme.palette.card).toBe("oklch(25.5% 0.052 300)");
    expect(body.theme.palette.gilt).toBe("rgb(212, 175, 55)");
    expect(body.theme.palette.ink).toBeNull();
    expect(body.theme.palette.bloom).toBeNull();
    expect(body.theme.tones).toEqual({
      hero: "ground",
      story: "card",
      details: null,
      welcome: "raised",
      // Not writable through `PUT /invite/theme` yet (0057's column has no
      // field on the total `InviteThemeBody`), so it reads back null even
      // after a full theme save.
      registry: null,
    });
    // Typography option keys (0048) round-trip as keys — the guest site
    // resolves them to CSS values, the API never stores a raw value.
    expect(body.theme.headingSize).toBe("large");
    expect(body.theme.headingWeight).toBe("bold");
    expect(body.theme.headingStyle).toBe("italic");
    expect(body.theme.bodyWeight).toBeNull();
    expect(body.theme.bodyStyle).toBe("normal");
  });

  it("defaults to a null theme when never customised", async () => {
    const { app } = buildApp();
    const pub = await appRequest(app, `/api/invite/${SLUG}`);
    const body = (await pub.json()) as { theme: ThemeShape };
    expect(body.theme.headingFont).toBeNull();
    expect(body.theme.palettePreset).toBeNull();
    // Every seed null ⇒ the guest site derives the built-in `evergreen` look.
    expect(body.theme.palette).toEqual({
      ground: null,
      card: null,
      ink: null,
      gilt: null,
      bloom: null,
    });
    expect(body.theme.tones).toEqual({
      hero: null,
      story: null,
      details: null,
      welcome: null,
      registry: null,
    });
    expect(body.theme.headingSize).toBeNull();
    expect(body.theme.headingWeight).toBeNull();
    expect(body.theme.headingStyle).toBeNull();
    expect(body.theme.bodyWeight).toBeNull();
    expect(body.theme.bodyStyle).toBeNull();
  });

  it("rejects a colour outside the allow-list with 400 (CSS-injection guard)", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({
        ...validTheme,
        // url() would be a CSS-injection / exfil vector if it ever reached a style.
        paletteGilt: "red; background:url(https://evil.example/x)",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a named colour (not in the allow-list) with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, paletteCard: "rebeccapurple" }),
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
      // Omits the tones (and everything after them) — the body is total, so this
      // must be a 400, not a partial update (guards against an accidental
      // Schema.optional refactor).
      body: JSON.stringify({
        headingFont: "default",
        bodyFont: "default",
        palettePreset: null,
        paletteGround: null,
        paletteCard: null,
        paletteInk: null,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown typography key with 400 (heading size, weight, style)", async () => {
    const { app } = buildApp();
    for (const patch of [
      { headingSize: "huge" },
      // A raw CSS value where a key belongs — the enum must reject it even
      // though it LOOKS like what the key resolves to.
      { headingWeight: "700" },
      { headingStyle: "oblique 14deg" },
      { bodyWeight: "semibold" },
      { bodyStyle: "italic; background:url(https://evil.example/x)" },
    ]) {
      const res = await appRequest(app, `${orgBase}/theme`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ ...validTheme, ...patch }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects an unknown section tone with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, heroTone: "banana" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown palette preset with 400", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, palettePreset: "not-a-preset" }),
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
        paletteGilt: `rgb(${" ".repeat(80)}0, 0, 0)`,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("does not persist a partially-valid body (one bad colour rejects the whole write)", async () => {
    const { app } = buildApp();
    const bad = await appRequest(app, `${orgBase}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
      body: JSON.stringify({ ...validTheme, paletteCard: "javascript:alert(1)" }),
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
    headingSize: null,
    headingWeight: null,
    headingStyle: null,
    bodyWeight: null,
    bodyStyle: null,
    palettePreset: null,
    paletteGround: null,
    paletteCard: null,
    paletteInk: null,
    paletteGilt: null,
    paletteBloom: null,
    heroTone: null,
    storyTone: null,
    detailsTone: null,
    welcomeTone: null,
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

  it("a copy-only save keeps the image URL version AND the transform cache warm (WT-P-I1)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const { app } = buildApp({ images });
      await uploadHero(app);
      const accept = { accept: "image/webp,*/*" };

      // Capture the image URL (?v=) and prime the transform cache.
      const before = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as {
        hero: { imageUrl: string };
      };
      const first = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(images.widths.length).toBe(1);
      expect(cache.store.size).toBe(1);

      // A copy-only save (bumps `updatedAt`, NOT `imagesUpdatedAt`)…
      const put = await appRequest(app, `${orgBase}/text`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: emptyText,
      });
      expect(put.status).toBe(200);

      // …must leave the image URL version unchanged (guests keep their browser
      // cache) and the next serve a cache HIT (no re-billed transform).
      const after = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as {
        hero: { imageUrl: string };
      };
      expect(after.hero.imageUrl).toBe(before.hero.imageUrl);

      const second = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero`, {
        headers: accept,
      });
      expect(second.status).toBe(200);
      expect(images.widths.length).toBe(1); // still exactly one transform
      expect(cache.store.size).toBe(1); // no new cache entry
    });
  });

  it("a colour/font-only theme save (heroBlur unchanged) keeps the transform cache warm (WT-P-I1)", async () => {
    const cache = createCacheStub();
    await withCaches(cache.caches, async () => {
      const images = createImagesStub();
      const { app } = buildApp({ images });
      await uploadHero(app);
      const accept = { accept: "image/webp,*/*" };

      const first = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero-bg`, {
        headers: accept,
      });
      expect(first.status).toBe(200);
      expect(images.widths.length).toBe(1);
      expect(cache.store.size).toBe(1);

      // Theme save with the SAME heroBlur (28, the seeded default) — colours
      // are pure CSS, so the served bytes are unchanged.
      const put = await appRequest(app, `${orgBase}/theme`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ ...validTheme, paletteGilt: "#d4af37" }),
      });
      expect(put.status).toBe(200);

      const second = await appRequest(app, `/api/invite/${SLUG}/image/hero?variant=hero-bg`, {
        headers: accept,
      });
      expect(second.status).toBe(200);
      expect(images.widths.length).toBe(1); // cache hit — binding not re-run
      expect(cache.store.size).toBe(1);
    });
  });

  describe("invite designId", () => {
    it("defaults to classic on the public invite", async () => {
      const { app } = buildApp();
      const res = await appRequest(app, `/api/invite/${SLUG}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { designId: string };
      expect(body.designId).toBe("classic");
    });

    it("defaults to classic on the organiser GET", async () => {
      const { app } = buildApp();
      const res = await appRequest(app, orgBase, {
        headers: await authHeaders(BOOTSTRAP_OWNER),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { designId: string };
      expect(body.designId).toBe("classic");
    });

    it("accepts gala from the real catalog and surfaces it on the public invite", async () => {
      const { app } = buildApp();
      const res = await appRequest(app, `${orgBase}/design`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders(BOOTSTRAP_OWNER)),
        },
        body: JSON.stringify({ designId: "gala" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { designId: string }).designId).toBe("gala");

      const publicRes = await appRequest(app, `/api/invite/${SLUG}`);
      expect(((await publicRes.json()) as { designId: string }).designId).toBe("gala");
    });
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

  describe("hero phone crop (migration 0046)", () => {
    const MOBILE_CROP = { x: 0.55, y: 0, w: 0.3, h: 0.9, natW: 4000, natH: 3000 };
    type HeroCrops = { hero: { imageCrop: unknown; imageCropMobile: unknown } };

    async function putCrop(
      app: ReturnType<typeof buildApp>["app"],
      body: Record<string, unknown>,
      slot = "hero",
    ) {
      return appRequest(app, `${orgBase}/image/${slot}/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify(body),
      });
    }

    it("saves the phone rectangle independently of the desktop one and surfaces both", async () => {
      const { app } = buildApp();
      await uploadHero(app);

      // Desktop rectangle via the pre-0046 body (no `screen`), phone via
      // `screen: "mobile"` — the two must not clobber each other.
      expect((await putCrop(app, { crop: VALID_CROP })).status).toBe(200);
      expect((await putCrop(app, { crop: MOBILE_CROP, screen: "mobile" })).status).toBe(200);

      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCrop).toEqual(VALID_CROP);
      expect(pub.hero.imageCropMobile).toEqual(MOBILE_CROP);

      // Organiser read (so the builder re-opens the saved phone crop) too.
      const org = await appRequest(app, orgBase, { headers: await authHeaders(BOOTSTRAP_OWNER) });
      const orgBody = (await org.json()) as HeroCrops;
      expect(orgBody.hero.imageCrop).toEqual(VALID_CROP);
      expect(orgBody.hero.imageCropMobile).toEqual(MOBILE_CROP);
    });

    it("screen: 'desktop' is an explicit spelling of the default rectangle", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      expect((await putCrop(app, { crop: VALID_CROP, screen: "desktop" })).status).toBe(200);
      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCrop).toEqual(VALID_CROP);
      expect(pub.hero.imageCropMobile).toBeNull();
    });

    it("crop: null with screen: 'mobile' resets only the phone rectangle", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      await putCrop(app, { crop: VALID_CROP });
      await putCrop(app, { crop: MOBILE_CROP, screen: "mobile" });

      expect((await putCrop(app, { crop: null, screen: "mobile" })).status).toBe(200);
      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCropMobile).toBeNull();
      // The desktop rectangle survives the phone reset.
      expect(pub.hero.imageCrop).toEqual(VALID_CROP);
    });

    it("rejects a phone crop on the story slot with 400 (hero-only)", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      const bad = await putCrop(app, { crop: VALID_CROP, screen: "mobile" }, "story");
      expect(bad.status).toBe(400);
    });

    it("rejects a phone crop on the event crop route with 400 (hero-only)", async () => {
      const { app } = buildApp();
      const bad = await appRequest(app, `${orgEventImagePath(EVENT_ID)}/crop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders(BOOTSTRAP_OWNER)) },
        body: JSON.stringify({ crop: VALID_CROP, screen: "mobile" }),
      });
      expect(bad.status).toBe(400);
    });

    it("rejects an unknown screen value with 400", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      const bad = await putCrop(app, { crop: VALID_CROP, screen: "tablet" });
      expect(bad.status).toBe(400);
    });

    it("rejects an out-of-range phone rectangle with 400 and never persists it", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      const bad = await putCrop(app, { crop: { x: 0.8, y: 0, w: 0.5, h: 0.5 }, screen: "mobile" });
      expect(bad.status).toBe(400);
      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCropMobile).toBeNull();
    });

    it("removing the hero image clears BOTH rectangles (no stale phone crop on re-upload)", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      await putCrop(app, { crop: VALID_CROP });
      await putCrop(app, { crop: MOBILE_CROP, screen: "mobile" });

      // The remove path is a separate UPDATE from the upload upsert — it must
      // clear the phone rectangle too, or a later re-upload would resurrect a
      // crop framed for a different photo.
      const del = await appRequest(app, `${orgBase}/image/hero`, {
        method: "DELETE",
        headers: await authHeaders(BOOTSTRAP_OWNER),
      });
      expect(del.status).toBe(200);

      await uploadHero(app);
      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCrop).toBeNull();
      expect(pub.hero.imageCropMobile).toBeNull();
    });

    it("re-uploading the hero clears BOTH rectangles", async () => {
      const { app } = buildApp();
      await uploadHero(app);
      await putCrop(app, { crop: VALID_CROP });
      await putCrop(app, { crop: MOBILE_CROP, screen: "mobile" });
      // A fresh upload frames a different photo → both crops reset to full.
      await uploadHero(app);
      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCrop).toBeNull();
      expect(pub.hero.imageCropMobile).toBeNull();
    });

    it("does not surface a phone crop when the hero has no image", async () => {
      const { app } = buildApp();
      const pub = (await (await appRequest(app, `/api/invite/${SLUG}`)).json()) as HeroCrops;
      expect(pub.hero.imageCropMobile).toBeNull();
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

// Test-only catalog: a second free design (so the happy path can change the
// stored value) and a premium design (so the dormant entitlement gate is
// exercised — the launch catalog is all-free).
const TEST_CATALOG = [
  ...DESIGNS,
  { id: "test-free", name: "Test Free", tier: "free" },
  { id: "test-premium", name: "Test Premium", tier: "premium" },
] as const satisfies readonly DesignMeta[];

describe("PUT /invite/design (organiser)", () => {
  const putDesign = (body: unknown) => ({
    method: "PUT" as const,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("401 without a token", async () => {
    const { app } = buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, putDesign({ designId: "classic" }));
    expect(res.status).toBe(401);
  });

  it("403 for a non-member", async () => {
    const { app } = buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...putDesign({ designId: "classic" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders("usr_someone_else")),
      },
    });
    expect(res.status).toBe(403);
  });

  it("400 for a malformed body", async () => {
    const { app } = buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...putDesign("{"),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(400);
  });

  it("422 for an unknown design id", async () => {
    const { app } = buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...putDesign({ designId: "not-a-design" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(422);
  });

  it("403 for a premium design without the entitlement", async () => {
    const { app } = buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...putDesign({ designId: "test-premium" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("premium_design");
  });

  it("saves a premium design when the wedding holds premium_templates", async () => {
    const { app, db } = buildApp({ inviteDesigns: TEST_CATALOG });
    // Grant the entitlement directly — columns match `weddingEntitlements`.
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "premium_templates",
        source: "comp",
        grantedAt: new Date(),
        grantedBy: "test-harness",
      })
      .run();
    const res = await appRequest(app, `${orgBase}/design`, {
      ...putDesign({ designId: "test-premium" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { designId: string };
    expect(body.designId).toBe("test-premium");
  });

  it("persists a free design and surfaces it on both GETs", async () => {
    const { app } = buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...putDesign({ designId: "test-free" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { designId: string }).designId).toBe("test-free");

    const organiserRes = await appRequest(app, orgBase, {
      headers: await authHeaders(BOOTSTRAP_OWNER),
    });
    expect(((await organiserRes.json()) as { designId: string }).designId).toBe("test-free");

    const publicRes = await appRequest(app, `/api/invite/${SLUG}`);
    expect(((await publicRes.json()) as { designId: string }).designId).toBe("test-free");
  });
});
