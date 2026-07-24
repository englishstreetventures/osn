/**
 * OIDC provider route tests.
 *
 * The load-bearing rule under test is the two-tier error delivery of RFC 6749
 * §4.1.2.1: until the client and its redirect URI are both known-good, an error
 * must be RENDERED. Redirecting to a URI the request itself supplied would make
 * the identity provider an open redirect, which is the first link in most
 * account-takeover chains — so the "renders, does not redirect" assertions here
 * are security tests, not shape tests.
 *
 * See [[wiki/systems/oidc-provider]].
 */

import { createHash } from "node:crypto";

import { makeLogEmailLive } from "@shared/email";
import { Layer } from "effect";
import { describe, it, expect, beforeAll } from "vitest";

import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
// S-M34: wrapped factory (trust XFF under app.handle). See helpers/routes.
import { createAuthRoutes } from "../helpers/routes";

const REDIRECT_URI = "https://rp.example.com/callback";
const VERIFIER = "test-code-verifier-0123456789abcdefghijklmnopqrstuvwxyz";

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const CHALLENGE = base64Url(createHash("sha256").update(VERIFIER).digest());

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

interface Harness {
  app: ReturnType<typeof createAuthRoutes>;
  /** Latest OTP the log transport captured, for the registration flow. */
  code: () => string | undefined;
  seedClient: (overrides?: Partial<SeedClient>) => void;
  /** Raw DB handle — used to age sessions for auth_time / max_age tests. */
  sqlite: ReturnType<typeof createTestLayerWithSqlite>["sqlite"];
}

interface SeedClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  clientSecretHash: string | null;
  firstParty: boolean;
}

function setup(): Harness {
  const { layer, sqlite } = createTestLayerWithSqlite();
  const rec = makeLogEmailLive();
  const app = createAuthRoutes(config, Layer.merge(layer, rec.layer));

  return {
    app,
    sqlite,
    code: () => {
      const all = rec.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/code is: (\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    },
    seedClient: (overrides = {}) => {
      const c: SeedClient = {
        clientId: "cid_rp",
        name: "Relying Party",
        redirectUris: [REDIRECT_URI],
        clientSecretHash: null,
        firstParty: false,
        ...overrides,
      };
      sqlite.run(
        `INSERT INTO oauth_clients
           (id, client_id, name, logo_url, redirect_uris, client_secret_hash,
            sector_identifier, allowed_scopes, is_first_party, created_at, disabled_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'openid profile email', ?, ?, NULL)`,
        [
          `oc_${c.clientId}`,
          c.clientId,
          c.name,
          JSON.stringify(c.redirectUris),
          c.clientSecretHash,
          new URL(c.redirectUris[0]).host,
          c.firstParty ? 1 : 0,
          Math.floor(Date.now() / 1000),
        ],
      );
    },
  };
}

/** Registers an account; returns its session cookie + a bearer access token. */
async function register(
  h: Harness,
  email: string,
  handle: string,
): Promise<{ cookie: string; accessToken: string }> {
  await h.app.handle(
    new Request("http://localhost/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, handle, birthdate: "1990-01-01" }),
    }),
  );
  const res = await h.app.handle(
    new Request("http://localhost/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: h.code() }),
    }),
  );
  const body = (await res.json()) as { session: { access_token: string } };
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = setCookie.split(";")[0];
  expect(token).toContain("osn_session=");
  return { cookie: token, accessToken: body.session.access_token };
}

/** Registers an account and returns its session cookie header value. */
async function signIn(h: Harness, email: string, handle: string): Promise<string> {
  return (await register(h, email, handle)).cookie;
}

/**
 * Ages every session in the harness by `seconds`, so a "signed in a while
 * ago" device can be simulated without waiting.
 */
