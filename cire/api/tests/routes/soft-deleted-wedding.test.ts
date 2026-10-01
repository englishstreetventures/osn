import { beforeAll, describe, expect, it } from "bun:test";

import {
  directoryVendors,
  families,
  registryClaims,
  registryContributions,
  rsvps,
  vendorClaims,
  vendorEnquiries,
  weddings,
} from "@cire/db";
import { hashToken } from "@shared/crypto/tokens";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import type { AppOptions } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { createAssetsStub } from "../../src/services/invite-assets";
import type { OsnOrgSummary } from "../../src/services/osn-bridge";
import type { StripeClient } from "../../src/services/stripe";
import type { ZapChatClient } from "../../src/services/zap-bridge";
import { appRequest, jsonBody } from "../test-helpers";
import {
  fullWeddingCode,
  fullWeddingKeys,
  fullWeddingStatements,
} from "../test-helpers/full-wedding";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * The route net for soft-deleted weddings.
 *
 * WHAT IT CATCHES
 *  - Organiser prefix: every mounted `/api/organiser/weddings/:weddingId…`
 *    route except the owners' restore must answer a deleted wedding with the
 *    gate's own body, `{ error: "wedding_not_found" }`, not merely a 404 (a
 *    sub-resource answers 404 on its own). A new route under that prefix that
 *    forgets its gate fails here.
 *  - Everything else: every other mounted route must be listed, either in
 *    `REQUESTS` (it reaches a wedding: run against a live wedding, where it must
 *    reach the data, and against a deleted one, where it must refuse and change
 *    nothing) or in `NOT_WEDDING_SCOPED` with a reason. A new route in neither
 *    fails here by name.
 *
 * WHAT IT DOES NOT CATCH
 *  - Whether a `NOT_WEDDING_SCOPED` reason is true: that is the author's call.
 *  - A new code path inside a route already listed.
 *  - Crons, webhooks, emails and service fan-out, which are not routes: their
 *    own unit tests hold them (`tests/services/soft-delete-chokepoints.test.ts`,
 *    `tests/services/wedding-purge.test.ts`, the webhook route tests).
 */

const WID = "wed_net";
const SLUG = `slug-${WID}`;
const OWNER = `usr_owner_${WID}`;
const CODE = fullWeddingCode(WID);
const GUEST = `gst_${WID}`;
const EVENT = `evt_${WID}`;
const ITEM = `ritem_${WID}`;
const ENQUIRY = `enq_${WID}`;
const LISTING = `dv_${WID}`;
const VENDOR_PROFILE = "usr_vendor";
const ORG = "org_vendor";
const UNCLAIMED_LISTING = "dv_unclaimed";
const BUFFERED_ENQUIRY = "enq_buffered";
const CLAIM_TOKEN = "claim-token-for-the-net";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** Every limiter the app takes, each fresh and far above anything a walk sends. */
const LIMITER_OPTIONS = [
  "claimLimiter",
  "claimSessionLimiter",
  "accountLinkLimiter",
  "exportLimiter",
  "inviteLimiter",
  "previewLimiter",
  "weddingCreateLimiter",
  "remintLimiter",
  "hostLimiter",
  "weddingLifecycleLimiter",
  "handleSearchLimiter",
  "cspReportLimiter",
  "vendorPortalLimiter",
  "directoryLimiter",
  "oidcStartLimiter",
  "oidcSessionLimiter",
  "internalRevokeLimiter",
  "digestStopLimiter",
  "enquiryLimiter",
  "registryPreviewLimiter",
  "registryImageLimiter",
  "registryGuestLimiter",
  "rsvpLimiter",
  "plusOneLimiter",
  "registryContributeLimiter",
  "upgradeLimiter",
  "registryStripeLimiter",
] as const satisfies readonly (keyof AppOptions)[];

const freshLimiters = (): Partial<AppOptions> =>
  Object.fromEntries(
    LIMITER_OPTIONS.map((name) => [
      name,
      createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    ]),
  );

