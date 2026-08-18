import { accounts, organisationMembers, organisations, users } from "@osn/db/schema";
import { generateArcKeyPair } from "@shared/crypto";
import { createMemoryClient } from "@shared/redis";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { buildAppDeps } from "../src/build-deps";
import { osnLoggerLayer } from "../src/observability";
import { DEV_PRINCIPAL } from "../src/routes/auth/dev-login";
import { createTestLayerWithSqlite } from "./helpers/db";

/**
 * The dev sign-in bypass. Passkeys are the only primary login factor, which
 * makes a seeded fixture account unreachable: nobody can enrol a WebAuthn
 * credential for a row a seed script wrote. `GET|POST /dev/login` mints a real
 * OSN session for that fixture so the whole OIDC chain downstream (organiser
 * portal, vendor portal, `@osn/social`) runs untouched.
 *
 * It is gated twice and both gates must hold:
 *  - tier — `local` or `dev` only, derived from the request-scoped env record
 *    the same way `includeOpenapiPlugin` is, and failing closed on a tier
 *    string neither parser recognises;
 *  - secret — `DEV_LOGIN_SECRET`, key-optional: unset ⇒ the routes are never
 *    mounted, so the surface is a 404 rather than a 401 that admits it exists.
 */

let privB64 = "";
let pubB64 = "";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  privB64 = b64(await exportJWK(privateKey));
  pubB64 = b64(await exportJWK(publicKey));
});

const SECRET = "d".repeat(32);

/**
 * `return_to` targets. Its own var — NOT the CORS allowlist, which also feeds
 * the CSRF origin guard, so a redirect target added there would widen that
 * guard for every route.
 */
const RETURN_ORIGINS = "http://localhost:4322,http://localhost:4326";

/** An origin the local CORS fallback allows, so a POST clears the origin guard. */
const ALLOWED_ORIGIN = "http://localhost:1422";

/** A deployed env that satisfies every non-local guard, so the tier is what varies. */
const deployedEnv = (osnEnv: string): Record<string, string> => ({
  OSN_ENV: osnEnv,
  OSN_ISSUER_URL: "https://api.osn.test",
  OSN_ORIGIN: "https://api.osn.test",
  OSN_CORS_ORIGIN: "https://app.osn.test",
  OSN_RP_ID: "osn.test",
  OSN_JWT_PRIVATE_KEY: privB64,
  OSN_JWT_PUBLIC_KEY: pubB64,
  OSN_SESSION_IP_PEPPER: "x".repeat(32),
  OSN_PAIRWISE_SALT: "p".repeat(32),
});

async function build(env: Record<string, string | undefined>) {
  const { layer, db } = createTestLayerWithSqlite();
  const built = await buildAppDeps(env, {
    redisClient: createMemoryClient(),
    dbAndEmailLayer: layer,
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
  });
  return { deps: built.deps, app: createApp(built.deps), db };
}

const get = (path: string) => new Request(`http://localhost${path}`);

const post = (path: string, body: unknown, origin: string | null = ALLOWED_ORIGIN) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });

const devLogin = (secret: string, returnTo?: string) =>
  get(
    `/dev/login?secret=${secret}` + (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""),
  );