function ageSessions(h: Harness, seconds: number): void {
  h.sqlite.run(`UPDATE sessions SET created_at = created_at - ${seconds}`);
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL("http://localhost/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** The parameter set every well-formed request in these tests starts from. */
const goodParams = {
  client_id: "cid_rp",
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: "openid profile",
  state: "st_123",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

describe("GET /authorize", () => {
  it("renders (never redirects) an unknown client_id", async () => {
    const h = setup();
    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, client_id: "cid_nope" })),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("renders (never redirects) an unregistered redirect_uri", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, redirect_uri: "https://attacker.example/steal" })),
    );

    expect(res.status).toBe(400);
    // The open-redirect guard: nothing may point a browser at an unvalidated URI.
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("sets cache-control: no-store", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(new Request(authorizeUrl(goodParams)));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects protocol errors back to the client with state preserved", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, response_type: "token" })),
    );

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("error")).toBe("unsupported_response_type");
    expect(loc.searchParams.get("state")).toBe("st_123");
  });

  it("rejects a plain code_challenge_method", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, code_challenge_method: "plain" })),
    );

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("answers prompt=none with login_required when no session exists", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(new Request(authorizeUrl({ ...goodParams, prompt: "none" })));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("login_required");
    expect(loc.searchParams.get("state")).toBe("st_123");
  });

  it("sends a signed-out visitor to the interaction UI with reason=login", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(new Request(authorizeUrl(goodParams)));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/authorize");
    expect(loc.searchParams.get("request")).toMatch(/^oar_[a-f0-9]{12}$/);
    expect(loc.searchParams.get("reason")).toBe("login");
  });

  it("sends a signed-in visitor with no consent to the interaction UI", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "consent@example.com", "consent_user");

    const res = await h.app.handle(new Request(authorizeUrl(goodParams), { headers: { cookie } }));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("reason")).toBe("consent");
  });

  it("answers a signed-in prompt=none with consent_required when unlinked", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "silent@example.com", "silent_user");

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, prompt: "none" }), { headers: { cookie } }),
    );

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("consent_required");
  });

  it("returns a code straight away for a first-party client", async () => {
    const h = setup();
    h.seedClient({ firstParty: true });
    const cookie = await signIn(h, "first@example.com", "first_user");

    const res = await h.app.handle(new Request(authorizeUrl(goodParams), { headers: { cookie } }));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("code")).toMatch(/^cod_/);
    expect(loc.searchParams.get("state")).toBe("st_123");
  });

  it("honours prompt=select_account even for a first-party client", async () => {
    const h = setup();
    h.seedClient({ firstParty: true });
    const cookie = await signIn(h, "select@example.com", "select_user");

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, prompt: "select_account" }), {
        headers: { cookie },
      }),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("reason")).toBe("select_account");
  });
});

describe("GET /authorize/context", () => {
  it("404s an unknown request id", async () => {
    const h = setup();
    const res = await h.app.handle(
      new Request("http://localhost/authorize/context?request=oar_aaaaaaaaaaaa"),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("describes the client, the scopes and the signed-in profiles", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "ctx@example.com", "ctx_user");

    const { requestId, binding } = await startAuthorize(h, sessionCookie);

    const res = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie: `${sessionCookie}; ${binding}` },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      client: { clientId: string; name: string; firstParty: boolean };
      scopes: string[];
      signedIn: boolean;
      profiles: { id: string }[];
      linkedProfileId: string | null;
    };
    expect(body.client.clientId).toBe("cid_rp");
    expect(body.client.firstParty).toBe(false);
    expect(body.scopes).toEqual(["openid", "profile"]);
    expect(body.signedIn).toBe(true);
    expect(body.profiles).toHaveLength(1);
    expect(body.linkedProfileId).toBeNull();
  });

  it("reports signedIn: false without a session cookie", async () => {
    const h = setup();
    h.seedClient();
    const { requestId, binding } = await startAuthorize(h, null);

    const res = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie: binding },
      }),
    );

    const body = (await res.json()) as { signedIn: boolean; profiles: unknown[] };
    expect(body.signedIn).toBe(false);
    expect(body.profiles).toEqual([]);
  });
});

/**
 * Starts an authorize flow that needs interaction. Returns the parked request
 * id and the browser-binding cookie the response set (S-M1) as a `name=value`
 * pair ready to join onto a Cookie header.
 */
async function startAuthorize(
  h: Harness,
  cookie: string | null,
  params: Record<string, string> = goodParams,
): Promise<{ requestId: string; binding: string }> {
  const res = await h.app.handle(
    new Request(authorizeUrl(params), cookie === null ? undefined : { headers: { cookie } }),
  );
  const requestId = new URL(res.headers.get("location")!).searchParams.get("request")!;
  const binding = (res.headers.get("set-cookie") ?? "").split(";")[0];
  expect(binding).toContain(`osn_${requestId}=oab_`);
  return { requestId, binding };
}

