import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { createEphemeralStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createEphemeralStorage()));
}

function fakeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, aud: "osn-recovery" }));
  return `${header}.${payload}.fake_signature`;
}

/** A restricted recovery session's access token, as the issuer would mint it. */
const RECOVERY_TOKEN = fakeJwt("usr_recovering");

function mockResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Records every call so a test can assert on the `/token` grant specifically.
 * `sessionFetch` reads the global `fetch` per call, so stubbing the global
 * reaches the grant.
 */
function stubTokenEndpoint(respond: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchMock = vi
    .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
    .mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : ((input as Request).url ?? "");
      calls.push({ url, init });
      if (url.endsWith("/token")) return Promise.resolve(respond());
      return Promise.resolve(mockResponse(404));
    });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

// ---------------------------------------------------------------------------
// `refreshHeldSession` — the grant for a flow that holds a session instead of
// publishing one.
//
// Post-recovery passkey enrolment is the caller. Its token carries
// `aud: "osn-recovery"`, which every ordinary route rejects, so adopting it
// would announce a signed-in user the app cannot serve — and holding it puts
// the flow outside `authFetch`, where the silent refresh lives. This method is
// the replacement, and the two properties below are the whole contract.
// ---------------------------------------------------------------------------

it.effect("redeems the refresh cookie and returns the new token set", () =>
  Effect.gen(function* () {
    const calls = stubTokenEndpoint(() =>
      mockResponse(200, {
        access_token: RECOVERY_TOKEN,
        token_type: "Bearer",
        expires_in: 90,
        scope: "openid profile",
      }),
    );

    const auth = yield* OsnAuth;
    const { session } = yield* auth.refreshHeldSession();

    expect(session.accessToken).toBe(RECOVERY_TOKEN);
    // Receipt-based, so the screen's countdown needs no clock agreement with
    // the issuer.
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + 90_000);

    const grant = calls.find((c) => c.url.endsWith("/token"));
    expect(grant).toBeDefined();
    expect(grant?.init?.method).toBe("POST");
    expect(String(grant?.init?.body)).toContain("grant_type=refresh_token");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

/**
 * The refresh token lives only in the HttpOnly cookie, and the issuer is a
 * different origin from every app that calls it. A cross-origin `fetch` left on
 * the default `same-origin` credentials mode sends no cookie and silently
 * discards the `Set-Cookie` that comes back — no error, no warning. Here that
 * would be worse than a failed refresh: the grant rotates the session, so a
 * browser that never stored the rotated cookie would replay the old one on the
 * next grant, and a replayed rotated token is what revokes a whole session
 * family.
 */
it.effect("sends credentials, so the rotated cookie survives the cross-origin hop", () =>
  Effect.gen(function* () {
    const calls = stubTokenEndpoint(() =>
      mockResponse(200, {
        access_token: RECOVERY_TOKEN,
        token_type: "Bearer",
        expires_in: 300,
      }),
    );

    const auth = yield* OsnAuth;
    yield* auth.refreshHeldSession();

    const grant = calls.find((c) => c.url.endsWith("/token"));
    expect(grant?.init?.credentials).toBe("include");

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

/**
 * The property that separates this from `refreshSession`. `getSession` is the
 * probe, not `loadSession`: outside a browser there is no `document`, so the
 * session marker reads as present and `loadSession` would fire a grant of its
 * own and persist the result — proving nothing.
 */
it.effect("does not adopt the session it returns", () =>
  Effect.gen(function* () {
    stubTokenEndpoint(() =>
      mockResponse(200, {
        access_token: RECOVERY_TOKEN,
        token_type: "Bearer",
        expires_in: 300,
      }),
    );

    const auth = yield* OsnAuth;
    const before = yield* auth.getSession();
    expect(before).toBeNull();

    const { session } = yield* auth.refreshHeldSession();
    expect(session.accessToken).not.toBe("");

    // Still nothing stored: the caller holds the token, the client does not.
    expect(yield* auth.getSession()).toBeNull();
    expect(yield* auth.getActiveProfile()).toBeNull();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);

/**
 * A 4xx is the issuer saying the cookie redeems nothing. For a restricted
 * recovery session that is its absolute deadline arriving, and the screen turns
 * it into the timed-out state.
 */
it.effect("fails when the issuer refuses the grant", () =>
  Effect.gen(function* () {
    stubTokenEndpoint(() => mockResponse(400, { error: "invalid_grant" }));

    const auth = yield* OsnAuth;
    const result = yield* Effect.result(auth.refreshHeldSession());

    expect(result._tag).toBe("Failure");
    // And still nothing written on the way out.
    expect(yield* auth.getSession()).toBeNull();

    vi.unstubAllGlobals();
  }).pipe(Effect.provide(createTestLayer())),
);
