import { generateArcKeyPair } from "@shared/crypto";
import { createMemoryClient } from "@shared/redis";
import { exportJWK } from "jose";
import { describe, it, expect, beforeAll } from "vitest";

import { buildAppDeps, type BuildParts, type EnvVars } from "../src/build-deps";
import { buildSessionCookie, buildSessionMarkerCookie } from "../src/lib/cookie-session";
import { osnLoggerLayer } from "../src/observability";
import { createTestLayer } from "./helpers/db";

/**
 * T-U1. `OSN_COOKIE_DOMAIN` is a one-line pass-through in the composition root,
 * and that is exactly why it was worth pinning: the marker's whole purpose is
 * to be readable from a DIFFERENT host than the issuer that sets it, so if this
 * var stops reaching `cookieConfig` nothing throws — every cold-start browser
 * on the deployed split-host setup just quietly reads as signed out and the
 * bootstrap-grant flood this branch removed comes straight back.
 */

let privB64 = "";
let pubB64 = "";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateArcKeyPair();
  privB64 = b64(await exportJWK(privateKey));
  pubB64 = b64(await exportJWK(publicKey));
});

function nonLocalEnv(over: Partial<Record<string, string>> = {}): EnvVars {
  return {
    OSN_ENV: "production",
    OSN_ISSUER_URL: "https://id.musubi.social",
    OSN_CORS_ORIGIN: "https://musubi.social",
    OSN_ORIGIN: "https://musubi.social",
    OSN_RP_ID: "musubi.social",
    OSN_JWT_PRIVATE_KEY: privB64,
    OSN_JWT_PUBLIC_KEY: pubB64,
    OSN_SESSION_IP_PEPPER: "x".repeat(32),
    OSN_PAIRWISE_SALT: "p".repeat(32),
    ...over,
  };
}

function parts(over: Partial<BuildParts> = {}): BuildParts {
  return {
    redisClient: createMemoryClient(),
    dbAndEmailLayer: createTestLayer(),
    observabilityLayer: osnLoggerLayer,
    includeObservabilityPlugin: false,
    ...over,
  };
}

describe("buildAppDeps cookie config", () => {
  it("threads OSN_COOKIE_DOMAIN onto the marker only", async () => {
    const built = await buildAppDeps(nonLocalEnv({ OSN_COOKIE_DOMAIN: "musubi.social" }), parts());

    expect(built.deps.cookieConfig.markerDomain).toBe("musubi.social");
    expect(buildSessionMarkerCookie(built.deps.cookieConfig)).toContain("Domain=musubi.social");
  });

  it("leaves the marker host-only when the var is unset", async () => {
    // Correct for local dev, where the issuer and the app share a host. On a
    // split-host deployment it is a misconfiguration, not a crash — hence the
    // comment on the dev block in wrangler.toml.
    const built = await buildAppDeps(nonLocalEnv(), parts());

    expect(built.deps.cookieConfig.markerDomain).toBeUndefined();
    expect(buildSessionMarkerCookie(built.deps.cookieConfig)).not.toContain("Domain=");
  });

  it("never widens the session cookie itself — it stays __Host- prefixed", async () => {
    // The `__Host-` prefix FORBIDS a Domain attribute. Widening the credential
    // to the parent domain would hand it to every subdomain; the marker carries
    // no secret and can be widened safely, the session token cannot.
    const built = await buildAppDeps(nonLocalEnv({ OSN_COOKIE_DOMAIN: "musubi.social" }), parts());

    const session = buildSessionCookie("ses_abc", built.deps.cookieConfig);
    expect(session.startsWith("__Host-osn_session=")).toBe(true);
    expect(session).not.toContain("Domain=");
    expect(session).toContain("HttpOnly");
  });
});