/**
 * Drives a third-party request to the consent screen and returns its inputs.
 * `cookie` is the session + binding pair every context/decision call needs.
 */
async function parkRequest(
  h: Harness,
  sessionCookie: string,
): Promise<{ requestId: string; profileId: string; cookie: string }> {
  const { requestId, binding } = await startAuthorize(h, sessionCookie);
  const cookie = `${sessionCookie}; ${binding}`;
  const ctxRes = await h.app.handle(
    new Request(`http://localhost/authorize/context?request=${requestId}`, { headers: { cookie } }),
  );
  const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };
  return { requestId, profileId: profiles[0].id, cookie };
}

describe("POST /authorize/decision", () => {
  it("401s when the decider is not signed in", async () => {
    const h = setup();
    const res = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "oar_aaaaaaaaaaaa",
          profileId: "usr_x",
          approved: true,
        }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns the code redirect as JSON on approval", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "approve@example.com", "approve_user");
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);

    const res = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );

    expect(res.status).toBe(200);
    // JSON, not a 302: a fetch would follow a redirect instead of handing it
    // to the consent screen.
    expect(res.headers.get("location")).toBeNull();
    // The consumed binding cookie is expired rather than left to linger.
    expect(res.headers.get("set-cookie")).toContain(`osn_${requestId}=;`);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const body = (await res.json()) as { redirectTo: string };
    const loc = new URL(body.redirectTo);
    expect(loc.searchParams.get("code")).toMatch(/^cod_/);
    expect(loc.searchParams.get("state")).toBe("st_123");
  });

  it("returns access_denied on refusal", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "refuse@example.com", "refuse_user");
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);

    const res = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: false }),
      }),
    );

    const body = (await res.json()) as { redirectTo: string };
    expect(new URL(body.redirectTo).searchParams.get("error")).toBe("access_denied");
    // A refusal consumes the request too, so its binding cookie clears as well.
    expect(res.headers.get("set-cookie")).toContain(`osn_${requestId}=;`);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("retires the request id, so a replayed decision cannot mint a second code", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "replay@example.com", "replay_user");
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);

    const decide = () =>
      h.app.handle(
        new Request("http://localhost/authorize/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ requestId, profileId, approved: true }),
        }),
      );

    expect((await decide()).status).toBe(200);
    const second = await decide();
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("refuses a profile the deciding account does not own", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "owner@example.com", "owner_user");
    const otherCookie = await signIn(h, "other@example.com", "other_user");
    const { requestId, cookie } = await parkRequest(h, sessionCookie);
    // The other account learns its own profile id from its own flow.
    const { profileId: otherProfileId } = await parkRequest(h, otherCookie);

    const res = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId: otherProfileId, approved: true }),
      }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("makes the next silent request succeed once consent is on record", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "linked@example.com", "linked_user");
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);
    await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, prompt: "none" }), {
        headers: { cookie: sessionCookie },
      }),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("code")).toMatch(/^cod_/);
    expect(loc.searchParams.get("error")).toBeNull();
  });
});

/** Runs a whole authorization and hands back a redeemable code. */
async function mintCode(h: Harness, email: string, handle: string): Promise<string> {
  const sessionCookie = await signIn(h, email, handle);
  const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);
  const res = await h.app.handle(
    new Request("http://localhost/authorize/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ requestId, profileId, approved: true }),
    }),
  );
  const { redirectTo } = (await res.json()) as { redirectTo: string };
  return new URL(redirectTo).searchParams.get("code")!;
}

