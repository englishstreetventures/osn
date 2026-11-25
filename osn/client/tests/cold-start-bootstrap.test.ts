import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createEphemeralStorage } from "../src/storage";
import { fakeSleeps, untilSettled } from "./helpers/fake-sleeps";

const config = { issuerUrl: "https://osn.example.com" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createEphemeralStorage()));
}

/** Build a fake JWT whose payload contains the given `sub` claim. */
function fakeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, iat: Date.now() }));
  return `${header}.${payload}.fake_signature`;
}

function mockResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Cold-start bootstrap (the production login-loop regression test).
//
// After a full-page navigation post-login, a fresh AuthProvider has NO stored
// account but the HttpOnly refresh cookie that /login/passkey/complete set is
// still alive. loadSession() must replay that cookie against /token and
// reconstruct a session, instead of treating "no local account" as logged-out.
// ---------------------------------------------------------------------------

it.effect(
  "loadSession bootstraps a session from the /token cookie when there is no stored account",
  () =>
    Effect.gen(function* () {
      const profileId = "usr_coldstart01";
      let tokenCallInit: RequestInit | undefined;
      const fetchMock = vi
        .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
        .mockImplementation((input, init) => {
          const url = typeof input === "string" ? input : ((input as Request).url ?? "");
          if (url.endsWith("/token")) {
            tokenCallInit = init;
            return Promise.resolve(
              mockResponse(200, {
                access_token: fakeJwt(profileId),
                token_type: "Bearer",
                expires_in: 300,
                scope: "openid profile",
              }),
            );
          }
          return Promise.resolve(mockResponse(404));
        });
      vi.stubGlobal("fetch", fetchMock);

      const auth = yield* OsnAuth;

      // No setSession — simulates a cold page load with only the cookie present.
      const session = yield* auth.loadSession();

      expect(session).not.toBeNull();
      expect(session?.scopes).toEqual(["openid", "profile"]);

      // A /token POST with credentials: include was made (replays the cookie).
      const tokenCall = fetchMock.mock.calls.find(([input]) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        return url.endsWith("/token");
      });
      expect(tokenCall).toBeDefined();
      expect(tokenCallInit?.credentials).toBe("include");
      expect(tokenCallInit?.method).toBe("POST");

      // The reconstructed account is persisted: a subsequent getSession sees it.
      const persisted = yield* auth.getSession();
      expect(persisted).not.toBeNull();
      expect(persisted?.accessToken).toBe(session?.accessToken);

      // The active profile is the access token's `sub`.
      const active = yield* auth.getActiveProfile();
      expect(active).toBe(profileId);
    }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// An account with no valid access token in hand (the "logged out on every
// reload" regression). Access tokens have a short (5 min) TTL and live only in
// memory, so a reloaded page holds none, and a long-open one holds an expired
// one. loadSession must rehydrate from the still-alive refresh cookie via
// /token instead of reporting the user as logged out.
// ---------------------------------------------------------------------------

it.effect("loadSession rehydrates from the cookie when the stored access token has expired", () =>
  Effect.gen(function* () {
    const profileId = "usr_reload000001";
    let tokenCalls = 0;
    const freshToken = fakeJwt(profileId);
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          return Promise.resolve(
            mockResponse(200, {
              access_token: freshToken,
              token_type: "Bearer",
              expires_in: 300,
              scope: "openid profile",
            }),
          );
        }
        return Promise.resolve(mockResponse(404));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;

    // Hold an account whose access token has ALREADY expired — a page left
    // open past the token's 5 minutes.
    yield* auth.setSession({
      accessToken: fakeJwt(profileId),
      idToken: null,
      expiresAt: Date.now() - 1_000,
      scopes: ["openid", "profile"],
    });

    const session = yield* auth.loadSession();

    // Stayed logged in: a fresh session was minted from the cookie.
    expect(session).not.toBeNull();
    expect(session?.accessToken).toBe(freshToken);
    expect(tokenCalls).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("loadSession does NOT call /token when the stored access token is still valid", () =>
  Effect.gen(function* () {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) tokenCalls += 1;
        return Promise.resolve(mockResponse(200, {}));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: fakeJwt("usr_stillvalid01"),
      idToken: null,
      expiresAt: Date.now() + 120_000,
      scopes: ["openid", "profile"],
    });

    const session = yield* auth.loadSession();
    expect(session).not.toBeNull();
    // Fast path: the cached token is live, so the cookie is never replayed.
    expect(tokenCalls).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// Transient /token failures must be retried with backoff — a single cold
// Worker isolate, 429, 5xx, or network blip must not evict a live session.
// A terminal 4xx invalid_grant must NOT be retried (cookie is genuinely gone).
// ---------------------------------------------------------------------------

it.effect("fetchTokenGrant does NOT retry a terminal 401 invalid_grant", () =>
  Effect.gen(function* () {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          return Promise.resolve(mockResponse(401, { error: "invalid_grant" }));
        }
        return Promise.resolve(mockResponse(404));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    const session = yield* auth.loadSession();

    // Genuinely logged out — null, and only ONE attempt (no pointless retries).
    expect(session).toBeNull();
    expect(tokenCalls).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("loadSession single-flights — concurrent cold-start loads fire ONE /token", () =>
  Effect.gen(function* () {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          // Widen the race window so concurrent callers overlap.
          return new Promise((resolve) =>
            setTimeout(() => {
              resolve(
                mockResponse(200, {
                  access_token: fakeJwt("usr_concurrent01"),
                  token_type: "Bearer",
                  expires_in: 300,
                  scope: "openid profile",
                }),
              );
            }, 10),
          );
        }
        return Promise.resolve(mockResponse(404));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;

    const [s1, s2, s3] = yield* Effect.all(
      [auth.loadSession(), auth.loadSession(), auth.loadSession()],
      { concurrency: "unbounded" },
    );

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();
    // Replaying a rotated cookie a second time trips reuse detection — only ONE.
    expect(tokenCalls).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// Shared /token single-flight ACROSS paths: a bootstrap (loadSession) racing a
// 401-refresh (refreshSession) in the same tab must fire /token exactly ONCE.
// Before the shared grant, loadSession and refreshSession kept SEPARATE
// single-flight guards, so on a reload with an expired access token the two
// paths fired two concurrent /token grants against the same cookie — the
// second replayed the just-rotated cookie. This is the client half of the
// "logs out sometimes" fix.
// ---------------------------------------------------------------------------
it.effect("loadSession bootstrap racing refreshSession fires exactly ONE /token", () =>
  Effect.gen(function* () {
    const profileId = "usr_sharedgrant01";
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          // Resolve on a later microtask so both concurrent callers are
          // guaranteed to join the same in-flight grant.
          return Promise.resolve().then(() =>
            mockResponse(200, {
              access_token: fakeJwt(profileId),
              token_type: "Bearer",
              expires_in: 300,
              scope: "openid profile",
            }),
          );
        }
        return Promise.resolve(mockResponse(404));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;

    // Seed a stored account whose access token is already EXPIRED but which
    // still believes it has a server session — the common reload state. This
    // makes loadSession take the bootstrap-from-cookie branch while
    // refreshSession takes the refresh branch; both hit the shared grant.
    yield* auth.setSession({
      accessToken: fakeJwt(profileId),
      idToken: null,
      expiresAt: Date.now() - 1000,
      scopes: ["openid", "profile"],
    });

    const [loaded, refreshed] = yield* Effect.all([auth.loadSession(), auth.refreshSession()], {
      concurrency: "unbounded",
    });

    expect(loaded).not.toBeNull();
    expect(refreshed.accessToken).toBeTruthy();
    // The whole point: cross-path dedupe → a single /token roundtrip.
    expect(tokenCalls).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// Session marker gate.
//
// A browser that has never held a session has nothing for /token to redeem,
// and the grant it fires anyway is what a bot fleet turns into ~46k requests a
// day against the issuer. The server sets a readable `osn_has_session` cookie
// beside the HttpOnly one; no marker ⇒ no bootstrap grant.
// ---------------------------------------------------------------------------

/** Count /token calls against a fetch that would succeed if it were reached. */
function countingTokenFetch(profileId: string) {
  let tokenCalls = 0;
  const fetchMock = vi
    .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
    .mockImplementation((input) => {
      const url = typeof input === "string" ? input : ((input as Request).url ?? "");
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        return Promise.resolve(
          mockResponse(200, {
            access_token: fakeJwt(profileId),
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid profile",
          }),
        );
      }
      return Promise.resolve(mockResponse(404));
    });
  return { fetchMock, calls: () => tokenCalls };
}

it.effect("loadSession fires ZERO /token calls when the browser holds no marker", () =>
  Effect.gen(function* () {
    const { fetchMock, calls } = countingTokenFetch("usr_nomarker001");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "theme=dark; locale=en-AU" });

    const auth = yield* OsnAuth;
    const session = yield* auth.loadSession();

    expect(session).toBeNull();
    expect(calls()).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("loadSession still bootstraps from the cookie when the marker is present", () =>
  Effect.gen(function* () {
    const { fetchMock, calls } = countingTokenFetch("usr_marker001");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "theme=dark; osn_has_session=1" });

    const auth = yield* OsnAuth;
    const session = yield* auth.loadSession();

    expect(session).not.toBeNull();
    expect(calls()).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// A CORS refusal is indistinguishable from a network blip — both surface as an
// opaque TypeError. Retrying the full ladder turned every blocked page load
// into three requests, so the network path retries once, not twice.
// ---------------------------------------------------------------------------

it.effect("a CORS/network TypeError is attempted twice, not three times", () =>
  Effect.gen(function* () {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve(mockResponse(404));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    fakeSleeps();
    const loading = Effect.runPromise(auth.loadSession());
    const session = yield* Effect.promise(() => untilSettled(loading));

    expect(session).toBeNull();
    expect(tokenCalls).toBe(2);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// A cookie whose session may only enrol a passkey: a sign-up before its first
// passkey, or an account recovery. `/token` renews it onto `osn-recovery`,
// which every ordinary route refuses, so publishing it would show a signed-in
// page that cannot load anything. The page stays signed out; the view that
// enrols the passkey holds that session itself (`refreshHeldSession`).
// ---------------------------------------------------------------------------

/** A fake JWT on the given audience. */
function fakeJwtFor(sub: string, aud: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, aud, iat: Date.now() }));
  return `${header}.${payload}.fake_signature`;
}

it.effect("loadSession publishes no session when the cookie's grant is a restricted one", () =>
  Effect.gen(function* () {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          return Promise.resolve(
            mockResponse(200, {
              access_token: fakeJwtFor("usr_restricted01", "osn-recovery"),
              token_type: "Bearer",
              expires_in: 300,
              scope: "openid profile",
            }),
          );
        }
        return Promise.resolve(mockResponse(404));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    const session = yield* auth.loadSession();

    expect(session).toBeNull();
    expect(tokenCalls).toBe(1);
    // Nothing stored: the next load asks the cookie again rather than holding
    // a token no route serves.
    expect(yield* auth.getSession()).toBeNull();
    expect(yield* auth.getActiveProfile()).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);
