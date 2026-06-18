import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createMemoryStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createMemoryStorage()));
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

      vi.unstubAllGlobals();
    }).pipe(Effect.provide(createTestLayer())),
);

it.effect(
  "loadSession resolves to null when there is no account and the cookie is gone/expired",
  () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
        .mockImplementation((input) => {
          const url = typeof input === "string" ? input : ((input as Request).url ?? "");
          if (url.endsWith("/token")) {
            return Promise.resolve(mockResponse(401, { error: "invalid_grant" }));
          }
          return Promise.resolve(mockResponse(404));
        });
      vi.stubGlobal("fetch", fetchMock);

      const auth = yield* OsnAuth;

      // No account, cookie rejected → genuinely logged out. Must resolve null,
      // not throw (a throw would bubble through Effect.orDie and crash the page).
      const session = yield* auth.loadSession();
      expect(session).toBeNull();

      vi.unstubAllGlobals();
    }).pipe(Effect.provide(createTestLayer())),
);

it.effect(
  "loadSession returns the existing session without hitting /token when an account is present",
  () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
        .mockResolvedValue(mockResponse(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      const auth = yield* OsnAuth;
      yield* auth.setSession({
        accessToken: fakeJwt("usr_existing0001"),
        idToken: null,
        expiresAt: Date.now() + 60_000,
        scopes: ["openid", "profile"],
      });

      const session = yield* auth.loadSession();
      expect(session).not.toBeNull();

      // No /token call: we already have a valid local account.
      const tokenCalls = fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : ((input as Request).url ?? "");
        return url.endsWith("/token");
      });
      expect(tokenCalls).toHaveLength(0);

      vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);