function tokenRequest(form: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/oidc/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

describe("POST /oidc/token", () => {
  it("exchanges a code for an id_token and an access token", async () => {
    const h = setup();
    h.seedClient();
    const code = await mintCode(h, "token@example.com", "token_user");

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        client_id: "cid_rp",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      access_token: string;
      id_token: string;
      token_type: string;
      scope: string;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("openid profile");
    // A pairwise subject, never the profile id itself.
    const claims = JSON.parse(
      Buffer.from(body.id_token.split(".")[1], "base64url").toString("utf8"),
    ) as { sub: string; aud: string; iss: string };
    expect(claims.sub).toMatch(/^pw_/);
    expect(claims.aud).toBe("cid_rp");
    expect(claims.iss).toBe(config.issuerUrl);
  });

  it("rejects a wrong code_verifier", async () => {
    const h = setup();
    h.seedClient();
    const code = await mintCode(h, "pkce@example.com", "pkce_user");

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: "not-the-verifier-not-the-verifier-not-the-verifi",
        client_id: "cid_rp",
      }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects a replayed code", async () => {
    const h = setup();
    h.seedClient();
    const code = await mintCode(h, "once@example.com", "once_user");
    const exchange = () =>
      h.app.handle(
        tokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          client_id: "cid_rp",
        }),
      );

    expect((await exchange()).status).toBe(200);
    const second = await exchange();
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects a redirect_uri that differs from the one the code was bound to", async () => {
    const h = setup();
    h.seedClient({ redirectUris: [REDIRECT_URI, "https://rp.example.com/other"] });
    const code = await mintCode(h, "bound@example.com", "bound_user");

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://rp.example.com/other",
        code_verifier: VERIFIER,
        client_id: "cid_rp",
      }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects two client authentication methods at once", async () => {
    const h = setup();
    h.seedClient();

    const res = await h.app.handle(
      tokenRequest(
        {
          grant_type: "authorization_code",
          code: "cod_whatever",
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          client_id: "cid_rp",
        },
        { authorization: `Basic ${Buffer.from("cid_rp:secret").toString("base64")}` },
      ),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("answers a failed Basic authentication with 401 + WWW-Authenticate", async () => {
    const h = setup();
    h.seedClient();

    const res = await h.app.handle(
      tokenRequest(
        {
          grant_type: "authorization_code",
          code: "cod_whatever",
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
        },
        { authorization: `Basic ${Buffer.from("cid_unknown:secret").toString("base64")}` },
      ),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="oidc"');
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("refuses a secret from a public client", async () => {
    const h = setup();
    h.seedClient();
    const code = await mintCode(h, "public@example.com", "public_user");

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        client_id: "cid_rp",
        client_secret: "cs_made_up",
      }),
    );

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("rejects any grant type other than authorization_code", async () => {
    const h = setup();
    const res = await h.app.handle(
      tokenRequest({ grant_type: "refresh_token", client_id: "cid_rp" }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("requires code, redirect_uri and code_verifier together", async () => {
    const h = setup();
    const res = await h.app.handle(
      tokenRequest({ grant_type: "authorization_code", client_id: "cid_rp" }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });
});

describe("browser binding (S-M1)", () => {
  it("sets an HttpOnly short-TTL binding cookie on the interaction redirect", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(new Request(authorizeUrl(goodParams)));

    const setCookie = res.headers.get("set-cookie")!;
    const requestId = new URL(res.headers.get("location")!).searchParams.get("request")!;
    expect(setCookie).toContain(`osn_${requestId}=oab_`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("404s a context read from a browser without the binding cookie", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "bindctx@example.com", "bindctx_user");
    const { requestId } = await startAuthorize(h, cookie);

    // Session cookie present, binding cookie absent — another signed-in
    // browser that somehow learned the request id.
    const res = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie },
      }),
    );

    expect(res.status).toBe(404);
  });

  it("refuses a decision from a browser without the binding cookie, without burning the request", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "bind@example.com", "bind_user");
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);

    const forged = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: sessionCookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { error: string }).error).toBe("invalid_request");

    // The parked request survives the forged attempt: the real browser,
    // holding the binding cookie, can still approve it.
    const real = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );
    expect(real.status).toBe(200);
  });
});

