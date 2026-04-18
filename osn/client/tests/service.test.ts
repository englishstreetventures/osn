import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createMemoryStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com", clientId: "test-client" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createMemoryStorage()));
}

type JsonResponse = { status?: number; body: unknown };

function stubFetchByPath(handlers: Record<string, JsonResponse>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const pathname = new URL(url).pathname;
      const match = handlers[pathname];
      if (!match) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "Unstubbed path: " + pathname }),
        });
      }
      return Promise.resolve({
        ok: (match.status ?? 200) < 400,
        status: match.status ?? 200,
        json: () => Promise.resolve(match.body),
      });
    }),
  );
}

const meResponse = {
  profile: {
    id: "usr_abc",
    handle: "alice",
    email: "alice@example.com",
    displayName: "Alice",
    avatarUrl: null,
  },
  activeProfileId: "usr_abc",
  scopes: ["openid", "profile"],
};

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

it.effect("handleCallback exchanges code, resolves /me and persists session", () =>
  Effect.gen(function* () {
    stubFetchByPath({
      "/token": {
        body: {
          access_token: "acc_123",
          id_token: "id_789",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile",
        },
      },
      "/me": { body: meResponse },
    });

    const auth = yield* OsnAuth;
    const { state } = yield* auth.startLogin({ redirectUri: "http://localhost/callback" });
    const session = yield* auth.handleCallback({
      code: "code_xyz",
      state,
      redirectUri: "http://localhost/callback",
    });

    expect(session.accessToken).toBe("acc_123");
    expect(session.idToken).toBe("id_789");
    expect(session.scopes).toEqual(["openid", "profile"]);

    const stored = yield* auth.getSession();
    expect(stored?.accessToken).toBe("acc_123");

    const activeProfileId = yield* auth.getActiveProfile();
    expect(activeProfileId).toBe("usr_abc");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("logout clears the persisted session", () =>
  Effect.gen(function* () {
    stubFetchByPath({
      "/token": {
        body: { access_token: "acc_123", expires_in: 3600, token_type: "Bearer" },
      },
      "/me": { body: meResponse },
      "/logout": { body: { success: true } },
    });

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

it.effect("setSession resolves /me and persists the session", () =>
  Effect.gen(function* () {
    stubFetchByPath({ "/me": { body: meResponse } });

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "acc_persisted",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    const stored = yield* auth.getSession();
    expect(stored).not.toBeNull();
    expect(stored?.accessToken).toBe("acc_persisted");
    expect(stored?.scopes).toEqual(["openid", "profile"]);

    const activeProfileId = yield* auth.getActiveProfile();
    expect(activeProfileId).toBe("usr_abc");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("setSession overwrites a previously persisted session", () =>
  Effect.gen(function* () {
    stubFetchByPath({ "/me": { body: meResponse } });

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "first",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    });
    yield* auth.setSession({
      accessToken: "second",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    });

    const stored = yield* auth.getSession();
    expect(stored?.accessToken).toBe("second");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("me() returns the profile + activeProfileId + scopes from the server", () =>
  Effect.gen(function* () {
    stubFetchByPath({ "/me": { body: meResponse } });

    const auth = yield* OsnAuth;
    yield* auth.setSession({
      accessToken: "acc_me",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    const result = yield* auth.me();
    expect(result.profile.id).toBe("usr_abc");
    expect(result.profile.handle).toBe("alice");
    expect(result.activeProfileId).toBe("usr_abc");
    expect(result.scopes).toEqual(["openid", "profile"]);

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("me() fails with ProfileManagementError when there is no session", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;
    const err = yield* Effect.flip(auth.me());
    expect(err._tag).toBe("ProfileManagementError");
  }).pipe(Effect.provide(createTestLayer())),
);