// Stripe is configured so every conditionally mounted route is on the app. The
// net never needs a Stripe answer; a call that reaches it is a defect (a 500).
const unreached = () => Effect.die(new Error("the route net never calls Stripe"));
const stripe: StripeClient = {
  createAccount: unreached,
  createAccountLink: unreached,
  retrieveAccount: unreached,
  createCheckoutSession: unreached,
  retrieveCheckoutSession: unreached,
  createPlatformCheckoutSession: unreached,
  retrievePlatformCheckoutSession: unreached,
  retrievePrice: unreached,
};

type Fixture = {
  db: TestDb;
  app: ReturnType<typeof createApp>;
  cookie: string;
  zapCalls: string[];
};

/**
 * One wedding with a row in every child table, a vendor in the org that owns
 * its enquiry's listing, a second unclaimed listing with a buffered enquiry and
 * a live claim token, the asset objects its rows name, and a guest who claimed
 * their code. `deleted` soft-deletes it after the claim, as an owner would.
 */
async function fixture(deleted: boolean): Promise<Fixture> {
  const db = createDb(":memory:");
  for (const statement of fullWeddingStatements(WID)) db.run(statement);
  const now = new Date();
  db.update(directoryVendors)
    .set({ ownerOrgId: ORG })
    .where(eq(directoryVendors.id, LISTING))
    .run();
  db.update(vendorEnquiries)
    .set({ status: "open", zapChatId: "chat_existing" })
    .where(eq(vendorEnquiries.id, ENQUIRY))
    .run();
  db.insert(directoryVendors)
    .values({ id: UNCLAIMED_LISTING, name: "Unclaimed", createdAt: now, updatedAt: now })
    .run();
  db.insert(vendorEnquiries)
    .values({
      id: BUFFERED_ENQUIRY,
      weddingId: WID,
      directoryVendorId: UNCLAIMED_LISTING,
      vendorId: `ven_${WID}`,
      createdBy: OWNER,
      status: "open",
      pendingBody: "Are you free in June?",
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(vendorClaims)
    .values({
      id: "vclaim_net",
      directoryVendorId: UNCLAIMED_LISTING,
      tokenHash: await Effect.runPromise(hashToken(CLAIM_TOKEN)),
      email: "vendor@example.test",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    })
    .run();

  const zapCalls: string[] = [];
  const zap: ZapChatClient = {
    provisionC2bChat: async () => {
      zapCalls.push("provision");
      return { chatId: "chat_new" };
    },
    sendC2bMessage: async () => {
      zapCalls.push("send");
      return { messageId: "msg_1", createdAt: Date.now() };
    },
    listC2bMessages: async () => {
      zapCalls.push("list");
      return { messages: [] };
    },
  };
  const assets = createAssetsStub();
  for (const key of fullWeddingKeys(WID).assets) {
    await assets.put(key, new Uint8Array([137, 80, 78, 71]), {
      httpMetadata: { contentType: "image/png" },
    });
  }

  const app = createApp(db, {
    ...freshLimiters(),
    osnTestKey: auth.key,
    stripe,
    stripeWebhookSecret: "whsec_net",
    stripePlatformWebhookSecret: "whsec_net_platform",
    assets,
    enquiryZapClient: zap,
    orgMembership: async (orgId, profileId) =>
      orgId === ORG && profileId === VENDOR_PROFILE ? "member" : null,
    profileOrgs: async (profileId) =>
      profileId === VENDOR_PROFILE ? [{ id: ORG } as unknown as OsnOrgSummary] : [],
  });

  const claimed = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId: CODE }),
  });
  expect(claimed.status).toBe(200);
  const cookie = `cire_session=${parseSessionToken(claimed.headers.get("Set-Cookie"))}`;

  if (deleted) {
    db.update(weddings)
      .set({ deletedAt: now, deletedByOsnProfileId: OWNER })
      .where(eq(weddings.id, WID))
      .run();
  }
  return { db, app, cookie, zapCalls };
}

/** What a request against a deleted wedding must not change. */
function snapshot(f: Fixture): string {
  const { db } = f;
  return JSON.stringify({
    opened: db.select({ id: families.id, at: families.firstOpenedAt }).from(families).all(),
    rsvps: db.select().from(rsvps).all(),
    claims: db.select().from(registryClaims).all(),
    gifts: db.select().from(registryContributions).all(),
    enquiries: db.select().from(vendorEnquiries).all(),
    zap: f.zapCalls,
  });
}

