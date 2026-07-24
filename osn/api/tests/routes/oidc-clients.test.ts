/**
 * Self-serve OIDC client registration route tests.
 *
 * The load-bearing rules: the client_id is server-generated (never a caller
 * input, so it can never collide with a reserved audience), the secret is
 * shown exactly once and stored only as a hash, redirect URIs are the
 * open-redirect boundary (https-only, no fragments), and disabling makes the
 * client read as absent everywhere at once. The final test proves the whole
 * point of the surface: a client registered through the API can run the
 * complete authorize → consent → token flow with no operator involved.
 *
 * See [[wiki/systems/oidc-provider]].
 */

import { createHash } from "node:crypto";

import { makeLogEmailLive } from "@shared/email";
import { Layer } from "effect";
import { describe, it, expect, beforeAll } from "vitest";

import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
import { createAuthRoutes } from "../helpers/routes";

const REDIRECT_URI = "https://newrp.example.com/callback";
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
  code: () => string | undefined;
  sqlite: ReturnType<typeof createTestLayerWithSqlite>["sqlite"];
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
  };
}

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
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { cookie, accessToken: body.session.access_token };
}

function createClient(
  h: Harness,
  accessToken: string,
  overrides: Record<string, unknown> = {},
  /** Distinct per-call IPs let a test outrun the 5/hour per-IP limiter. */
  ip?: string,
): Promise<Response> {
  return h.app.handle(
    new Request("http://localhost/oidc/clients", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      body: JSON.stringify({
        name: "My New RP",
        redirect_uris: [REDIRECT_URI],
        ...overrides,
      }),
    }),
  );
}

