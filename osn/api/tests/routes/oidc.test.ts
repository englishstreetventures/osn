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

/** Registers an account and returns its session cookie header value. */
async function signIn(h: Harness, email: string, handle: string): Promise<string> {
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
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = setCookie.split(";")[0];
  expect(token).toContain("osn_session=");
  return token;
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
    const cookie = await signIn(h, "ctx@example.com", "ctx_user");

    const authorizeRes = await h.app.handle(
      new Request(authorizeUrl(goodParams), { headers: { cookie } }),
    );
    const requestId = new URL(authorizeRes.headers.get("location")!).searchParams.get("request")!;

    const res = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie },
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
    const authorizeRes = await h.app.handle(new Request(authorizeUrl(goodParams)));
    const requestId = new URL(authorizeRes.headers.get("location")!).searchParams.get("request")!;

    const res = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`),
    );

    const body = (await res.json()) as { signedIn: boolean; profiles: unknown[] };
    expect(body.signedIn).toBe(false);
    expect(body.profiles).toEqual([]);
  });
});

/** Drives a third-party request to the consent screen and returns its inputs. */
async function parkRequest(
  h: Harness,
  cookie: string,
): Promise<{ requestId: string; profileId: string }> {
  const authorizeRes = await h.app.handle(
    new Request(authorizeUrl(goodParams), { headers: { cookie } }),
  );
  const requestId = new URL(authorizeRes.headers.get("location")!).searchParams.get("request")!;
  const ctxRes = await h.app.handle(
    new Request(`http://localhost/authorize/context?request=${requestId}`, { headers: { cookie } }),
  );
  const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };
  return { requestId, profileId: profiles[0].id };
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
    const cookie = await signIn(h, "approve@example.com", "approve_user");
    const { requestId, profileId } = await parkRequest(h, cookie);

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
    const body = (await res.json()) as { redirectTo: string };
    const loc = new URL(body.redirectTo);
    expect(loc.searchParams.get("code")).toMatch(/^cod_/);
    expect(loc.searchParams.get("state")).toBe("st_123");
  });

  it("returns access_denied on refusal", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "refuse@example.com", "refuse_user");
    const { requestId, profileId } = await parkRequest(h, cookie);

    const res = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: false }),
      }),
    );

    const body = (await res.json()) as { redirectTo: string };
    expect(new URL(body.redirectTo).searchParams.get("error")).toBe("access_denied");
  });

  it("retires the request id, so a replayed decision cannot mint a second code", async () => {
    const h = setup();
    h.seedClient();
    const cookie = await signIn(h, "replay@example.com", "replay_user");
    const { requestId, profileId } = await parkRequest(h, cookie);

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
    const cookie = await signIn(h, "owner@example.com", "owner_user");
    const otherCookie = await signIn(h, "other@example.com", "other_user");
    const { requestId } = await parkRequest(h, cookie);
    const otherCtx = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie: otherCookie },
      }),
    );
    const otherProfileId = ((await otherCtx.json()) as { profiles: { id: string }[] }).profiles[0]
      .id;

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
    const cookie = await signIn(h, "linked@example.com", "linked_user");
    const { requestId, profileId } = await parkRequest(h, cookie);
    await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId, approved: true }),
      }),
    );

    const res = await h.app.handle(
      new Request(authorizeUrl({ ...goodParams, prompt: "none" }), { headers: { cookie } }),
    );

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("code")).toMatch(/^cod_/);
    expect(loc.searchParams.get("error")).toBeNull();
  });
});

/** Runs a whole authorization and hands back a redeemable code. */
async function mintCode(h: Harness, email: string, handle: string): Promise<string> {
  const cookie = await signIn(h, email, handle);
  const { requestId, profileId } = await parkRequest(h, cookie);
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
