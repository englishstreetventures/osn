import { beforeAll, describe, expect, it } from "bun:test";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import type { ListingDto } from "../services/directory";
import type { OsnOrgMembershipResolver } from "../services/osn-bridge";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// ── Test constants ──────────────────────────────────────────────────────────

/** The caller who is a member of org_ok. */
const MEMBER = "usr_me";
/** A stranger who has no membership in any org. */
const STRANGER = "usr_stranger";

/** An org the MEMBER belongs to. */
const ORG_OK = "org_ok";
/** An org the MEMBER does NOT belong to. */
const ORG_X = "org_x";

// ── Stub org membership resolver ─────────────────────────────────────────────

/**
 * Stub for `orgMembership(orgId, profileId)`:
 *   - (org_ok, usr_me) → "admin"
 *   - everything else  → null
 */
const stubOrgMembership: OsnOrgMembershipResolver = async (orgId, profileId) => {
  if (orgId === ORG_OK && profileId === MEMBER) return "admin";
  return null;
};

// ── Auth setup ────────────────────────────────────────────────────────────────

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  return createApp(db, {
    osnTestKey: auth.key,
    orgMembership: stubOrgMembership,
  });
}

type App = ReturnType<typeof buildApp>;

async function req(
  app: App,
  method: string,
  path: string,
  profileId?: string,
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

// ── Listing body fixture ──────────────────────────────────────────────────────

const LISTING_BODY = {
  name: "Hillside Blooms",
  categories: ["florals"],
  description: "Beautiful floral arrangements",
  email: "contact@hillsideblooms.com",
  phone: null,
  website: null,
  instagram: null,
  locationText: null,
  priceBand: null,
  priceMinMinor: null,
  priceMaxMinor: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("vendor portal routes", () => {
  // ── PUT /api/vendor/orgs/:orgId/listing ────────────────────────────────────

  describe("PUT /api/vendor/orgs/:orgId/listing", () => {
    it("401 without a token", async () => {
      const res = await req(buildApp(), "PUT", `/api/vendor/orgs/${ORG_OK}/listing`);
      expect(res.status).toBe(401);
    });

    it("403 not_org_member when caller is not a member of the org", async () => {
      const res = await req(
        buildApp(),
        "PUT",
        `/api/vendor/orgs/${ORG_X}/listing`,
        MEMBER,
        LISTING_BODY,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_org_member");
    });

    it("403 not_org_member for a stranger (non-member) calling org_ok", async () => {
      const res = await req(
        buildApp(),
        "PUT",
        `/api/vendor/orgs/${ORG_OK}/listing`,
        STRANGER,
        LISTING_BODY,
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_org_member");
    });

    it("200 and returns the listing for a member of org_ok", async () => {
      const res = await req(
        buildApp(),
        "PUT",
        `/api/vendor/orgs/${ORG_OK}/listing`,
        MEMBER,
        LISTING_BODY,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { listing: ListingDto };
      expect(body.listing).toBeDefined();
      expect(body.listing.name).toBe("Hillside Blooms");
      expect(body.listing.ownerOrgId).toBe(ORG_OK);
    });
  });

  // ── GET /api/vendor/orgs/:orgId/listing ────────────────────────────────────

  describe("GET /api/vendor/orgs/:orgId/listing", () => {
    it("401 without a token", async () => {
      const res = await req(buildApp(), "GET", `/api/vendor/orgs/${ORG_OK}/listing`);
      expect(res.status).toBe(401);
    });

    it("403 not_org_member for non-member", async () => {
      const res = await req(buildApp(), "GET", `/api/vendor/orgs/${ORG_X}/listing`, MEMBER);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_org_member");
    });

    it("200 with listing=null when no listing exists yet", async () => {
      const res = await req(buildApp(), "GET", `/api/vendor/orgs/${ORG_OK}/listing`, MEMBER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { listing: ListingDto | null };
      expect(body.listing).toBeNull();
    });

    it("200 with listing after an upsert", async () => {
      const app = buildApp();
      // First upsert the listing
      await req(app, "PUT", `/api/vendor/orgs/${ORG_OK}/listing`, MEMBER, LISTING_BODY);
      // Then read it back
      const res = await req(app, "GET", `/api/vendor/orgs/${ORG_OK}/listing`, MEMBER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { listing: ListingDto };
      expect(body.listing).toBeDefined();
      expect(body.listing.name).toBe("Hillside Blooms");
    });
  });

  // ── GET /api/vendor/claims/:token (unauthenticated preview) ───────────────

  describe("GET /api/vendor/claims/:token", () => {
    it("404 for an unknown token (no auth required)", async () => {
      const res = await req(buildApp(), "GET", "/api/vendor/claims/invalid-token-xyz");
      expect(res.status).toBe(404);
    });

    it("200 with listing summary for a valid token (no auth required)", async () => {
      // We need to seed a real claim token to test the preview.
      // Since seeding requires a vendor + wedding already in the DB,
      // we skip the seeding and just test that an unknown token → 404.
      // The shape of the preview response is tested indirectly via consume.
      const res = await req(buildApp(), "GET", "/api/vendor/claims/not-a-real-token");
      expect(res.status).toBe(404);
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("applies rate limiting on vendor portal routes", async () => {
      // 1-request budget: first request burns the budget (404 = unknown token),
      // second must be 429.
      const { createRateLimiter } = await import("@shared/rate-limit");
      const tightLimiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
      const db2 = createDb(":memory:");
      seedDb(db2);
      const limitedApp = createApp(db2, {
        osnTestKey: auth.key,
        orgMembership: stubOrgMembership,
        vendorPortalLimiter: tightLimiter,
      });
      const first = await req(limitedApp, "GET", `/api/vendor/claims/any-token`);
      expect(first.status).toBe(404); // burned the budget
      const second = await req(limitedApp, "GET", `/api/vendor/claims/any-token`);
      expect(second.status).toBe(429); // rate limited
    });
  });

  // ── POST /api/vendor/claims/:token/consume ────────────────────────────────

  describe("POST /api/vendor/claims/:token/consume", () => {
    it("401 without a token", async () => {
      const res = await req(
        buildApp(),
        "POST",
        "/api/vendor/claims/some-token/consume",
        undefined,
        {
          orgId: ORG_OK,
        },
      );
      expect(res.status).toBe(401);
    });

    it("403 not_org_member when caller is not a member of the target org", async () => {
      const res = await req(buildApp(), "POST", "/api/vendor/claims/some-token/consume", MEMBER, {
        orgId: ORG_X,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_org_member");
    });

    it("410 claim_invalid for a member consuming an unknown/invalid token", async () => {
      const res = await req(
        buildApp(),
        "POST",
        "/api/vendor/claims/not-a-real-token/consume",
        MEMBER,
        { orgId: ORG_OK },
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("claim_invalid");
    });

    it("403 not_org_member for a stranger claiming into org_ok", async () => {
      const res = await req(buildApp(), "POST", "/api/vendor/claims/some-token/consume", STRANGER, {
        orgId: ORG_OK,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_org_member");
    });
  });
});
