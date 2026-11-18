import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOsnAuthRuntime, type OsnAuthRuntime } from "../src/runtime";
import { OsnAuth, type OsnAuthService } from "../src/service";
import { Storage, createEphemeralStorage } from "../src/storage";

/**
 * What the client keeps in storage: the stored account, and never a token.
 *
 * Page script can read storage, so a token there is a token any injected
 * script can carry off the page. The stored account holds only what a reload
 * needs that is not a credential — whether a session is held, and the profile
 * the page was on — and a reload gets its token from the HttpOnly cookie
 * (NEW-FEAT.md F39–F42b). A runtime built on storage another runtime used
 * stands for a reload.
 */

const ISSUER = "https://osn.example.com";
const API = `${ISSUER}/thing`;
const KEY = "@osn/client:account_session";
const DEFAULT = "usr_default00001";
const OTHER = "usr_other0000001";

afterEach(() => {
  vi.unstubAllGlobals();
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** An unsigned JWT: the client reads `sub`, `iat` and `exp` without verifying. */
function jwt(claims: { sub: string; n: number; aud?: string }): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "none" })}.${enc({ ...claims, iat: nowSec(), exp: nowSec() + 300 })}.sig`;
}

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Every token and ID token the stub issuer handed out, to look for in storage. */
let issued: string[] = [];
let grants = 0;

/** `/token`: a fresh access token and ID token for the profile the grant named, else the default. */
function grant(call: Call): Response {
  grants += 1;
  const sub = new URLSearchParams(String(call.init.body)).get("profile_id") ?? DEFAULT;
  const accessToken = jwt({ sub, n: grants });
  const idToken = jwt({ sub, n: grants, aud: "musubi" });
  issued.push(accessToken, idToken);
  return json(200, {
    access_token: accessToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 300,
    scope: "openid profile",
  });
}

const profile = (id: string) => ({
  id,
  handle: id,
  email: `${id}@example.com`,
  displayName: null,
  avatarUrl: null,
});

/** Stubs `fetch`: `/token` and the profile routes as osn-api answers them, anything else 200. */
function stubFetch(token: (call: Call) => Response | Promise<Response> = grant) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      if (call.url === `${ISSUER}/token`) return token(call);
      if (call.url === `${ISSUER}/profiles/switch`) {
        const id = (JSON.parse(String(call.init.body)) as { profile_id: string }).profile_id;
        const accessToken = jwt({ sub: id, n: 1000 + calls.length });
        issued.push(accessToken);
        return json(200, { access_token: accessToken, expires_in: 300, profile: profile(id) });
      }
      if (call.url === `${ISSUER}/profiles/delete`) return json(200, { ok: true });
      return json(200, { ok: true });
    }),
  );
  issued = [];
  grants = 0;
  return {
    calls,
    to: (path: string) => calls.filter((c) => c.url === `${ISSUER}${path}`),
    api: () => calls.filter((c) => c.url === API),
  };
}

const namedProfile = (call: Call | undefined) =>
  call ? new URLSearchParams(String(call.init.body)).get("profile_id") : null;

const bearer = (call: Call | undefined) =>
  call ? new Headers(call.init.headers).get("authorization") : null;

/** A `Storage` over `inner` that records every value written. */
function recording(inner = createEphemeralStorage()) {
  const writes: string[] = [];
  const layer = Layer.effect(
    Storage,
    Effect.map(Storage, (s) => ({
      get: s.get,
      remove: s.remove,
      set: (key: string, value: string) => {
        writes.push(value);
        return s.set(key, value);
      },
    })),
  ).pipe(Layer.provide(inner));
  return { layer, writes, inner };
}

function write(storage: Layer.Layer<Storage>, value: unknown) {
  Effect.runSync(
    Effect.flatMap(Storage, (s) => s.set(KEY, JSON.stringify(value))).pipe(Effect.provide(storage)),
  );
}

function read(storage: Layer.Layer<Storage>): unknown {
  const raw = Effect.runSync(
    Effect.flatMap(Storage, (s) => s.get(KEY)).pipe(Effect.provide(storage)),
  );
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

const page = (storage: Layer.Layer<Storage>) =>
  createOsnAuthRuntime({ issuerUrl: ISSUER }, { storage });

const run = <A, E>(runtime: OsnAuthRuntime, f: (auth: OsnAuthService) => Effect.Effect<A, E>) =>
  runtime.run(Effect.flatMap(OsnAuth, f));

describe("the stored account", () => {
  it("F39: nothing written to storage holds a token, on any path", async () => {
    const fetches = stubFetch();
    const storage = recording();
    const runtime = page(storage.layer);

    // Sign-in hands the page a session; the page renews, switches, deletes.
    const signIn = jwt({ sub: DEFAULT, n: 0 });
    const signInId = jwt({ sub: DEFAULT, n: 0, aud: "musubi" });
    issued.push(signIn, signInId);
    await run(runtime, (auth) =>
      auth.setSession({
        accessToken: signIn,
        idToken: signInId,
        expiresAt: Date.now() - 1_000,
        scopes: ["openid"],
      }),
    );
    await runtime.authFetch(API);
    await run(runtime, (auth) => auth.switchProfile(OTHER));
    await runtime.authFetch(API);
    await run(runtime, (auth) => auth.deleteProfile(OTHER));
    // A reload on the same storage.
    const reloaded = page(storage.layer);
    expect(await run(reloaded, (auth) => auth.loadSession())).not.toBeNull();
    await reloaded.authFetch(API);

    expect(fetches.to("/token").length).toBeGreaterThanOrEqual(2);
    expect(storage.writes.length).toBeGreaterThanOrEqual(4);
    for (const value of storage.writes) {
      for (const token of issued) expect(value).not.toContain(token);
      expect(JSON.parse(value)).toEqual({
        hasSession: true,
        activeProfileId: expect.any(String),
        signInId: expect.any(String),
      });
    }
  });

  it("F40: an account stored with its tokens loses them on the first read, and the token is never sent", async () => {
    const fetches = stubFetch();
    const storage = createEphemeralStorage();
    const stale = jwt({ sub: DEFAULT, n: -1 });
    write(storage, {
      hasSession: true,
      activeProfileId: DEFAULT,
      profileTokens: { [DEFAULT]: { accessToken: stale, expiresAt: Date.now() + 120_000 } },
      scopes: ["openid"],
      idToken: jwt({ sub: DEFAULT, n: -1, aud: "musubi" }),
    });
    const runtime = page(storage);

    const res = await runtime.authFetch(API);

    expect(res.status).toBe(200);
    expect(read(storage)).toEqual({
      hasSession: true,
      activeProfileId: DEFAULT,
      signInId: expect.any(String),
    });
    expect(fetches.to("/token")).toHaveLength(1);
    expect(bearer(fetches.api()[0])).not.toBe(`Bearer ${stale}`);
  });

  it("F41: a reload with a live cookie stays signed in, as the profile it was on", async () => {
    const fetches = stubFetch();
    const storage = createEphemeralStorage();
    const before = page(storage);
    await run(before, (auth) =>
      auth.setSession({
        accessToken: jwt({ sub: DEFAULT, n: 0 }),
        idToken: null,
        expiresAt: Date.now() + 120_000,
        scopes: [],
      }),
    );
    await run(before, (auth) => auth.switchProfile(OTHER));

    const reloaded = page(storage);
    const session = await run(reloaded, (auth) => auth.loadSession());

    expect(session).not.toBeNull();
    expect(fetches.to("/token")).toHaveLength(1);
    expect(namedProfile(fetches.to("/token")[0])).toBe(OTHER);
    expect(await run(reloaded, (auth) => auth.getActiveProfile())).toBe(OTHER);
    await reloaded.authFetch(API);
    expect(fetches.to("/token")).toHaveLength(1);
    expect(bearer(fetches.api()[0])).toBe(`Bearer ${session!.accessToken}`);
  });

  it("F41b: a reload's grant and a renewal for the same profile send one grant", async () => {
    const fetches = stubFetch(
      (call) => new Promise((resolve) => setTimeout(() => resolve(grant(call)), 10)),
    );
    const storage = createEphemeralStorage();
    write(storage, { hasSession: true, activeProfileId: OTHER });
    const runtime = page(storage);

    const [session, res] = await Promise.all([
      run(runtime, (auth) => auth.loadSession()),
      runtime.authFetch(API),
    ]);

    expect(session).not.toBeNull();
    expect(res.status).toBe(200);
    expect(fetches.to("/token").map(namedProfile)).toEqual([OTHER]);
  });

  it("F42: a reload whose grant is refused is signed out and forgets the stored account", async () => {
    // A browser with no marker cookie: with no stored account, a load sends nothing.
    vi.stubGlobal("document", { cookie: "" });
    const fetches = stubFetch(() =>
      json(400, { error: "invalid_grant", message: "AuthError: Invalid or expired session" }),
    );
    const storage = createEphemeralStorage();
    write(storage, { hasSession: true, activeProfileId: DEFAULT });

    expect(await run(page(storage), (auth) => auth.loadSession())).toBeNull();
    expect(read(storage)).toBeNull();
    expect(fetches.to("/token")).toHaveLength(1);

    // The next reload has nothing to redeem and asks for nothing.
    expect(await run(page(storage), (auth) => auth.loadSession())).toBeNull();
    expect(fetches.to("/token")).toHaveLength(1);
  });

  it("F42b: a reload whose grant fails for now keeps the stored account for the next one", async () => {
    const fetches = stubFetch(() => json(503, { error: "upstream" }));
    const storage = createEphemeralStorage();
    write(storage, { hasSession: true, activeProfileId: DEFAULT });

    expect(await run(page(storage), (auth) => auth.loadSession())).toBeNull();

    expect(fetches.to("/token")).toHaveLength(3);
    expect(read(storage)).toMatchObject({ hasSession: true, activeProfileId: DEFAULT });
  });
});