describe("dev-login gate", () => {
  it("derives the config from the env record, not process.env", async () => {
    const local = await build({ DEV_LOGIN_SECRET: SECRET });
    const prod = await build({ ...deployedEnv("production"), DEV_LOGIN_SECRET: SECRET });
    expect(local.deps.devLogin).not.toBeNull();
    expect(prod.deps.devLogin).toBeNull();
  });

  it("is absent when DEV_LOGIN_SECRET is unset, even on local", async () => {
    const { deps, app } = await build({});
    expect(deps.devLogin).toBeNull();
    const res = await app.handle(get("/dev/login"));
    expect(res.status).toBe(404);
  });

  it("mounts on local (an absent OSN_ENV reads as local)", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(get(`/dev/login?secret=${SECRET}`));
    expect(res.status).toBe(200);
  });

  it("mounts on the dev tier", async () => {
    const { app } = await build({ ...deployedEnv("dev"), DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(get(`/dev/login?secret=${SECRET}`));
    expect(res.status).toBe(200);
  });

  it("is absent on staging", async () => {
    const { app } = await build({ ...deployedEnv("staging"), DEV_LOGIN_SECRET: SECRET });
    expect((await app.handle(get(`/dev/login?secret=${SECRET}`))).status).toBe(404);
  });

  it("is absent on production", async () => {
    const { app } = await build({ ...deployedEnv("production"), DEV_LOGIN_SECRET: SECRET });
    expect((await app.handle(get(`/dev/login?secret=${SECRET}`))).status).toBe(404);
  });

  // Fails closed the same way the OpenAPI gate does: `isNonLocal` counts
  // anything that isn't exactly `local` as deployed, and
  // `parseDeploymentEnvironment` answers `dev` only for `dev`/`development`.
  it("is absent on an unrecognised tier string", async () => {
    const { app } = await build({ ...deployedEnv("developement"), DEV_LOGIN_SECRET: SECRET });
    expect((await app.handle(get(`/dev/login?secret=${SECRET}`))).status).toBe(404);
  });
});

describe("dev-login", () => {
  it("rejects a wrong secret with 401 and sets no cookie", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(get("/dev/login?secret=nope"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a missing secret with 401", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    expect((await app.handle(get("/dev/login"))).status).toBe(401);
  });

  it("issues a session for the seeded dev principal", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(get(`/dev/login?secret=${SECRET}`));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      session: { access_token: string; token_type: string };
      profile: { id: string; handle: string };
    };
    // The cire dev seed writes this exact profile id as the seeded wedding's
    // owner, so the session must name it or the organiser portal signs in as a
    // stranger with nothing to show.
    expect(body.profile.id).toBe(DEV_PRINCIPAL.profileId);
    expect(body.profile.handle).toBe(DEV_PRINCIPAL.handle);
    expect(body.session.token_type).toBe("Bearer");
    expect(body.session.access_token.length).toBeGreaterThan(0);
    // The refresh token stays out of the body (S-M2) — cookie only.
    expect(JSON.stringify(body.session)).not.toContain("refresh");

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("osn_session=");
  });

  it("provisions the principal exactly once across repeated calls", async () => {
    // `osn-db-dev` is never reset, so provisioning has to survive being run on
    // every sign-in and every deploy without piling up rows.
    const { app, db } = await build({ DEV_LOGIN_SECRET: SECRET });
    await app.handle(get(`/dev/login?secret=${SECRET}`));
    await app.handle(get(`/dev/login?secret=${SECRET}`));

    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(organisations)).toHaveLength(1);
  });

  it("names the seeded owner by its literal id", async () => {
    // Deliberately not `DEV_PRINCIPAL.profileId`: this string is a contract with
    // `cire/db/seed/data/wedding.ts`, and a test that reads the constant would
    // stay green through a rename that silently orphans the seeded wedding.
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const body = (await (await app.handle(devLogin(SECRET))).json()) as {
      profile: { id: string; handle: string };
    };
    expect(body.profile.id).toBe("usr_dev_bootstrap_owner");
    expect(body.profile.handle).toBe("dev_bootstrap");
  });

  it("provisions the organisation membership the organiser portal reads", async () => {
    const { app, db } = await build({ DEV_LOGIN_SECRET: SECRET });
    await app.handle(devLogin(SECRET));

    const [membership] = await db.select().from(organisationMembers);
    expect(membership).toMatchObject({
      id: DEV_PRINCIPAL.membershipId,
      organisationId: DEV_PRINCIPAL.organisationId,
      profileId: DEV_PRINCIPAL.profileId,
      role: "admin",
    });
    const [organisation] = await db.select().from(organisations);
    expect(organisation).toMatchObject({
      handle: DEV_PRINCIPAL.organisationHandle,
      ownerId: DEV_PRINCIPAL.profileId,
    });
  });

  it("sets both session cookies, and keeps the secret out of the Referer", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(devLogin(SECRET));
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("osn_session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("osn_has_session=1"))).toBe(true);
    // The secret rides in the query string, so this URL is a credential.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("uses the __Host- prefixed Secure cookie on the dev tier", async () => {
    const { app } = await build({ ...deployedEnv("dev"), DEV_LOGIN_SECRET: SECRET });
    const session = await app
      .handle(devLogin(SECRET))
      .then((r) => r.headers.getSetCookie().find((c) => c.includes("osn_session=")));
    expect(session).toContain("__Host-osn_session=");
    expect(session).toContain("Secure");
  });

  it("mints a session cookie the /token grant actually redeems", async () => {
    // The whole point of the bypass is that everything downstream runs
    // untouched — so the cookie has to be a real rotating session, not a
    // lookalike this route alone understands.
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const cookie = (await app.handle(devLogin(SECRET))).headers
      .getSetCookie()
      .find((c) => c.startsWith("osn_session="))!
      .match(/osn_session=([^;]+)/)![1]!;

    const res = await app.handle(
      new Request("http://localhost/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: ALLOWED_ORIGIN,
          cookie: `osn_session=${cookie}`,
        },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      }),
    );
    expect(res.status).toBe(200);
    const rotated = res.headers.getSetCookie();
    expect(rotated.some((c) => c.startsWith("osn_session="))).toBe(true);
  });

  it("answers 500 when provisioning cannot land the principal", async () => {
    // A squatted handle makes the `users` insert a no-op conflict, so the
    // profile is still missing after provisioning. Better a loud 500 than a
    // session for whoever holds the handle.
    const { app, db } = await build({ DEV_LOGIN_SECRET: SECRET });
    const now = new Date();
    db.insert(accounts)
      .values({
        id: "acc_squatter",
        email: "squatter@example.test",
        passkeyUserId: "pku_squatter",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(users)
      .values({
        id: "usr_squatter",
        accountId: "acc_squatter",
        handle: DEV_PRINCIPAL.handle,
        displayName: "Squatter",
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await app.handle(devLogin(SECRET));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "provisioning_failed" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("issues the same session over POST, behind the origin guard", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(post("/dev/login", { secret: SECRET }));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = (await res.json()) as { profile: { id: string } };
    expect(body.profile.id).toBe(DEV_PRINCIPAL.profileId);

    // No Origin header ⇒ the guard answers before the route ever runs.
    const guarded = await app.handle(post("/dev/login", { secret: SECRET }, null));
    expect(guarded.status).toBe(403);
  });

  it("rejects a POST with no secret in the body before touching the DB", async () => {
    // 422 from the TypeBox body schema, not one of the declared responses —
    // the secret is `t.String()` there rather than optional, so a bodyless
    // caller never reaches the constant-time compare.
    const { app, db } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(post("/dev/login", {}));
    expect(res.status).toBe(422);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("redirects to an allowlisted return_to, carrying the cookie", async () => {
    const { app } = await build({
      DEV_LOGIN_SECRET: SECRET,
      DEV_LOGIN_RETURN_ORIGINS: RETURN_ORIGINS,
    });
    const target = "http://localhost:4322/dashboard";
    const res = await app.handle(devLogin(SECRET, target));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(target);
    expect(res.headers.get("set-cookie") ?? "").toContain("osn_session=");
  });

  it("drives return_to off the dev tier's own origins", async () => {
    const { app } = await build({
      ...deployedEnv("dev"),
      DEV_LOGIN_SECRET: SECRET,
      DEV_LOGIN_RETURN_ORIGINS: "https://host.dev.cireweddings.com",
    });
    const target = "https://host.dev.cireweddings.com/dashboard";
    expect((await app.handle(devLogin(SECRET, target))).headers.get("location")).toBe(target);
    // The tier's CORS origin is a different list and grants nothing here.
    const cors = await app.handle(devLogin(SECRET, "https://app.osn.test/x"));
    expect(cors.status).toBe(400);
  });

  it("refuses every return_to when DEV_LOGIN_RETURN_ORIGINS is unset", async () => {
    const { app } = await build({ DEV_LOGIN_SECRET: SECRET });
    const res = await app.handle(devLogin(SECRET, "http://localhost:4322/dashboard"));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a return_to outside DEV_LOGIN_RETURN_ORIGINS", async () => {
    const { app } = await build({
      DEV_LOGIN_SECRET: SECRET,
      DEV_LOGIN_RETURN_ORIGINS: RETURN_ORIGINS,
    });
    const res = await app.handle(devLogin(SECRET, "https://evil.test/x"));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses the open-redirect shapes that look allowlisted", async () => {
    const { app } = await build({
      DEV_LOGIN_SECRET: SECRET,
      DEV_LOGIN_RETURN_ORIGINS: RETURN_ORIGINS,
    });
    const targets = [
      "//evil.test/x", // protocol-relative: no origin at all
      "http://localhost:4322.evil.test/x", // allowlisted host as a prefix
      "http://evil.test/http://localhost:4322", // allowlisted origin in the path
      "https://localhost:4322/x", // right host + port, wrong scheme
      "http://user@localhost:4322@evil.test/x", // userinfo confusion
      "javascript:alert(1)", // not http at all
      "/dashboard", // relative: no origin to check
    ];
    // Keyed by target so a failure names the shape that got through.
    const outcomes: Record<string, { status: number; location: string | null }> = {};
    const expected: Record<string, { status: number; location: string | null }> = {};
    for (const target of targets) {
      const res = await app.handle(devLogin(SECRET, target));
      outcomes[target] = { status: res.status, location: res.headers.get("location") };
      expected[target] = { status: 400, location: null };
    }
    expect(outcomes).toEqual(expected);
  });

  it("refuses a return_to before it authenticates, so a wrong secret redirects nowhere", async () => {
    const { app } = await build({
      DEV_LOGIN_SECRET: SECRET,
      DEV_LOGIN_RETURN_ORIGINS: RETURN_ORIGINS,
    });
    const res = await app.handle(devLogin("nope", "http://localhost:4322/dashboard"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