describe("auth freshness (S-H1)", () => {
  it("forces re-login when the session is older than max_age", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "stale@example.com", "stale_user");
    ageSessions(h, 7200);

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, max_age: "3600" }), { headers: { cookie } }),
    );

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("reason")).toBe("login");
  });

  it("answers prompt=none with login_required when max_age is exceeded", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "stalenone@example.com", "stalenone_user");
    ageSessions(h, 7200);

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, max_age: "3600", prompt: "none" }), {
        headers: { cookie },
      }),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("login_required");
  });

  it("redirects an unparseable max_age back as invalid_request", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(new Request(authorizeUrl({ ...goodParams, max_age: "-1" })));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses a prompt=login decision from the pre-existing session until it is re-created", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "fresh@example.com", "fresh_user");
    // The session predates the parked request by a comfortable margin.
    ageSessions(h, 60);

    const { requestId, binding } = await startAuthorize(h, sessionCookie, {
      ...goodParams,
      prompt: "login",
    });
    const cookie = `${sessionCookie}; ${binding}`;
    const ctxRes = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie },
      }),
    );
    const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };

    const decide = () =>
      h.app.handle(
        new Request("http://localhost/authorize/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ requestId, profileId: profiles[0].id, approved: true }),
        }),
      );

    const staleAttempt = await decide();
    expect(staleAttempt.status).toBe(400);
    expect(((await staleAttempt.json()) as { error: string }).error).toBe("login_required");

    // Simulate the fresh sign-in the screen would drive: the session row is
    // re-created (created_at moves past the park instant). Same request id.
    h.sqlite.run(`UPDATE sessions SET created_at = created_at + 120`);
    const freshAttempt = await decide();
    expect(freshAttempt.status).toBe(200);
  });

  it("stamps auth_time from the session, not from the code mint", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "authtime@example.com", "authtime_user");
    ageSessions(h, 7200);

    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);
    const decisionRes = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );
    const { redirectTo } = (await decisionRes.json()) as { redirectTo: string };
    const code = new URL(redirectTo).searchParams.get("code")!;

    const tokenRes = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        client_id: "cid_rp",
      }),
    );
    const { id_token } = (await tokenRes.json()) as { id_token: string };
    const claims = JSON.parse(
      Buffer.from(id_token.split(".")[1], "base64url").toString("utf8"),
    ) as { auth_time: number };
    // The session is two hours old; auth_time must say so.
    expect(claims.auth_time).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 7000);
  });
});

describe("token typing (S-M2)", () => {
  it("marks the OIDC access token typ: at+jwt and leaves the id_token untyped", async () => {
    const h = setup();
    h.seedClient();
    const code = await mintCode(h, "typ@example.com", "typ_user");

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        client_id: "cid_rp",
      }),
    );
    const { access_token, id_token } = (await res.json()) as {
      access_token: string;
      id_token: string;
    };
    const header = (t: string) =>
      JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8")) as { typ?: string };
    expect(header(access_token).typ).toBe("at+jwt");
    expect(header(id_token).typ).toBeUndefined();
  });

  it("treats a client registered under a reserved audience as unknown", async () => {
    const h = setup();
    h.seedClient({ clientId: "osn-access" });

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, client_id: "osn-access" })),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });
});

