import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CookieSessionConfig } from "../../src/lib/cookie-session";
import * as metrics from "../../src/metrics";
import type { AuthRouteContext } from "../../src/routes/auth/context";
import { DEV_PRINCIPAL } from "../../src/routes/auth/dev-login";
import { createTokenRoutes } from "../../src/routes/auth/tokens";

/**
 * `POST /token`'s optional `profile_id`, at the HTTP boundary (F23, F38). Which
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /token profile_id", () => {
  it("hands the named profile to the grant", async () => {
    const { app, grants } = recordingApp();

    const res = await grant(app, { profile_id: "usr_0123456789ab" });

    expect(res.status).toBe(200);
    expect(grants).toEqual([["ses_live", "usr_0123456789ab"]]);
  });

  it("F38: hands the dev principal's profile id to the grant", async () => {
    // Not in the 12-hex form `genId` mints. Refused here, the client would
    // read the 4xx as a refused grant and sign the page out at its first
    // renewal.
    const { app, grants } = recordingApp();

    const res = await grant(app, { profile_id: DEV_PRINCIPAL.profileId });

    expect(res.status).toBe(200);
    expect(grants).toEqual([["ses_live", DEV_PRINCIPAL.profileId]]);
  });

  it("names no profile when the field is absent", async () => {
    const { app, grants } = recordingApp();

    const res = await grant(app, {});

    expect(res.status).toBe(200);
    expect(grants).toEqual([["ses_live", undefined]]);
  });

  // A page whose active profile id is empty sends it as `profile_id=`. Read as
  // "none", the grant would mint the cookie account's default profile for a
  // page that may hold another account. Refused like a grant naming a profile
  // the account does not own, the marker goes with it, so the next cold load
  // does not take up the cookie's account either.
  it.each([
    ["an empty profile_id", ""],
    ["a value that is not a profile id", "usr_0123456789ab' OR 1=1"],
  ])(
    "refuses %s before any grant, and retracts the marker but not the session cookie",
    async (_name, profileId) => {
      const { app, grants } = recordingApp();
      const counted = vi.spyOn(metrics, "metricAuthTokenRefreshRefused");

      const res = await grant(app, { profile_id: profileId });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe("invalid_grant");
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("osn_has_session=;"))).toBe(true);
      expect(cookies.some((c) => c.startsWith("osn_session="))).toBe(false);
      expect(grants).toEqual([]);
      // Counted as the service counts its own refusal of what a grant asked.
      expect(counted).toHaveBeenCalledTimes(1);
    },
  );
});
