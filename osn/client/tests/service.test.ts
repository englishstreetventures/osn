import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createMemoryStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com", clientId: "test-client" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createMemoryStorage()));
}

it.effect("startLogin returns a valid authorization URL with PKCE params", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const { authorizationUrl, state } = yield* auth.startLogin({
      redirectUri: "http://localhost/callback",
    });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://osn.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(state);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("getSession returns null before any login", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const session = yield* auth.getSession();
    expect(session).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("handleCallback fails with StateMismatchError on wrong state", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    yield* auth.startLogin({ redirectUri: "http://localhost/callback" });
    const error = yield* Effect.flip(
      auth.handleCallback({
        code: "abc",
        state: "wrong-state",
        redirectUri: "http://localhost/callback",
      }),
    );
    expect(error._tag).toBe("StateMismatchError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("handleCallback exchanges code and persists session", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            access_token: "acc_123",
            refresh_token: "ref_456",
            id_token: "id_789",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid profile",
          }),
      }),
    );

    const auth = yield* OsnAuth;
    const { state } = yield* auth.startLogin({ redirectUri: "http://localhost/callback" });
    const session = yield* auth.handleCallback({
      code: "code_xyz",
      state,
      redirectUri: "http://localhost/callback",
    });

    expect(session.accessToken).toBe("acc_123");
    expect(session.refreshToken).toBe("ref_456");
    expect(session.idToken).toBe("id_789");
    expect(session.scopes).toEqual(["openid", "profile"]);

    const stored = yield* auth.getSession();
    expect(stored?.accessToken).toBe("acc_123");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("logout clears the persisted session", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            access_token: "acc_123",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      }),
    );

    const auth = yield* OsnAuth;
    const { state } = yield* auth.startLogin({ redirectUri: "http://localhost/callback" });
    yield* auth.handleCallback({
      code: "code_xyz",
      state,
      redirectUri: "http://localhost/callback",
    });
    yield* auth.logout();

    const session = yield* auth.getSession();
    expect(session).toBeNull();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("refreshSession fails when there is no session", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;

    // No session set — refreshSession should fail
    const error = yield* Effect.flip(auth.refreshSession());
    expect(error._tag).toBe("TokenRefreshError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("setSession persists a session that getSession can read back", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const fixture = {
      accessToken: "acc_persisted",
      refreshToken: "ref_persisted",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    };
    yield* auth.setSession(fixture);

    const stored = yield* auth.getSession();
    expect(stored).not.toBeNull();
    expect(stored?.accessToken).toBe("acc_persisted");
    expect(stored?.refreshToken).toBe("ref_persisted");
    expect(stored?.scopes).toEqual(["openid", "profile"]);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("setSession overwrites a previously persisted session", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "first",
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    });
    yield* auth.setSession({
      accessToken: "second",
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    });

    const stored = yield* auth.getSession();
    expect(stored?.accessToken).toBe("second");
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// authFetch — silent refresh on 401
// ---------------------------------------------------------------------------

function mockResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

it.effect("authFetch attaches Authorization and returns the 200 response directly", () =>
  Effect.gen(function* () {
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValue(mockResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "acc_live",
      refreshToken: "ref_live",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    const res = yield* auth.authFetch("https://api.example.com/thing");
    expect(res.status).toBe(200);

    // Exactly one call, with the expected Authorization header.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer acc_live");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("authFetch silent-refreshes on 401 and retries once", () =>
  Effect.gen(function* () {
    let callCount = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          return Promise.resolve(
            mockResponse(200, {
              access_token: "acc_refreshed",
              token_type: "Bearer",
              expires_in: 300,
              scope: "openid profile",
            }),
          );
        }
        callCount += 1;
        return Promise.resolve(
          callCount === 1 ? mockResponse(401) : mockResponse(200, { ok: true }),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "acc_stale",
      refreshToken: "ref_live",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    const res = yield* auth.authFetch("https://api.example.com/thing");
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);

    // The retry should use the refreshed access token.
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const headers = new Headers(lastCall[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer acc_refreshed");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("authFetch surfaces AuthExpiredError when refresh fails", () =>
  Effect.gen(function* () {
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          return Promise.resolve(mockResponse(401, { error: "invalid_grant" }));
        }
        return Promise.resolve(mockResponse(401));
      });
    vi.stubGlobal("fetch", fetchMock);

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "acc_stale",
      refreshToken: "ref_stale",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    const err = yield* Effect.flip(auth.authFetch("https://api.example.com/thing"));
    expect(err._tag).toBe("AuthExpiredError");

    // Cached session should be cleared — the next getSession returns null.
    const stored = yield* auth.getSession();
    expect(stored).toBeNull();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("authFetch fails with AuthExpiredError when there is no session", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const err = yield* Effect.flip(auth.authFetch("https://api.example.com/thing"));
    expect(err._tag).toBe("AuthExpiredError");
  }).pipe(Effect.provide(createTestLayer())),
);

// S-H1 / P-W1: single-flight refresh. Parallel 401s must fire exactly ONE
// /token roundtrip — a second roundtrip would replay the rotated-out cookie
// and trip C2 reuse detection, revoking every session in the family.
it.effect("authFetch dedupes concurrent refreshes — only ONE /token roundtrip fires", () =>
  Effect.gen(function* () {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          // Slow the refresh to widen the race window.
          return new Promise((resolve) =>
            setTimeout(() => {
              resolve(
                mockResponse(200, {
                  access_token: "acc_refreshed",
                  token_type: "Bearer",
                  expires_in: 300,
                  scope: "openid profile",
                }),
              );
            }, 10),
          );
        }
        // First call on each resource 401s; further calls (the retry) 200.
        return Promise.resolve(
          url.includes("retry") ? mockResponse(200, { ok: true }) : mockResponse(401),
        );
      });

    // Second-call recognition: after the refresh, subsequent requests should
    // carry the new token; mark-and-return on the retry path.
    const mockWithRetry = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementation((input, init) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        const headers = new Headers(init?.headers);
        const bearer = headers.get("authorization") ?? "";
        if (url.endsWith("/token")) {
          tokenCalls += 1;
          return new Promise((resolve) =>
            setTimeout(() => {
              resolve(
                mockResponse(200, {
                  access_token: "acc_refreshed",
                  token_type: "Bearer",
                  expires_in: 300,
                  scope: "openid profile",
                }),
              );
            }, 10),
          );
        }
        // Respond 200 only if the call is using the refreshed token.
        return Promise.resolve(
          bearer.includes("acc_refreshed") ? mockResponse(200, { ok: true }) : mockResponse(401),
        );
      });
    vi.stubGlobal("fetch", mockWithRetry);
    void fetchMock; // silence unused; kept above for readability

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "acc_stale",
      refreshToken: "ref_live",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    // Fire three authFetch calls in parallel — all will 401 and all will
    // trigger the refresh path. With single-flight, only ONE /token call fires.
    const [r1, r2, r3] = yield* Effect.all(
      [
        auth.authFetch("https://api.example.com/a"),
        auth.authFetch("https://api.example.com/b"),
        auth.authFetch("https://api.example.com/c"),
      ],
      { concurrency: "unbounded" },
    );

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    // The critical assertion — without single-flight, this would be 3.
    expect(tokenCalls).toBe(1);

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);