describe("connections (S-M3)", () => {
  /** Registers, links the account to cid_rp, returns the bearer token. */
  async function linkAccount(h: Harness, email: string, handle: string): Promise<string> {
    const { cookie: sessionCookie, accessToken } = await register(h, email, handle);
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);
    const res = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );
    expect(res.status).toBe(200);
    return accessToken;
  }

  it("401s without a bearer token", async () => {
    const h = setup();
    const res = await h.app.handle(new Request("http://localhost/oidc/connections"));
    expect(res.status).toBe(401);
  });

  it("lists the linked apps and revokes one", async () => {
    const h = setup();
    h.seedClient();
    const accessToken = await linkAccount(h, "conn@example.com", "conn_user");
    const authed = { authorization: `Bearer ${accessToken}` };

    const listRes = await h.app.handle(
      new Request("http://localhost/oidc/connections", { headers: authed }),
    );
    expect(listRes.status).toBe(200);
    const { connections } = (await listRes.json()) as {
      connections: { clientId: string; clientName: string | null; scope: string }[];
    };
    expect(connections).toHaveLength(1);
    expect(connections[0].clientId).toBe("cid_rp");
    expect(connections[0].clientName).toBe("Relying Party");

    const revokeRes = await h.app.handle(
      new Request("http://localhost/oidc/connections/cid_rp", {
        method: "DELETE",
        headers: authed,
      }),
    );
    expect(revokeRes.status).toBe(200);

    const emptyRes = await h.app.handle(
      new Request("http://localhost/oidc/connections", { headers: authed }),
    );
    const after = (await emptyRes.json()) as { connections: unknown[] };
    expect(after.connections).toHaveLength(0);

    // Revoking again finds nothing live.
    const again = await h.app.handle(
      new Request("http://localhost/oidc/connections/cid_rp", {
        method: "DELETE",
        headers: authed,
      }),
    );
    expect(again.status).toBe(404);
  });

  it("makes the next silent request fail once revoked", async () => {
    const h = setup();
    h.seedClient();
    const { cookie: sessionCookie, accessToken } = await register(
      h,
      "unlink@example.com",
      "unlink_user",
    );
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);
    await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );

    await h.app.handle(
      new Request("http://localhost/oidc/connections/cid_rp", {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, prompt: "none" }), {
        headers: { cookie: sessionCookie },
      }),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("consent_required");
  });

  it("kills an authorization code in flight when the consent is revoked", async () => {
    const h = setup();
    h.seedClient();
    const { cookie: sessionCookie, accessToken } = await register(
      h,
      "inflight@example.com",
      "inflight_user",
    );
    const { requestId, profileId, cookie } = await parkRequest(h, sessionCookie);
    const decisionRes = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );
    const { redirectTo } = (await decisionRes.json()) as { redirectTo: string };
    const code = new URL(redirectTo).searchParams.get("code")!;

    await h.app.handle(
      new Request("http://localhost/oidc/connections/cid_rp", {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        client_id: "cid_rp",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("auth freshness boundaries (S-H1)", () => {
  it("does not force re-login when the session age is within max_age", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "within@example.com", "within_user");
    ageSessions(h, 3600);

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, max_age: "3605" }), { headers: { cookie } }),
    );

    // Not stale — the flow proceeds to the consent question, not to login.
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("reason")).toBe("consent");
  });

  it("treats max_age=0 as a demand for fresh authentication", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "zero@example.com", "zero_user");
    ageSessions(h, 10);

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, max_age: "0" }), { headers: { cookie } }),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("reason")).toBe("login");
  });

  it("rejects a max_age above the ceiling as invalid_request", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, max_age: "999999999" })),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a code_challenge that is not exactly 43 base64url characters", async () => {
    const h = setup();
    h.seedClient();
    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, code_challenge: `${CHALLENGE}A` })),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });
});

describe("re-consent (recordConsent conflict path)", () => {
  /** Full authorize→context→decision round for the given params. */
  async function approve(
    h: Harness,
    sessionCookie: string,
    params: Record<string, string>,
  ): Promise<Response> {
    const { requestId, binding } = await startAuthorize(h, sessionCookie, params);
    const cookie = `${sessionCookie}; ${binding}`;
    const ctxRes = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie },
      }),
    );
    const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };
    return h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId: profiles[0]!.id, approved: true }),
      }),
    );
  }

  it("widens the stored scope to the union on re-consent", async () => {
    const h = setup();
    h.seedClient();
    const { cookie: sessionCookie, accessToken } = await register(
      h,
      "widen@example.com",
      "widen_user",
    );

    expect((await approve(h, sessionCookie, { ...goodParams, scope: "openid" })).status).toBe(200);
    // The second request asks for more than the recorded grant covers, so it
    // interacts again; approving merges rather than replaces.
    expect((await approve(h, sessionCookie, goodParams)).status).toBe(200);

    const listRes = await h.app.handle(
      new Request("http://localhost/oidc/connections", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    const { connections } = (await listRes.json()) as { connections: { scope: string }[] };
    expect(connections).toHaveLength(1);
    expect(connections[0]!.scope.split(" ").toSorted()).toEqual(["openid", "profile"]);
  });

  it("re-links after a revoke: consent live again, silent requests succeed", async () => {
    const h = setup();
    h.seedClient();
    const { cookie: sessionCookie, accessToken } = await register(
      h,
      "relink@example.com",
      "relink_user",
    );
    const authed = { authorization: `Bearer ${accessToken}` };

    expect((await approve(h, sessionCookie, goodParams)).status).toBe(200);
    expect(
      (
        await h.app.handle(
          new Request("http://localhost/oidc/connections/cid_rp", {
            method: "DELETE",
            headers: authed,
          }),
        )
      ).status,
    ).toBe(200);

    // Re-approving a revoked consent is the RE-GRANT arm of the conflict
    // branch: revoked_at must clear, and the link must read as live again.
    expect((await approve(h, sessionCookie, goodParams)).status).toBe(200);

    const listRes = await h.app.handle(
      new Request("http://localhost/oidc/connections", { headers: authed }),
    );
    const { connections } = (await listRes.json()) as { connections: unknown[] };
    expect(connections).toHaveLength(1);

    const silent = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, prompt: "none" }), {
        headers: { cookie: sessionCookie },
      }),
    );
    const loc = new URL(silent.headers.get("location")!);
    expect(loc.searchParams.get("code")).toMatch(/^cod_/);
    expect(loc.searchParams.get("error")).toBeNull();
  });
});