describe("POST /oidc/clients", () => {
  it("401s without a bearer token", async () => {
    const h = setup();
    const res = await h.app.handle(
      new Request("http://localhost/oidc/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", redirect_uris: [REDIRECT_URI] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("registers a public client with a server-generated cid_ and no secret", async () => {
    const h = setup();
    const { accessToken } = await register(h, "dev@example.com", "dev_user");

    const res = await createClient(h, accessToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client: {
        clientId: string;
        name: string;
        redirectUris: string[];
        sectorIdentifier: string;
        confidential: boolean;
      };
      client_secret: string | null;
    };
    expect(body.client.clientId).toMatch(/^cid_[a-f0-9]{12}$/);
    expect(body.client.confidential).toBe(false);
    expect(body.client_secret).toBeNull();
    // Sector is derived from the first redirect URI, never caller-chosen.
    expect(body.client.sectorIdentifier).toBe("newrp.example.com");
  });

  it("returns a confidential client's secret exactly once and stores only the hash", async () => {
    const h = setup();
    const { accessToken } = await register(h, "conf@example.com", "conf_user");

    const res = await createClient(h, accessToken, { confidential: true });
    const body = (await res.json()) as {
      client: { clientId: string; confidential: boolean };
      client_secret: string | null;
    };
    expect(body.client.confidential).toBe(true);
    expect(body.client_secret).toMatch(/^cs_/);

    // The stored row holds SHA-256(secret), never the plaintext.
    const rows = h.sqlite
      .query(`SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?`)
      .all(body.client.clientId) as { client_secret_hash: string }[];
    expect(rows[0]!.client_secret_hash).toBe(
      createHash("sha256").update(body.client_secret!).digest("hex"),
    );

    // The list surface never returns the secret in any form.
    const listRes = await h.app.handle(
      new Request("http://localhost/oidc/clients", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(JSON.stringify(await listRes.json())).not.toContain(body.client_secret);
  });

  it.each([
    ["a non-https redirect URI", { redirect_uris: ["http://rp.example.com/cb"] }],
    ["a fragment-carrying redirect URI", { redirect_uris: ["https://rp.example.com/cb#frag"] }],
    ["an unparseable redirect URI", { redirect_uris: ["not a url"] }],
    ["a non-https logo_url", { logo_url: "http://rp.example.com/logo.png" }],
    ["a javascript: logo_url", { logo_url: "javascript:alert(1)" }],
    ["a blank name", { name: "   " }],
  ])("rejects %s", async (_label, overrides) => {
    const h = setup();
    const { accessToken } = await register(h, "invalid@example.com", "invalid_user");

    const res = await createClient(h, accessToken, overrides);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("allows http for loopback development redirect URIs", async () => {
    const h = setup();
    const { accessToken } = await register(h, "loop@example.com", "loop_user");

    const res = await createClient(h, accessToken, {
      redirect_uris: ["http://localhost:3000/callback", "http://127.0.0.1:8080/cb"],
    });
    expect(res.status).toBe(201);
  });

  it("caps live clients per account and frees the slot on disable", async () => {
    const h = setup();
    const { accessToken } = await register(h, "cap@example.com", "cap_user");

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Distinct IPs so the per-account cap — not the per-IP limiter — is
      // what the sixth call trips over.
      const res = await createClient(h, accessToken, { name: `RP ${i}` }, `10.0.0.${i + 1}`);
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { client: { clientId: string } }).client.clientId);
    }
    const sixth = await createClient(h, accessToken, { name: "RP 5" }, "10.0.0.6");
    expect(sixth.status).toBe(400);

    // Disabling one frees a slot — the cap counts LIVE clients.
    await h.app.handle(
      new Request(`http://localhost/oidc/clients/${ids[0]}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    expect((await createClient(h, accessToken, { name: "RP again" }, "10.0.0.7")).status).toBe(201);
  });
});

describe("GET /oidc/clients + DELETE /oidc/clients/:clientId", () => {
  it("lists only the caller's clients and 404s a foreign disable", async () => {
    const h = setup();
    const owner = await register(h, "owner2@example.com", "owner2_user");
    const other = await register(h, "other2@example.com", "other2_user");

    const created = await createClient(h, owner.accessToken);
    const { client } = (await created.json()) as { client: { clientId: string } };

    const otherList = await h.app.handle(
      new Request("http://localhost/oidc/clients", {
        headers: { authorization: `Bearer ${other.accessToken}` },
      }),
    );
    expect(((await otherList.json()) as { clients: unknown[] }).clients).toHaveLength(0);

    // Another account cannot disable it — and learns nothing from the 404.
    const foreign = await h.app.handle(
      new Request(`http://localhost/oidc/clients/${client.clientId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${other.accessToken}` },
      }),
    );
    expect(foreign.status).toBe(404);

    const own = await h.app.handle(
      new Request(`http://localhost/oidc/clients/${client.clientId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      }),
    );
    expect(own.status).toBe(200);

    // Second disable finds nothing live.
    const again = await h.app.handle(
      new Request(`http://localhost/oidc/clients/${client.clientId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      }),
    );
    expect(again.status).toBe(404);
  });

  it("makes a disabled client read as unknown at /authorize", async () => {
    const h = setup();
    const { accessToken } = await register(h, "disable@example.com", "disable_user");
    const created = await createClient(h, accessToken);
    const { client } = (await created.json()) as { client: { clientId: string } };

    await h.app.handle(
      new Request(`http://localhost/oidc/clients/${client.clientId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );

    const url = new URL("http://localhost/authorize");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await h.app.handle(new Request(url.toString()));
    // Rendered invalid_client — same as a client that never existed.
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("end to end: a self-registered client completes the full flow", () => {
  it("register client → authorize → consent → token, no operator involved", async () => {
    const h = setup();
    const dev = await register(h, "founder@example.com", "founder_user");
    const created = await createClient(h, dev.accessToken, { confidential: true });
    const { client, client_secret } = (await created.json()) as {
      client: { clientId: string };
      client_secret: string;
    };

    // A different person signs in and authorises the new app.
    const user = await register(h, "enduser@example.com", "enduser_user");
    const url = new URL("http://localhost/authorize");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile");
    url.searchParams.set("state", "st_e2e");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");

    const authRes = await h.app.handle(
      new Request(url.toString(), { headers: { cookie: user.cookie } }),
    );
    const requestId = new URL(authRes.headers.get("location")!).searchParams.get("request")!;
    const binding = (authRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const cookie = `${user.cookie}; ${binding}`;

    const ctxRes = await h.app.handle(
      new Request(`http://localhost/authorize/context?request=${requestId}`, {
        headers: { cookie },
      }),
    );
    const { profiles } = (await ctxRes.json()) as { profiles: { id: string }[] };

    const decisionRes = await h.app.handle(
      new Request("http://localhost/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ requestId, profileId: profiles[0]!.id, approved: true }),
      }),
    );
    const { redirectTo } = (await decisionRes.json()) as { redirectTo: string };
    const code = new URL(redirectTo).searchParams.get("code")!;

    const tokenRes = await h.app.handle(
      new Request("http://localhost/oidc/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          client_id: client.clientId,
          client_secret,
        }).toString(),
      }),
    );

    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { id_token: string };
    const claims = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { sub: string; aud: string };
    expect(claims.sub).toMatch(/^pw_/);
    expect(claims.aud).toBe(client.clientId);
  });
});
