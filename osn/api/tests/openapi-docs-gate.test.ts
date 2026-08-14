import { generateArcKeyPair } from "@shared/crypto";
import { createMemoryClient } from "@shared/redis";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { buildAppDeps } from "../src/build-deps";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayer } from "./helpers/db";

/**
 * The OpenAPI docs are a tier-gated surface: served on `local` and on the `dev`
 * tier, absent on `staging` and `production`. The document maps every route,
 * parameter and error shape, nothing reads it at runtime (the committed
 * `shared/openapi/osn.json` feeds the generated clients), so a deployed public
 * host serving it only donates reconnaissance.
 *
 * The tier must come from the request-scoped `env` record, never `process.env`:
 * on workerd that shim is empty during module evaluation, so an import-time
 * decision reads every deployed tier as `local`. `buildAppDeps` already takes
 * the env the honest way on both runtimes, which is why the derivation lives
 * there — these tests drive it through the same door the Workers entry uses.
 */

let privB64 = "";
let pubB64 = "";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  privB64 = b64(await exportJWK(privateKey));
  pubB64 = b64(await exportJWK(publicKey));
});

const parts = () => ({
  redisClient: createMemoryClient(),
  dbAndEmailLayer: createTestLayer(),
  observabilityLayer: osnLoggerLayer,
  includeObservabilityPlugin: false,
});

/** A deployed env that satisfies every non-local guard, so the tier is what varies. */
const deployedEnv = (osnEnv: string): Record<string, string> => ({
  OSN_ENV: osnEnv,
  OSN_ISSUER_URL: "https://api.osn.test",
  OSN_ORIGIN: "https://api.osn.test",
  OSN_CORS_ORIGIN: "https://app.osn.test",
  OSN_RP_ID: "osn.test",
  OSN_JWT_PRIVATE_KEY: privB64,
  OSN_JWT_PUBLIC_KEY: pubB64,
  OSN_SESSION_IP_PEPPER: "x".repeat(32),
  OSN_PAIRWISE_SALT: "p".repeat(32),
});

const docsMounted = async (env: Record<string, string>): Promise<boolean> => {
  const built = await buildAppDeps(env, parts());
  const app = createApp(built.deps);
  const res = await app.handle(new Request("http://localhost/openapi/json"));
  return res.status === 200;
};

describe("OpenAPI docs tier gate", () => {
  it("derives the flag from the env record, not process.env", async () => {
    const local = await buildAppDeps({}, parts());
    const prod = await buildAppDeps(deployedEnv("production"), parts());
    expect(local.deps.includeOpenapiPlugin).toBe(true);
    expect(prod.deps.includeOpenapiPlugin).toBe(false);
  });

  it("serves the document on local (an absent OSN_ENV reads as local)", async () => {
    await expect(docsMounted({})).resolves.toBe(true);
  });

  it("serves the document on the dev tier", async () => {
    await expect(docsMounted(deployedEnv("dev"))).resolves.toBe(true);
  });

  it("withholds it on staging", async () => {
    await expect(docsMounted(deployedEnv("staging"))).resolves.toBe(false);
  });

  it("withholds it on production", async () => {
    await expect(docsMounted(deployedEnv("production"))).resolves.toBe(false);
  });

  it("withholds the Scalar UI too, not just the document", async () => {
    const built = await buildAppDeps(deployedEnv("production"), parts());
    const res = await createApp(built.deps).handle(new Request("http://localhost/openapi"));
    expect(res.status).toBe(404);
  });

  // Fails closed: `isNonLocal` counts anything that isn't exactly `local` as
  // deployed, and `parseDeploymentEnvironment` answers `dev` only for
  // `dev`/`development`. So a tier string neither recognises is off, not on.
  it("withholds it on an unrecognised tier string", async () => {
    await expect(docsMounted(deployedEnv("developement"))).resolves.toBe(false);
  });
});
