import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createEphemeralStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createEphemeralStorage()));
}

/**
 * An unsigned access token named `name`, for one profile: renewal files a
 * token under the profile its `sub` names, so every token here names the same.
 */
const tok = (name: string) => {
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc({ sub: "usr_service00001", name })}.sig`;
};

it.effect("refreshSession fails when there is no session", () =>
  Effect.gen(function* () {
    const auth = yield* OsnAuth;

    // No session set — refreshSession should fail
    const error = yield* Effect.flip(auth.refreshSession());
    expect(error._tag).toBe("TokenRefreshError");
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
              access_token: tok("refreshed"),
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
      accessToken: tok("stale"),
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["openid", "profile"],
    });

    const res = yield* auth.authFetch("https://osn.example.com/api/thing");
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);

    // The retry should use the refreshed access token.
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const headers = new Headers(lastCall[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${tok("refreshed")}`);

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);
