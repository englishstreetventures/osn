import { makeLogEmailLive } from "@shared/email";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace, type RecordedCall } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";
import { createAuthRoutes } from "../helpers/routes";

/**
 * F-SV3: a ceremony `begin` whose entry cannot be stored answers 503 and sends
 * no mail. A code mailed for an entry that was never stored could not be
 * checked, so the user would be sent a code that can only fail.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/** Routes over a Durable Object bundle whose `failing` store rejects every call. */
function harness(failing: (call: RecordedCall) => boolean) {
  const fake = createFakeNamespace();
  const stores = createDurableCoordination(fake.ns, () => {});
  const merged = {
    ...config,
    ceremonyStores: stores.ceremonyStores,
    stepUpJtiStore: stores.stepUpJtiStore,
  };
  const rec = makeLogEmailLive();
  const layer = Layer.merge(createTestLayer(), rec.layer);
  const app = createAuthRoutes(merged, layer);
  const auth = createAuthService(merged);
  return { app, auth, layer, recorded: rec.recorded, fake, fail: () => fake.failWhen(failing) };
}

describe("a ceremony begin whose entry cannot be stored", () => {
  it("POST /register/begin answers 503 and mails nothing", async () => {
    const h = harness((call) => call.store === "pending_registration");
    h.fail();
    const res = await h.app.handle(
      new Request("http://localhost/register/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nostore@example.com",
          handle: "nostore",
          birthdate: "1990-01-01",
        }),
      }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
    expect(h.recorded()).toEqual([]);
  });

  it("POST /step-up/otp/begin answers 503 and mails nothing", async () => {
    const h = harness((call) => call.store === "step_up_otp");
    const profile = await Effect.runPromise(
      h.auth.registerProfile("stepdown@example.com", "stepdown").pipe(Effect.provide(h.layer)),
    );
    const { accessToken } = await Effect.runPromise(
      h.auth
        .issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        )
        .pipe(Effect.provide(h.layer)),
    );
    h.fail();

    const res = await h.app.handle(
      new Request("http://localhost/step-up/otp/begin", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("temporarily_unavailable");
    expect(h.recorded()).toEqual([]);
    expect(h.fake.calls.at(-1)).toEqual({ store: "step_up_otp", op: "write" });
  });
});
