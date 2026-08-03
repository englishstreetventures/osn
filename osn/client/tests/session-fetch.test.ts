import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, describe, vi } from "vitest";

import { OsnAuth, createOsnAuthLive } from "../src/service";
import { setSessionFetch, type SessionFetch } from "../src/session-fetch";
import { createEphemeralStorage } from "../src/storage";

const config = { issuerUrl: "https://osn.example.com" };

function createTestLayer() {
  return createOsnAuthLive(config).pipe(Layer.provide(createEphemeralStorage()));
}

/**
 * A stand-in for the iOS transport: a cookie jar outside the document, plus a
 * server that rotates on every grant and revokes the family on reuse — the
 * Copenhagen Book C2 behaviour osn-api implements.
 *
 * The point of these tests is that the rotation *policy* stays in `service.ts`.
 * The jar only has to live somewhere the webview is not, so a fake one here
 * exercises the same seam the Rust plugin fills on device: the transport
 * attaches `Cookie`, captures `Set-Cookie`, and hands JS a response carrying
 * neither.
 */
function createFakeNativeTransport() {
  let jar: string | null = null;
  let live: string | null = null;
  let revoked = false;
  let issued = 0;
  /** The cookie the jar held at each `/token` call, oldest first. */
  const grantCookies: (string | null)[] = [];

  const rotate = () => {
    issued += 1;
    live = `session_${issued}`;
    return live;
  };

  const grantBody = () =>
    JSON.stringify({
      access_token: `acc_${issued}`,
      token_type: "Bearer",
      expires_in: 900,
      scope: "openid profile",
    });

  const transport: SessionFetch = async (input) => {
    const path = new URL(input, config.issuerUrl).pathname;

    if (path === "/login/passkey/complete") {
      jar = rotate();
      return new Response(grantBody(), { status: 200 });
    }

    if (path === "/token") {
      const sent = jar;
      grantCookies.push(sent);
      if (revoked || sent === null) return new Response("{}", { status: 401 });
      if (sent !== live) {
        // C2 reuse detection: a replayed cookie kills the whole family.
        revoked = true;
        live = null;
        jar = null;
        return new Response("{}", { status: 401 });
      }
      jar = rotate();
      return new Response(grantBody(), { status: 200 });
    }

    if (path === "/logout") {
      jar = null;
      live = null;
      return new Response("{}", { status: 200 });
    }

    return new Response("{}", { status: 404 });
  };

  return {
    transport,
    grantCookies,
    get jar() {
      return jar;
    },
    get revoked() {
      return revoked;
    },
    /** Sign in, so the jar holds a live cookie. */
    signIn: () => transport(`${config.issuerUrl}/login/passkey/complete`, { method: "POST" }),
    /** Put a stale cookie back, as a lost rotation response would. */
    rewind(value: string) {
      jar = value;
    },
  };
}

const cachedSession = () => ({
  accessToken: "acc_1",
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scopes: ["openid", "profile"],
});

describe("native session transport", () => {
  afterEach(() => {
    setSessionFetch(null);
    vi.unstubAllGlobals();
  });

  it.effect("a refresh cycle survives two consecutive rotations", () =>
    Effect.gen(function* () {
      const server = createFakeNativeTransport();
      setSessionFetch(server.transport);
      yield* Effect.promise(server.signIn);
      expect(server.jar).toBe("session_1");

      const auth = yield* OsnAuth;
      yield* auth.setSession(cachedSession());

      const first = yield* auth.refreshSession();
      expect(first.accessToken).toBe("acc_2");
      expect(server.jar).toBe("session_2");

      const second = yield* auth.refreshSession();
      expect(second.accessToken).toBe("acc_3");
      expect(server.jar).toBe("session_3");

      // Each grant carried the cookie the previous one set — no reuse, so the
      // family is still alive.
      expect(server.revoked).toBe(false);
      expect(server.grantCookies).toEqual(["session_1", "session_2"]);

      const stored = yield* auth.getSession();
      expect(stored?.accessToken).toBe("acc_3");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a replayed cookie trips reuse detection and the refresh fails", () =>
    Effect.gen(function* () {
      const server = createFakeNativeTransport();
      setSessionFetch(server.transport);
      yield* Effect.promise(server.signIn);

      const auth = yield* OsnAuth;
      yield* auth.setSession(cachedSession());
      yield* auth.refreshSession();

      // Pretend the rotation response was lost and the old cookie came back.
      server.rewind("session_1");

      const error = yield* Effect.flip(auth.refreshSession());
      expect(error._tag).toBe("TokenRefreshError");
      expect(server.revoked).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("concurrent refreshes share one grant, so rotation is not replayed", () =>
    Effect.gen(function* () {
      const server = createFakeNativeTransport();
      setSessionFetch(server.transport);
      yield* Effect.promise(server.signIn);

      const auth = yield* OsnAuth;
      yield* auth.setSession(cachedSession());

      const [a, b, c] = yield* Effect.all(
        [auth.refreshSession(), auth.refreshSession(), auth.refreshSession()],
        { concurrency: "unbounded" },
      );

      expect(a.accessToken).toBe(b.accessToken);
      expect(b.accessToken).toBe(c.accessToken);
      expect(server.revoked).toBe(false);
      // One /token call, not three: three would replay a rotated cookie.
      expect(server.grantCookies).toEqual(["session_1"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("logout clears the transport's cookie", () =>
    Effect.gen(function* () {
      const server = createFakeNativeTransport();
      setSessionFetch(server.transport);
      yield* Effect.promise(server.signIn);

      const auth = yield* OsnAuth;
      yield* auth.setSession(cachedSession());
      yield* auth.logout();

      expect(server.jar).toBeNull();
      expect(yield* auth.getSession()).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("setSessionFetch(null) puts plain fetch back", () =>
    Effect.gen(function* () {
      const server = createFakeNativeTransport();
      setSessionFetch(server.transport);
      yield* Effect.promise(server.signIn);
      setSessionFetch(null);

      const plain = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
      vi.stubGlobal("fetch", plain);

      const auth = yield* OsnAuth;
      yield* auth.setSession(cachedSession());
      yield* Effect.flip(auth.refreshSession());

      // The grant went to `fetch`, and the fake server never saw it.
      expect(plain).toHaveBeenCalled();
      expect(server.grantCookies).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
