import { describe, it, expect, spyOn } from "bun:test";

import { BOOTSTRAP_WEDDING_ID } from "@cire/db";
import { DEV_OWNER_PROFILE_ID } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../src/app";
import type { AppOptions } from "../src/app";
import { createDb, seedDb } from "../src/db/setup";
import type { StripeClient } from "../src/services/stripe";
import { appRequest, jsonBody, recordStatements } from "./test-helpers";
import { captureLogs } from "./test-helpers/capture-logs";
import { seedOrganiserSession } from "./test-helpers/organiser-session";
import { makeOsnTestAuth } from "./test-helpers/osn-token";

// CORS + not-found behavior only — no DB rows needed.
const db = createDb(":memory:");
const app = createApp(db, {
  webOrigin: "http://localhost:4321",
  allowedOrigins: ["http://localhost:4321", "http://localhost:4322"],
  claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

// This is credentialed CORS on an auth API: echo the request origin verbatim
// when allowlisted, never `*`, and emit no header on mismatch.
describe("CORS", () => {
  it("echoes an allowlisted Origin verbatim with credentials", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { Origin: "http://localhost:4322", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4322");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("answers preflight with the requesting origin, never *", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4321",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4321");
  });

  it("omits Access-Control-Allow-Origin for a disallowed origin", async () => {
    const res = await appRequest(app, "/api/claim", {
      method: "POST",
      headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// The portals call this API cross-origin with credentials and a JSON body, so
// every non-GET they send is preflighted, and the browser refuses any method
// the preflight's `Access-Control-Allow-Methods` leaves out. The origins are
// the committed `WEB_ORIGIN` allowlists of both deployed tiers, split here with
// a copy of the split, trim and filter in `src/index.ts`.
const committedToml = await Bun.file(new URL("../wrangler.toml", import.meta.url)).text();
const deployedTiers = Bun.TOML.parse(committedToml) as {
  env: Record<"dev" | "production", { vars: { WEB_ORIGIN: string } }>;
};
const originsByTier = (["dev", "production"] as const).map((tier) =>
  deployedTiers.env[tier].vars.WEB_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const portalOrigins = originsByTier.flat();

// Stripe is configured so that every conditionally mounted route group is on
// the app and in `app.routes`. A preflight never reaches a handler, so no
// method here is ever called.
const unreached = () => Effect.die(new Error("a CORS preflight never calls Stripe"));
const unreachedStripe: StripeClient = {
  createAccount: unreached,
  createAccountLink: unreached,
  retrieveAccount: unreached,
  createCheckoutSession: unreached,
  retrieveCheckoutSession: unreached,
  createPlatformCheckoutSession: unreached,
  retrievePlatformCheckoutSession: unreached,
  expirePlatformCheckoutSession: unreached,
  retrievePrice: unreached,
};

const deployedApp = createApp(createDb(":memory:"), {
  webOrigin: portalOrigins[0],
  allowedOrigins: portalOrigins,
  stripe: unreachedStripe,
  stripeWebhookSecret: "whsec_test_connect",
  stripePlatformWebhookSecret: "whsec_test_platform",
});

const CHECKLIST_REORDER = "/api/organiser/weddings/w1/tasks/reorder";

function preflight(path: string, origin: string, method = "PATCH"): Promise<Response> {
  return appRequest(deployedApp, path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

function allowedMethods(res: Response): string[] {
  return (res.headers.get("Access-Control-Allow-Methods") ?? "")
    .split(",")
    .map((method) => method.trim())
    .filter(Boolean);
}

/** Every PATCH route the app mounts, with each path parameter filled in. */
const patchPaths = deployedApp.routes
  .filter((route) => route.method === "PATCH")
  .map((route) => route.path.replace(/:[^/]+/g, "x"));

describe("CORS preflight for the deployed portal origins", () => {
  it("reads an allowlist for each deployed tier", () => {
    for (const origins of originsByTier) expect(origins.length).toBeGreaterThan(0);
    expect(patchPaths.length).toBeGreaterThan(0);
  });

  it.each(portalOrigins)("allows a PATCH preflight from %s", async (origin) => {
    const res = await preflight(CHECKLIST_REORDER, origin);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(allowedMethods(res)).toContain("PATCH");
  });

  it.each(portalOrigins)("allows PATCH on every PATCH route from %s", async (origin) => {
    for (const path of patchPaths) {
      const res = await preflight(path, origin);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(allowedMethods(res)).toContain("PATCH");
    }
  });

  // No `Access-Control-Allow-Origin` is what makes the browser fail the
  // preflight. `Access-Control-Allow-Credentials` is a default header on every
  // response, so its presence here grants nothing.
  it("gives an unlisted origin's PATCH preflight no Access-Control-Allow-Origin", async () => {
    const res = await preflight(CHECKLIST_REORDER, "https://evil.example");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // The match is exact membership, the rule the origin guard applies: no
  // scheme stripping and no lookup that an object's inherited keys satisfy.
  it.each([
    `x://${portalOrigins[0]}`,
    "constructor",
    "__proto__",
    "toString",
    portalOrigins[0].replace("https://", "http://"),
    `${portalOrigins[0]}/`,
    portalOrigins[0].toUpperCase(),
  ])("gives a near-miss Origin %s no Access-Control-Allow-Origin", async (origin) => {
    const res = await preflight(CHECKLIST_REORDER, origin);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // Both directions come from what the app mounts (the CORS plugin's own
  // OPTIONS routes included), so the list can neither miss a method a route
  // answers nor carry one no route answers, and `*` matches nothing.
  it("allows exactly the methods mounted routes answer, never a wildcard", async () => {
    const res = await preflight(CHECKLIST_REORDER, portalOrigins[0]);
    const mounted = new Set(deployedApp.routes.map((route) => route.method));
    expect(allowedMethods(res).toSorted()).toEqual([...mounted].toSorted());
  });
});

describe("not-found handler", () => {
  it("returns the JSON 404 contract for unknown paths", async () => {
    const res = await appRequest(app, "/nope");
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "Not found" });
  });

  // `GET /api/primary-wedding` was a PUBLIC, unauthenticated read returning the
  // most-recently-created wedding's slug. On a multi-tenant product that let any
  // anonymous caller learn whose invite was newest, and made the guest bare
  // domain serve one arbitrary couple's invite. It was deleted rather than
  // rescoped — there is no correct single wedding to resolve.
  //
  // A removal made for a disclosure reason deserves a contract, not just an
  // absent file: a re-mount during a merge or revert would otherwise be silent.
  it("no longer serves the removed public primary-wedding lookup", async () => {
    const res = await appRequest(app, "/api/primary-wedding");
    expect(res.status).toBe(404);
  });
});

// Build an app whose DB is missing the tables the claim path touches, so the
// claim handler throws an unhandled defect (a SQLite "no such table" error)
// that reaches the `onError` boundary.
function brokenClaimApp(): ReturnType<typeof createApp> {
  const brokenDb = createDb(":memory:");
  // guest_account_links references guests/families, so it must be dropped
  // first — otherwise its dangling FK trips the later DROPs (foreign_keys=ON).
  brokenDb.run(sql`DROP TABLE guest_account_links`);
  brokenDb.run(sql`DROP TABLE rsvps`);
  brokenDb.run(sql`DROP TABLE guest_events`);
  brokenDb.run(sql`DROP TABLE guests`);
  brokenDb.run(sql`DROP TABLE sessions`);
  brokenDb.run(sql`DROP TABLE families`);
  return createApp(brokenDb, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
}

// Elysia's default error renderer would put `error.message` (D1 error
// strings, Effect causes) in the body; the onError hook must keep defects
// generic.
describe("unhandled errors", () => {
  it("returns a generic 500 body, not the internal error message", async () => {
    const res = await appRequest(brokenClaimApp(), "/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
    });
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "Internal error" });
  });

  // The structured error log must carry a NON-SENSITIVE identifier
  // (the Elysia `code` + the error `name`/`_tag`) but NEVER the free-form
  // `error.message` — `redact()` scrubs by object key, not by substring, so a
  // raw message echoing a D1 internal or guest input would land verbatim.
  it("logs the error name/code, not the raw error message", async () => {
    const out = await captureLogs(() =>
      appRequest(brokenClaimApp(), "/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
      }),
    );

    // This used to isolate our `onError` line out of the capture, because
    // Effect v3's *default* logger also emitted a separate DEBUG "Fiber
    // terminated…" stack dump. Two things changed under v4: `Logger.layer`
    // replaces the whole active set, so there is no default logger left to
    // emit that dump; and the local renderer is indented, so our own entry is
    // no longer one line and a line filter would only ever catch a fragment of
    // it. The whole capture IS our entry now — which makes the negative
    // assertion below strictly stronger, since nothing is filtered out of it.

    // The structured entry + the error NAME are present (triage signal).
    expect(out).toContain("unhandled request error");
    expect(out).toContain("name");
    // the error NAME survives: drizzle wraps a failed statement on both drivers
    expect(out).toContain("DrizzleQueryError");
    // The raw SQLite message (a D1-internal echo) must NOT appear anywhere —
    // "no such table: families" is exactly what would have leaked under the old
    // `message: error.message` log.
    expect(out).not.toContain("no such table");
  });
});

// The owner's rule for every route with a per-IP limiter: the limiter answers
// first, so a refused request costs no organiser session lookup, no OSN token
// verify (and so no JWKS fetch), no role-gate query and no guest session
// lookup. Each row builds the real app with only that route's limiter refusing
// and sends the credential that would otherwise cost the most: a live
// `cire_org_session` for the wedding's owner, whose lookup and gate query both
// show as statements, or a bearer token checked against a JWKS URL of the
// row's own, whose fetch the module's key cache cannot hide. The controls let
// the same request through and see that work happen, so a refused row cannot
// pass on a credential the route never read.
describe("a refused request does no credential work", () => {
  const refusing = { check: () => false };
  const allowing = { check: () => true };
  const W = BOOTSTRAP_WEDDING_ID;

  type LimiterOption =
    | "inviteLimiter"
    | "vendorPortalLimiter"
    | "handleSearchLimiter"
    | "weddingCreateLimiter"
    | "previewLimiter"
    | "remintLimiter";

  const routes: {
    name: string;
    method: string;
    path: string;
    limiter: LimiterOption;
    /** Whether a role gate reads `wedding_hosts` once the caller is known. */
    gated: boolean;
    body?: unknown;
  }[] = [
    {
      name: "GET …/invite",
      method: "GET",
      path: `/api/organiser/weddings/${W}/invite`,
      limiter: "inviteLimiter",
      gated: true,
    },
    {
      name: "PUT …/invite/text",
      method: "PUT",
      path: `/api/organiser/weddings/${W}/invite/text`,
      limiter: "inviteLimiter",
      gated: true,
      body: {},
    },
    {
      name: "POST …/invite/faqs",
      method: "POST",
      path: `/api/organiser/weddings/${W}/invite/faqs`,
      limiter: "inviteLimiter",
      gated: true,
      body: {},
    },
    {
      name: "GET /api/vendor/orgs",
      method: "GET",
      path: "/api/vendor/orgs",
      limiter: "vendorPortalLimiter",
      gated: false,
    },
    {
      name: "POST /api/vendor/claims/:token/consume",
      method: "POST",
      path: "/api/vendor/claims/no-such-claim/consume",
      limiter: "vendorPortalLimiter",
      gated: false,
      body: { orgId: "org_probe" },
    },
    {
      name: "GET /api/organiser/handle-search",
      method: "GET",
      path: "/api/organiser/handle-search?q=ab",
      limiter: "handleSearchLimiter",
      gated: false,
    },
    {
      name: "POST /api/organiser/weddings",
      method: "POST",
      path: "/api/organiser/weddings",
      limiter: "weddingCreateLimiter",
      gated: false,
      body: { displayName: "Probe" },
    },
    {
      name: "POST …/preview-code",
      method: "POST",
      path: `/api/organiser/weddings/${W}/preview-code`,
      limiter: "previewLimiter",
      gated: true,
    },
    {
      name: "POST …/remint",
      method: "POST",
      path: `/api/organiser/weddings/${W}/remint`,
      limiter: "remintLimiter",
      gated: true,
      body: {},
    },
    {
      name: "POST …/families/:familyId/mark-shared",
      method: "POST",
      path: `/api/organiser/weddings/${W}/families/fam_probe/mark-shared`,
      limiter: "remintLimiter",
      gated: true,
    },
  ];

  /** The seeded app, its database, and a live session for the wedding's owner. */
  async function organiserApp(limiter: LimiterOption, allowed: boolean, jwksUrl: string) {
    const seeded = createDb(":memory:");
    seedDb(seeded);
    const session = await seedOrganiserSession(seeded, DEV_OWNER_PROFILE_ID);
    // No `osnTestKey`: a bearer token is verified against `jwksUrl`.
    const options: AppOptions = { osnJwksUrl: jwksUrl };
    options[limiter] = allowed ? allowing : refusing;
    return { routeApp: createApp(seeded, options), routeDb: seeded, session };
  }

  function send(
    routeApp: ReturnType<typeof createApp>,
    route: (typeof routes)[number],
    headers: Record<string, string>,
  ) {
    return appRequest(routeApp, route.path, {
      method: route.method,
      headers:
        route.body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
    });
  }

  /** Runs `body` with `fetch` answering every call 503, and hands it the spy. */
  async function withFetchSpy(body: (fetches: ReturnType<typeof spyOn>) => Promise<void>) {
    const fetches = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    try {
      await body(fetches);
    } finally {
      fetches.mockRestore();
    }
  }

  const freshJwksUrl = () => `http://osn.test/${crypto.randomUUID()}/jwks.json`;

  for (const route of routes) {
    describe(route.name, () => {
      it("refuses an organiser session cookie before any query", async () => {
        const { routeApp, routeDb, session } = await organiserApp(
          route.limiter,
          false,
          freshJwksUrl(),
        );
        const statements = recordStatements(routeDb);
        const res = await send(routeApp, route, { cookie: `cire_org_session=${session}` });
        expect(res.status).toBe(429);
        expect(statements).toEqual([]);
      });

      it("control: let through, the cookie costs the session lookup and the gate", async () => {
        const { routeApp, routeDb, session } = await organiserApp(
          route.limiter,
          true,
          freshJwksUrl(),
        );
        const statements = recordStatements(routeDb);
        const res = await send(routeApp, route, { cookie: `cire_org_session=${session}` });
        expect(res.status).not.toBe(429);
        expect(statements[0]?.sql).toMatch(/from "organiser_sessions"/);
        if (route.gated) {
          expect(statements.slice(1).some((s) => /"wedding_hosts"/.test(s.sql))).toBe(true);
        }
      });

      it("refuses a bearer token before its keys are fetched", async () => {
        const auth = await makeOsnTestAuth();
        await withFetchSpy(async (fetches) => {
          const { routeApp, routeDb } = await organiserApp(route.limiter, false, freshJwksUrl());
          const statements = recordStatements(routeDb);
          const res = await send(routeApp, route, {
            Authorization: `Bearer ${await auth.sign(DEV_OWNER_PROFILE_ID)}`,
          });
          expect(res.status).toBe(429);
          expect(fetches).not.toHaveBeenCalled();
          expect(statements).toEqual([]);
        });
      });

      it("control: let through, the bearer token costs one fetch of its keys", async () => {
        const auth = await makeOsnTestAuth();
        await withFetchSpy(async (fetches) => {
          const jwksUrl = freshJwksUrl();
          const { routeApp } = await organiserApp(route.limiter, true, jwksUrl);
          const res = await send(routeApp, route, {
            Authorization: `Bearer ${await auth.sign(DEV_OWNER_PROFILE_ID)}`,
          });
          expect(res.status).toBe(401);
          expect(fetches).toHaveBeenCalledTimes(1);
          expect(String(fetches.mock.calls[0]?.[0])).toBe(jwksUrl);
        });
      });
    });
  }

  type GuestLimiterOption =
    | "rsvpLimiter"
    | "claimSessionLimiter"
    | "plusOneLimiter"
    | "registryContributeLimiter";

  const guestRoutes: {
    name: string;
    method: string;
    path: string;
    limiter: GuestLimiterOption;
    body?: unknown;
  }[] = [
    { name: "POST /api/rsvp", method: "POST", path: "/api/rsvp", limiter: "rsvpLimiter", body: {} },
    {
      name: "POST /api/claim/member",
      method: "POST",
      path: "/api/claim/member",
      limiter: "claimSessionLimiter",
      body: { guestId: "gst_probe" },
    },
    {
      name: "DELETE /api/claim/member",
      method: "DELETE",
      path: "/api/claim/member",
      limiter: "claimSessionLimiter",
    },
    {
      name: "PUT /api/plus-one/:guestId",
      method: "PUT",
      path: "/api/plus-one/gst_probe",
      limiter: "plusOneLimiter",
      body: {},
    },
    {
      name: "DELETE /api/plus-one/:guestId",
      method: "DELETE",
      path: "/api/plus-one/gst_probe",
      limiter: "plusOneLimiter",
    },
    {
      name: "POST /api/invite/:slug/registry/contribute",
      method: "POST",
      path: "/api/invite/cire-wedding/registry/contribute",
      limiter: "registryContributeLimiter",
      body: { amountMinor: 5000 },
    },
  ];

  /** A claimed guest's request to `route`, with only that route's limiter set. */
  async function guestRequest(route: (typeof guestRoutes)[number], allowed: boolean) {
    const guestDb = createDb(":memory:");
    seedDb(guestDb);
    const options: AppOptions = {
      stripe: unreachedStripe,
      // Its own claim budget, so the cookie below never meets a limit another
      // suite spent.
      claimLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    };
    options[route.limiter] = allowed ? allowing : refusing;
    const guestApp = createApp(guestDb, options);
    const claim = await appRequest(guestApp, "/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
    });
    const token = /cire_session=([^;]+)/.exec(claim.headers.get("set-cookie") ?? "")?.[1];
    expect(token).toBeTruthy();
    const statements = recordStatements(guestDb);
    const cookie = `cire_session=${token}`;
    const res = await appRequest(guestApp, route.path, {
      method: route.method,
      headers:
        route.body === undefined ? { cookie } : { cookie, "Content-Type": "application/json" },
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
    });
    return { res, statements };
  }

  for (const route of guestRoutes) {
    describe(route.name, () => {
      it("refuses a claimed guest's session cookie before any query", async () => {
        const { res, statements } = await guestRequest(route, false);
        expect(res.status).toBe(429);
        expect(statements).toEqual([]);
      });

      it("control: let through, the cookie costs the session lookup", async () => {
        const { res, statements } = await guestRequest(route, true);
        expect(res.status).not.toBe(429);
        expect(statements[0]?.sql).toMatch(/from "sessions"/);
      });
    });
  }
});