describe("security-review fixes (prep-pr round)", () => {
  it("S-M1: prompt=login parked signed-out still demands a fresh session at decision", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "strip@example.com", "strip_user");
    ageSessions(h, 60);

    // The attacker path: strip the session cookie on the /authorize
    // navigation so the park records no session — the freshness demand must
    // be recorded anyway.
    const { requestId, binding } = await startAuthorize(h, null, {
      ...goodParams,
      prompt: "login",
    });
    const cookie = `${sessionCookie}; ${binding}`;
    const ctxRes = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie },
      }),
    );
    const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };

    const decide = () =>
      h.app.handle(
        new Request("http://localhost/authorize/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ requestId, profileId: profiles[0]!.id, approved: true }),
        }),
      );

    const stale = await decide();
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toBe("login_required");

    // A session created after the park (a real re-login) is accepted.
    h.sqlite.run(`UPDATE sessions SET created_at = created_at + 120`);
    expect((await decide()).status).toBe(200);
  });

  it("S-M2: re-consent after a revoke grants only what was just approved", async () => {
    const h = setup();
    h.seedClient();
    const { cookie: sessionCookie, accessToken } = await register(
      h,
      "narrow@example.com",
      "narrow_user",
    );
    const authed = { authorization: `Bearer ${accessToken}` };

    const approve = async (params: Record<string, string>) => {
      const { requestId, binding } = await startAuthorize(h, sessionCookie, params);
      const cookie = `${sessionCookie}; ${binding}`;
      const ctxRes = await h.app.handle(
        new Request(`http://localhost/authorize/context?request=${requestId}`, {
          headers: { cookie },
        }),
      );
      const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };
      const res = await h.app.handle(
        new Request("http://localhost/authorize/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ requestId, profileId: profiles[0]!.id, approved: true }),
        }),
      );
      expect(res.status).toBe(200);
    };

    await approve(goodParams); // openid profile
    await h.app.handle(
      new Request("http://localhost/oidc/connections/cid_rp", {
        method: "DELETE",
        headers: authed,
      }),
    );
    await approve({ ...goodParams, scope: "openid" });

    const listRes = await h.app.handle(
      new Request("http://localhost/oidc/connections", { headers: authed }),
    );
    const { connections } = (await listRes.json()) as { connections: { scope: string }[] };
    // The withdrawn "profile" scope must NOT resurrect — only what the user
    // just saw on the consent screen is granted.
    expect(connections[0]!.scope).toBe("openid");
  });

  it("S-L4: the token exchange refuses a code whose consent was revoked mid-flight", async () => {
    const h = setup();
    h.seedClient();
    const code = await mintCode(h, "midflight@example.com", "midflight_user");

    // Revoke directly in the DB — simulating the race where a code slips past
    // the revoke route's delete — so only the exchange-time re-check can act.
    h.sqlite.run(`UPDATE oauth_consents SET revoked_at = 1 WHERE client_id = 'cid_rp'`);

    const res = await h.app.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        client_id: "cid_rp",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("S-L1: a decision without the binding cookie reads exactly like an unknown id", async () => {
    const h = setup();
    h.seedClient();
    const sessionCookie = await signIn(h, "oracle@example.com", "oracle_user");
    const { requestId, profileId } = await parkRequest(h, sessionCookie);

    const decideWithout = (id: string) =>
      h.app.handle(
        new Request("http://localhost/authorize/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: sessionCookie },
          body: JSON.stringify({ requestId: id, profileId, approved: true }),
        }),
      );

    const real = await decideWithout(requestId);
    const fake = await decideWithout("oar_ffffffffffff");
    expect(real.status).toBe(400);
    expect(fake.status).toBe(400);
    // Byte-identical bodies: a real-but-unbound id must not be distinguishable.
    expect(await real.json()).toEqual(await fake.json());
  });
});
