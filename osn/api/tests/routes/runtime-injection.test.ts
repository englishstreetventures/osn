import { makeLogEmailLive } from "@shared/email";
import { Layer, ManagedRuntime } from "effect";
import { describe, it, expect, beforeAll } from "vitest";

import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";
import { createAuthRoutes } from "../helpers/routes";

/**
 * T-U1: in production, route factories run handlers against ONE shared
 * `ManagedRuntime` (built once in `index.ts`) passed as the trailing factory
 * arg — not the per-request fallback the rest of the route tests exercise.
 * This test drives a real, DB- and EmailService-backed flow (handle check →
 * register/begin → register/complete → handle check) through an injected
 * runtime, asserting the production `makeAppRunner(injectedRuntime, …)` branch
 * actually executes service effects. It also locks the requirement-channel
 * contract behaviourally: the auth flow needs `Db | EmailService`, and a
 * runtime providing that superset satisfies it.
 */
let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("createAuthRoutes — injected shared runtime", () => {
  it("executes a full DB/email-backed register flow through the injected runtime", async () => {
    // Build the layer graph (Db + a capturing EmailService) and a runtime from
    // it, exactly as index.ts does with the application layer.
    const rec = makeLogEmailLive();
    const layer = Layer.merge(createTestLayer(), rec.layer);
    const runtime = ManagedRuntime.make(layer);

    // Pass the runtime as the trailing factory arg. The dbLayer/loggerLayer
    // positionals are present only to satisfy the signature — when a runtime is
    // injected they are ignored, so handlers MUST use `runtime` to reach Db.
    const app = createAuthRoutes(
      config,
      layer,
      undefined,
      undefined,
      undefined,
      undefined,
      runtime,
    );

    const latestCode = () => {
      const all = rec.recorded();
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i].text.match(/code is: (\d{6})/);
        if (m) return m[1];
      }
      return undefined;
    };

    // 1. Handle is free (checkHandle effect runs through the injected runtime).
    const free = await app.handle(new Request("http://localhost/handle/runtimeuser"));
    expect(((await free.json()) as { available: boolean }).available).toBe(true);

    // 2. register/begin sends an OTP via the injected runtime's EmailService.
    const begin = await app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "runtime-user@example.com",
          handle: "runtimeuser",
          displayName: "Runtime User",
        }),
      }),
    );
    expect(begin.status).toBe(200);
    expect(latestCode()).toMatch(/^\d{6}$/);

    // 3. register/complete writes the account+profile to Db via the runtime.
    const complete = await app.handle(
      new Request("http://localhost/register/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "runtime-user@example.com", code: latestCode()! }),
      }),
    );
    expect(complete.status).toBe(201);
    const body = (await complete.json()) as { profileId: string; handle: string };
    expect(body.profileId).toMatch(/^usr_/);
    expect(body.handle).toBe("runtimeuser");

    // 4. Handle now taken — the post-write read also runs through the runtime,
    //    proving the same shared runtime served writes and reads consistently.
    const taken = await app.handle(new Request("http://localhost/handle/runtimeuser"));
    expect(((await taken.json()) as { available: boolean }).available).toBe(false);

    await runtime.dispose();
  });
});
