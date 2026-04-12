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

it.effect("refreshSession fails when there is no refresh token", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            access_token: "acc_123",
            expires_in: 3600,
            token_type: "Bearer",
            // no refresh_token
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

    const error = yield* Effect.flip(auth.refreshSession());
    expect(error._tag).toBe("TokenRefreshError");

    vi.unstubAllGlobals();
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