async function send(
  f: Fixture,
  method: string,
  path: string,
  opts: { cookie?: boolean; as?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = f.cookie;
  if (opts.as) headers.Authorization = `Bearer ${await auth.sign(opts.as)}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return appRequest(f.app, path, init);
}

type Row = {
  request: (f: Fixture) => Promise<Response>;
  /** Against the live wedding: proof the fixture reaches the data. */
  live: (res: Response, f: Fixture) => Promise<void> | void;
  /** Against the soft-deleted wedding: the refusal. */
  deleted: (res: Response, f: Fixture) => Promise<void> | void;
};

const status = (code: number) => (res: Response) => {
  expect(res.status).toBe(code);
};
/** Past the session or code check: whatever the route then answers. */
const pastTheGate = (refusal: number) => (res: Response) => {
  expect(res.status).not.toBe(refusal);
  expect(res.status).toBeLessThan(500);
};
const body = (code: number, expected: unknown) => async (res: Response) => {
  expect(res.status).toBe(code);
  expect(await jsonBody(res)).toEqual(expected as never);
};
const UNAUTHORIZED = body(401, { error: "Unauthorized" });

/** Every route that can reach a wedding outside the organiser prefix. */
const REQUESTS: Record<string, Row> = {
  "POST /api/claim/": {
    request: (f) => send(f, "POST", "/api/claim", { body: { publicId: CODE } }),
    live: status(200),
    deleted: body(401, { error: "Invalid credentials" }),
  },
  "GET /api/claim/session": {
    request: (f) => send(f, "GET", `/api/claim/session?slug=${SLUG}`, { cookie: true }),
    live: status(200),
    deleted: async (res) => {
      await UNAUTHORIZED(res);
      // Refused, not revoked: the cookie survives for a restore.
      expect(res.headers.get("Set-Cookie")).toBeNull();
    },
  },
  "POST /api/rsvp/": {
    request: (f) =>
      send(f, "POST", "/api/rsvp", {
        cookie: true,
        body: { rsvps: [{ guestId: GUEST, eventId: EVENT, status: "declined" }] },
      }),
    live: status(200),
    deleted: UNAUTHORIZED,
  },
  "PUT /api/plus-one/:guestId": {
    request: (f) =>
      send(f, "PUT", `/api/plus-one/${GUEST}`, { cookie: true, body: { firstName: "Bo" } }),
    live: pastTheGate(401),
    deleted: UNAUTHORIZED,
  },
  "DELETE /api/plus-one/:guestId": {
    request: (f) => send(f, "DELETE", `/api/plus-one/${GUEST}`, { cookie: true }),
    live: pastTheGate(401),
    deleted: UNAUTHORIZED,
  },
  "GET /api/invite/:slug": {
    request: (f) => send(f, "GET", `/api/invite/${SLUG}`),
    live: status(200),
    deleted: status(404),
  },
  "GET /api/invite/:slug/image/:slot": {
    request: (f) => send(f, "GET", `/api/invite/${SLUG}/image/hero`),
    live: status(200),
    deleted: status(404),
  },
  "GET /api/invite/:slug/event/:eventId/image": {
    request: (f) => send(f, "GET", `/api/invite/${SLUG}/event/${EVENT}/image`),
    live: status(200),
    deleted: status(404),
  },
  "GET /api/invite/:slug/registry/image/:name": {
    request: (f) => send(f, "GET", `/api/invite/${SLUG}/registry/image/registry-1`),
    live: status(200),
    deleted: body(404, { error: "registry_not_found" }),
  },
  "GET /api/invite/:slug/registry": {
    request: (f) => send(f, "GET", `/api/invite/${SLUG}/registry`, { cookie: true }),
    live: status(200),
    deleted: UNAUTHORIZED,
  },
  "GET /api/invite/:slug/registry/mine": {
    request: (f) => send(f, "GET", `/api/invite/${SLUG}/registry/mine`, { cookie: true }),
    live: status(200),
    deleted: UNAUTHORIZED,
  },
  "POST /api/invite/:slug/registry/items/:itemId/claim": {
    request: (f) =>
      send(f, "POST", `/api/invite/${SLUG}/registry/items/${ITEM}/claim`, {
        cookie: true,
        body: { quantity: 1 },
      }),
    live: pastTheGate(401),
    deleted: UNAUTHORIZED,
  },
  "DELETE /api/invite/:slug/registry/items/:itemId/claim": {
    request: (f) =>
      send(f, "DELETE", `/api/invite/${SLUG}/registry/items/${ITEM}/claim`, { cookie: true }),
    live: pastTheGate(401),
    deleted: UNAUTHORIZED,
  },
  "POST /api/invite/:slug/registry/contribute": {
    request: (f) =>
      send(f, "POST", `/api/invite/${SLUG}/registry/contribute`, {
        cookie: true,
        body: { amountMinor: 5_000 },
      }),
    live: pastTheGate(401),
    deleted: UNAUTHORIZED,
  },
  "DELETE /api/account/link/:guestId": {
    request: (f) => send(f, "DELETE", `/api/account/link/${GUEST}`, { cookie: true }),
    live: pastTheGate(401),
    deleted: UNAUTHORIZED,
  },
  "POST /api/account/link/": {
    request: (f) =>
      send(f, "POST", "/api/account/link", {
        cookie: true,
        as: "usr_guest_account",
        body: { guestId: GUEST },
      }),
    // The feature flag is off here: its 503 is answered only once both the
    // guest session and the OSN token have passed.
    live: body(503, { error: "Account linking is not available" }),
    deleted: status(401),
  },
  "GET /api/vendor/enquiries": {
    request: (f) => send(f, "GET", "/api/vendor/enquiries", { as: VENDOR_PROFILE }),
    live: async (res) => {
      expect(res.status).toBe(200);
      const { enquiries } = (await jsonBody(res)) as { enquiries: { id: string }[] };
      expect(enquiries.map((e) => e.id)).toContain(ENQUIRY);
    },
    deleted: async (res) => {
      expect(res.status).toBe(200);
      const { enquiries } = (await jsonBody(res)) as { enquiries: { id: string }[] };
      expect(enquiries.map((e) => e.id)).not.toContain(ENQUIRY);
    },
  },
  "GET /api/vendor/enquiries/:id/messages": {
    request: (f) =>
      send(f, "GET", `/api/vendor/enquiries/${ENQUIRY}/messages`, { as: VENDOR_PROFILE }),
    live: status(200),
    deleted: status(404),
  },
  "POST /api/vendor/enquiries/:id/messages": {
    request: (f) =>
      send(f, "POST", `/api/vendor/enquiries/${ENQUIRY}/messages`, {
        as: VENDOR_PROFILE,
        body: { message: "We are free." },
      }),
    live: status(201),
    deleted: status(404),
  },
  "POST /api/vendor/enquiries/:id/quote": {
    request: (f) =>
      send(f, "POST", `/api/vendor/enquiries/${ENQUIRY}/quote`, {
        as: VENDOR_PROFILE,
        body: { amountMinor: 120_000 },
      }),
    live: status(201),
    deleted: status(404),
  },
  "POST /api/vendor/claims/:token/consume": {
    request: (f) =>
      send(f, "POST", `/api/vendor/claims/${CLAIM_TOKEN}/consume`, {
        as: VENDOR_PROFILE,
        body: { orgId: ORG },
      }),
    // Claiming the listing flushes the couple's buffered enquiry to Zap.
    live: (res, f) => {
      expect(res.status).toBe(200);
      expect(f.zapCalls).toContain("provision");
    },
    // The claim itself is the vendor's and succeeds; the deleted wedding's
    // enquiry is not sent and gets no chat.
    deleted: (res, f) => {
      expect(res.status).toBe(200);
      expect(f.zapCalls).toEqual([]);
    },
  },
};

/** Mounted routes that hold no wedding, or reach one by decision. */
const NOT_WEDDING_SCOPED: Record<string, string> = {
  "POST /api/csp-report/": "a browser's CSP report; names no wedding",
  "POST /internal/revoke-organiser-sessions": "revokes one OSN profile's organiser sessions",
  "GET /api/rsvp-digest/stop":
    "a signed, seat-scoped digest preference; harmless on a deleted wedding and kept for a restore",
  "POST /api/rsvp-digest/stop":
    "a signed, seat-scoped digest preference; harmless on a deleted wedding and kept for a restore",
  "GET /api/auth/oidc/start": "organiser sign-in",
  "GET /api/auth/oidc/callback": "organiser sign-in",
  "GET /api/auth/session": "organiser sign-in",
  "POST /api/auth/signout": "organiser sign-out",
  "POST /api/claim/signout": "revokes the presented guest token; signing out is always allowed",
  "GET /api/vendor/claims/:token": "reads a listing claim token, not a wedding",
  "GET /api/vendor/orgs": "a vendor's own orgs",
  "GET /api/vendor/orgs/:orgId/listing": "a vendor org's own listing",
  "PUT /api/vendor/orgs/:orgId/listing": "a vendor org's own listing",
  "POST /api/stripe/webhook":
    "money settles into a soft-deleted wedding by decision; tests/routes/stripe-webhook.test.ts",
  "POST /api/stripe/platform-webhook":
    "an upgrade settles into a soft-deleted wedding by decision; tests/routes/stripe-platform-webhook.test.ts",
  "GET /api/organiser/weddings":
    "the caller's own list; its live/deleted split is tests/services/weddings.test.ts",
  "POST /api/organiser/weddings": "creates a new wedding",
  "GET /api/organiser/handle-search": "profile autocomplete; names no wedding",
  "POST /api/organiser/weddings/:weddingId/restore":
    "the one organiser route that must reach a deleted wedding; tests/routes/wedding-lifecycle.test.ts",
};

const ORGANISER_PREFIX = "/api/organiser/weddings/:weddingId";

async function mountedRoutes(): Promise<{ method: string; path: string }[]> {
  const { app } = await fixture(false);
  return app.routes
    .filter((route) => route.method !== "OPTIONS")
    .map((route) => ({ method: route.method, path: route.path }));
}

describe("a soft-deleted wedding, across every mounted route", () => {
  it("has every route outside the organiser prefix classified, and no stale entry", async () => {
    const routes = await mountedRoutes();
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const unclassified = routes
      .filter(
        (r) => !(r.path.startsWith(ORGANISER_PREFIX) && r.path !== `${ORGANISER_PREFIX}/restore`),
      )
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !(key in REQUESTS) && !(key in NOT_WEDDING_SCOPED));
    expect(unclassified).toEqual([]);
    const stale = [...Object.keys(REQUESTS), ...Object.keys(NOT_WEDDING_SCOPED)].filter(
      (key) => !keys.has(key),
    );
    expect(stale).toEqual([]);
  });

  for (const [route, row] of Object.entries(REQUESTS)) {
    it(`${route}: reaches the live wedding, and refuses the deleted one changing nothing`, async () => {
      const live = await fixture(false);
      await row.live(await row.request(live), live);

      const gone = await fixture(true);
      const before = snapshot(gone);
      await row.deleted(await row.request(gone), gone);
      expect(snapshot(gone)).toBe(before);
    });
  }

  it("answers every organiser route but restore with the gate's wedding_not_found", async () => {
    const f = await fixture(true);
    const organiserRoutes = f.app.routes.filter(
      (route) =>
        route.method !== "OPTIONS" &&
        route.path.startsWith(ORGANISER_PREFIX) &&
        route.path !== `${ORGANISER_PREFIX}/restore`,
    );
    expect(organiserRoutes.length).toBeGreaterThan(90);
    const wrong: string[] = [];
    for (const route of organiserRoutes) {
      const path = route.path.replace(":weddingId", WID).replace(/:[^/]+/g, "x");
      // No body: a route that parses one itself must still meet the gate first.
      const res = await send(f, route.method, path, { as: OWNER });
      const answer = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
      if (
        res.status !== 404 ||
        (answer as { error?: string } | null)?.error !== "wedding_not_found"
      ) {
        wrong.push(`${route.method} ${route.path} → ${res.status} ${JSON.stringify(answer)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("lets the owner through the organiser routes while the wedding is live", async () => {
    // Control for the walk above: the same owner token on the live wedding is
    // not answered wedding_not_found by any gate.
    const f = await fixture(false);
    const settings = await send(f, "GET", `/api/organiser/weddings/${WID}/settings`, { as: OWNER });
    expect(settings.status).toBe(200);
  });
});
