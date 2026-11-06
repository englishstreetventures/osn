import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import type { CookieSessionConfig } from "../../src/lib/cookie-session";
import type { AuthRouteContext } from "../../src/routes/auth/context";
import { createTokenRoutes } from "../../src/routes/auth/tokens";

/**
 * `POST /token`'s optional `profile_id`, at the HTTP boundary (F23). Which
 * profile the grant mints for is the service's to decide
 * (`tests/services/auth/tokens.test.ts`); the route's job is to hand it the
 * field as sent, and to refuse a value that is not a profile id before any
 * grant runs. A stub context records what the route passes on.
 */

const cookieConfig: CookieSessionConfig = { secure: false };
const runtime = ManagedRuntime.make(Layer.empty);

function recordingApp() {
  const grants: unknown[][] = [];
  const ctx = {
    auth: {
      refreshTokens: (...args: unknown[]) => {
        grants.push(args);
        return Effect.succeed({ accessToken: "acc", refreshToken: "ses_next", expiresIn: 300 });
      },
    },
    run: (effect: Effect.Effect<unknown, unknown>) => runtime.runPromise(effect),
    cookieConfig,
  } as unknown as AuthRouteContext;
  return { app: createTokenRoutes(ctx), grants };
}

/** A grant as the browser client sends it: form-encoded, with the session cookie. */
function grant(app: ReturnType<typeof createTokenRoutes>, fields: Record<string, string>) {
  return app.handle(
    new Request("http://localhost/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        cookie: "osn_session=ses_live",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", ...fields }).toString(),
    }),
  );
}

describe("POST /token profile_id", () => {
  it("hands the named profile to the grant", async () => {
    const { app, grants } = recordingApp();

    const res = await grant(app, { profile_id: "usr_0123456789ab" });

    expect(res.status).toBe(200);
    expect(grants).toEqual([["ses_live", "usr_0123456789ab"]]);
  });

  it("names no profile when the field is absent", async () => {
    const { app, grants } = recordingApp();

    const res = await grant(app, {});

    expect(res.status).toBe(200);
    expect(grants).toEqual([["ses_live", undefined]]);
  });

  it("refuses a value that is not a profile id, before any grant", async () => {
    const { app, grants } = recordingApp();

    const res = await grant(app, { profile_id: "usr_0123456789ab' OR 1=1" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(grants).toEqual([]);
  });
});
