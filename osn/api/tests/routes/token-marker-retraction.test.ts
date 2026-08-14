import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import type { CookieSessionConfig } from "../../src/lib/cookie-session";
import { ROTATION_RACE_MESSAGE } from "../../src/lib/grant-failure";
import type { AuthRouteContext } from "../../src/routes/auth/context";
import { createTokenRoutes } from "../../src/routes/auth/tokens";
import { AuthError, DatabaseError } from "../../src/services/auth/errors";

/**
 * S-M2 at the HTTP boundary.
 *
 * `POST /token` is the only endpoint that retracts `osn_has_session`, and a
 * browser with no local account state consults nothing else — retract it
 * wrongly and that browser is signed out until the user signs in by hand, even
 * though its 30-day session cookie is alive. So "which failures retract" is a
 * response-header contract, not an internal detail, and it is pinned here on
 * the real Elysia route rather than only on the predicate.
 *
 * The failures worth distinguishing can't be produced through the full
 * register-then-grant path: a DB outage and the concurrent-rotation CAS loss
 * are both races against infrastructure. The route factory reads exactly three
 * fields off its context (`auth`, `run`, `cookieConfig`), so a stub context
 * gives a deterministic test of the branch that matters. `run` is a real
 * `ManagedRuntime`, so the handler catches the `FiberFailure` wrapper it sees
 * in production — a plain `Promise.reject` would not exercise the unwrap.
 */

const cookieConfig: CookieSessionConfig = { secure: false };
const runtime = ManagedRuntime.make(Layer.empty);

function appFailingWith(failure: unknown) {
  const ctx = {
    auth: { refreshTokens: () => Effect.fail(failure) },
    run: (effect: Effect.Effect<unknown, unknown>) => runtime.runPromise(effect),
    cookieConfig,
  } as unknown as AuthRouteContext;
  return createTokenRoutes(ctx);
}

function grant(app: ReturnType<typeof createTokenRoutes>) {
  return app.handle(
    new Request("http://localhost/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "osn_session=ses_live" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    }),
  );
}

describe("POST /token marker retraction (S-M2)", () => {
  it("keeps the marker when the database failed", async () => {
    // The grant failed, but nothing here says the cookie is dead. Retracting
    // would turn one bad minute of storage into a permanent logout for every
    // cold-start browser that refreshed during it.
    const res = await grant(appFailingWith(new DatabaseError({ cause: "down" })));

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("keeps the marker on the benign concurrent-rotation race", async () => {
    // PR #289: two tabs grant the same token; the loser's CAS matches 0 rows.
    // The winner already set a fresh session cookie — this browser is signed
    // in, and the loser must not tell it otherwise.
    const res = await grant(appFailingWith(new AuthError({ message: ROTATION_RACE_MESSAGE })));

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("retracts the marker when the token genuinely did not verify", async () => {
    // Here the cookie really is gone, expired or revoked. Left standing, the
    // marker re-arms this same doomed grant on every page load — the request
    // flood this whole branch exists to stop.
    const res = await grant(
      appFailingWith(new AuthError({ message: "Invalid or expired session" })),
    );

    expect(res.status).toBe(400);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("osn_has_session=;"))).toBe(true);
    // Still never the session cookie: only the client can decide to give up on
    // a credential the server merely failed to verify once.
    expect(cookies.some((c) => c.startsWith("osn_session="))).toBe(false);
  });

  it("retracts on an unrecognised failure — the predicate fails toward retraction", async () => {
    const res = await grant(appFailingWith(new Error("boom")));

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("osn_has_session=;"))).toBe(true);
  });
});

/**
 * T-R1. `/logout` had no HTTP test at all — its cookie behaviour was covered
 * only by the unit tests on `buildClearSessionCookies`, which say nothing about
 * whether the route calls it. Logout is the one place that MUST clear both
 * cookies: leave the marker behind and every later page load fires a grant
 * against a session the server has already destroyed.
 */
describe("POST /logout", () => {
  function logoutApp(invalidate: (token: string) => Effect.Effect<unknown, unknown>) {
    const seen: string[] = [];
    const ctx = {
      auth: {
        invalidateSession: (token: string) => {
          seen.push(token);
          return invalidate(token);
        },
      },
      run: (effect: Effect.Effect<unknown, unknown>) => runtime.runPromise(effect),
      cookieConfig,
    } as unknown as AuthRouteContext;
    return { app: createTokenRoutes(ctx), seen };
  }

  const call = (app: ReturnType<typeof createTokenRoutes>, cookie?: string) =>
    app.handle(
      new Request("http://localhost/logout", {
        method: "POST",
        headers: cookie ? { cookie } : {},
      }),
    );

  it("destroys the session and clears both cookies", async () => {
    const { app, seen } = logoutApp(() => Effect.succeed(undefined));

    const res = await call(app, "osn_session=ses_live");

    expect(res.status).toBe(200);
    expect(seen).toEqual(["ses_live"]);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("osn_session=;"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("osn_has_session=;"))).toBe(true);
    expect(cookies.every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("still clears both cookies when the session was already gone", async () => {
    // Idempotent by design: the response must not leak whether the session
    // existed, and a browser holding a stale cookie pair must still end up
    // clean — otherwise the marker outlives the session it advertises.
    const { app } = logoutApp(() => Effect.fail(new AuthError({ message: "no such session" })));

    const res = await call(app, "osn_session=ses_dead");

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("osn_has_session=;"))).toBe(true);
  });

  it("clears both cookies with no session cookie sent at all", async () => {
    const { app, seen } = logoutApp(() => Effect.succeed(undefined));

    const res = await call(app);

    expect(res.status).toBe(200);
    // Nothing to destroy — but the marker may still be sitting in the browser.
    expect(seen).toEqual([]);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("osn_has_session=;"))).toBe(true);
  });
});
