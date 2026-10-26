import { generateArcKeyPair } from "@shared/crypto";
import { Effect } from "effect";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { buildAppDeps, type EnvVars } from "../src/build-deps";
import { createDurableCoordination } from "../src/lib/coordination/durable";
import { osnLoggerLayer } from "../src/observability";
import { createAuthService } from "../src/services/auth";
import { createFakeNamespace, type FakeNamespace } from "./helpers/coordination-namespace";
import { createTestLayer } from "./helpers/db";

/**
 * `createApp` gives the account export and erasure routes the coordination
 * bundle's limiters and step-up guard, not the in-memory defaults their route
 * factories fall back to. Only the bundle reaches the Durable Object stand-in,
 * so a call recorded on it can only come from what `createApp` passed.
 */

let env: EnvVars;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
const IP = "203.0.113.9";

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  env = {
    OSN_ENV: "local",
    OSN_JWT_PRIVATE_KEY: b64(await exportJWK(privateKey)),
    OSN_JWT_PUBLIC_KEY: b64(await exportJWK(publicKey)),
    TRUSTED_PROXY_COUNT: "1",
  };
});

async function signedIn() {
  const fake = createFakeNamespace();
  const layer = createTestLayer();
  const built = await buildAppDeps(env, {
    coordination: (onError) => createDurableCoordination(fake.ns, onError),
    dbAndEmailLayer: layer,
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
  });
  const auth = createAuthService(built.deps.authConfig);
  const profile = await Effect.runPromise(
    auth.registerProfile("wired@example.com", "wired").pipe(Effect.provide(layer)),
  );
  const { accessToken } = await Effect.runPromise(
    auth
      .issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      )
      .pipe(Effect.provide(layer)),
  );
  return { app: createApp(built.deps), fake, auth, accountId: profile.accountId, accessToken };
}

const callsOn = (fake: FakeNamespace, store: string) =>
  fake.calls.filter((call) => call.store === store).map((call) => call.op);

describe("createApp wires the coordination bundle into the account routes", () => {
  it("GET /account/export spends the shared per-IP and per-account budgets and step-up guard", async () => {
    const h = await signedIn();
    const exportOnce = async () =>
      h.app.handle(
        new Request("http://localhost/account/export", {
          headers: {
            "x-forwarded-for": IP,
            authorization: `Bearer ${h.accessToken}`,
            "x-step-up-token": await Effect.runPromise(
              h.auth.issueStepUpToken(h.accountId, "otp", "account_export"),
            ),
          },
        }),
      );

    const first = await exportOnce();
    expect(first.status).toBe(200);
    await first.body?.cancel();

    const second = await exportOnce();
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });

    expect(callsOn(h.fake, "account.export_ip")).toEqual(["increment", "increment"]);
    expect(callsOn(h.fake, "step_up_jti")).toEqual(["claim", "claim"]);
    expect(callsOn(h.fake, "account.export")).toEqual(["increment", "increment"]);
  });

  it("GET /account/deletion-status spends the shared erasure budget", async () => {
    const h = await signedIn();
    const res = await h.app.handle(
      new Request("http://localhost/account/deletion-status", {
        headers: { "x-forwarded-for": IP, authorization: `Bearer ${h.accessToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(callsOn(h.fake, "account.deletion_status")).toEqual(["increment"]);
  });
});
