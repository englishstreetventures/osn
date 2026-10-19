import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { origin, SeedSecretError, STACK_STEP_SECRETS, stageHosts } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { osnSeedSql } from "../src/seeds";
import {
  ARC_KEY_ID,
  DEV_DOMAIN,
  evaluateMusubi,
  failureOf,
  generateArcPrivateJwk,
  OIDC_CLIENT_SECRET,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
} from "./evaluate";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let arcPrivateJwk = "";
let dev: Evaluation;

beforeAll(async () => {
  arcPrivateJwk = await generateArcPrivateJwk();
  dev = await evaluateMusubi({ stage: "dev", env: stackEnv(arcPrivateJwk) });
});

afterAll(removeEvaluations);

describe("the musubi stack, evaluated offline", () => {
  test("K1: each Worker and database takes today's dev name, and each Worker its host under DEV_DOMAIN", async () => {
    const resources = resourcesOf(dev);
    expect(dev.fetches).toEqual([]);
    // Logical ids key the state rows, so they never change once deployed.
    expect(Object.keys(resources).toSorted()).toEqual(
      ["MusubiLanding", "MusubiSocial", "OsnApi", "OsnDb"].toSorted(),
    );
    expect(resources.OsnApi?.Props.name).toBe("osn-api-dev");
    expect(resources.OsnDb?.Props.name).toBe("osn-db-dev");
    expect(resources.MusubiSocial?.Props.name).toBe("osn-social-dev");
    expect(resources.MusubiLanding?.Props.name).toBe("musubi-landing-dev");

    expect(resources.OsnApi?.Props.domain).toBe(`id.musubi.${DEV_DOMAIN}`);
    expect(resources.MusubiSocial?.Props.domain).toBe(`musubi.${DEV_DOMAIN}`);
    expect(resources.MusubiLanding?.Props.domain).toBe(`www.musubi.${DEV_DOMAIN}`);

    const env = resources.OsnApi?.Props.env ?? {};
    expect({
      OSN_ENV: env.OSN_ENV,
      OSN_RP_ID: env.OSN_RP_ID,
      OSN_RP_NAME: env.OSN_RP_NAME,
      OSN_ORIGIN: env.OSN_ORIGIN,
      OSN_ISSUER_URL: env.OSN_ISSUER_URL,
      OSN_CORS_ORIGIN: env.OSN_CORS_ORIGIN,
      DEV_LOGIN_RETURN_ORIGINS: env.DEV_LOGIN_RETURN_ORIGINS,
      OSN_AUTHORIZE_UI_URL: env.OSN_AUTHORIZE_UI_URL,
      OSN_COOKIE_DOMAIN: env.OSN_COOKIE_DOMAIN,
      OSN_EMAIL_FROM: env.OSN_EMAIL_FROM,
    }).toEqual({
      OSN_ENV: "dev",
      OSN_RP_ID: `musubi.${DEV_DOMAIN}`,
      OSN_RP_NAME: "OSN (dev)",
      OSN_ORIGIN: `https://musubi.${DEV_DOMAIN}`,
      OSN_ISSUER_URL: `https://id.musubi.${DEV_DOMAIN}`,
      OSN_CORS_ORIGIN: `https://musubi.${DEV_DOMAIN}`,
      DEV_LOGIN_RETURN_ORIGINS: [
        `https://musubi.${DEV_DOMAIN}`,
        `https://host.cire.${DEV_DOMAIN}`,
        `https://vendor.cire.${DEV_DOMAIN}`,
        `https://invite.cire.${DEV_DOMAIN}`,
      ].join(","),
      OSN_AUTHORIZE_UI_URL: `https://musubi.${DEV_DOMAIN}/authorize`,
      OSN_COOKIE_DOMAIN: `musubi.${DEV_DOMAIN}`,
      OSN_EMAIL_FROM: "dev@cireweddings.com",
    });

    // An investigation stage derives every name and host from its own name
    // and keeps the dev posture.
    const investigation = resourcesOf(
      await evaluateMusubi({ stage: "probe", env: stackEnv(arcPrivateJwk) }),
    );
    expect(investigation.OsnApi?.Props.name).toBe("osn-api-probe");
    expect(investigation.OsnDb?.Props.name).toBe("osn-db-probe");
    expect(investigation.MusubiSocial?.Props.name).toBe("osn-social-probe");
    expect(investigation.MusubiLanding?.Props.name).toBe("musubi-landing-probe");
    expect(investigation.OsnApi?.Props.domain).toBe(`id.musubi.probe.${DEV_DOMAIN}`);
    expect(investigation.OsnApi?.Props.env?.OSN_ENV).toBe("dev");
    expect(investigation.OsnApi?.Props.env?.OSN_RP_NAME).toBe("OSN (probe)");
  });

  test("RQ1: osn-api redacts query strings from its logs and traces, since dev sign-in takes its secret in one", () => {
    expect(resourcesOf(dev).OsnApi?.Props.observability?.redactQueryString).toBe(true);
  });

  test("K5: every resource the dev stage keeps is retained on destroy and replacement", () => {
    const resources = resourcesOf(dev);
    expect(
      Object.values(resources).map((resource) => [resource.LogicalId, resource.RemovalPolicy]),
    ).toEqual(Object.keys(resources).map((logicalId) => [logicalId, "retain"]));
  });

  test("K6: osn-db-dev takes production's read replication in oc, migrated from the flattened chain and seeded from the generated file", () => {
    const props = resourcesOf(dev).OsnDb?.Props;
    expect(props?.readReplication).toEqual({ mode: "disabled" });
    expect(props?.jurisdiction).toBe("default");
    expect(props?.primaryLocationHint).toBe("oc");

    const migrations = join(dev.generatedDir, "migrations", "osn-db");
    expect(props?.migrations).toBe(migrations);
    const chain = readdirSync(join(repoRoot, "osn/db/drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
    expect(readdirSync(migrations).toSorted()).toEqual(chain);

    const seed = join(dev.generatedDir, "seeds", "osn-seed.sql");
    expect(props?.importFiles).toEqual([seed]);
    expect(readFileSync(seed, "utf8")).toBe(
      osnSeedSql({
        cireApiOrigin: origin(stageHosts(DEV_DOMAIN, "dev").cireApi),
        clientSecret: OIDC_CLIENT_SECRET,
        arcKeyId: ARC_KEY_ID,
        arcPrivateJwk,
      }),
    );
  });

  test("S3: a missing, blank or padded seed secret refuses the run, naming it, and writes nothing", async () => {
    const names = STACK_STEP_SECRETS.musubi.map((secret) => secret.name);
    expect(names.toSorted()).toEqual(
      ["CIRE_API_ARC_KEY_ID", "CIRE_API_ARC_PRIVATE_KEY", "CIRE_OIDC_CLIENT_SECRET"].toSorted(),
    );
    for (const name of names) {
      for (const value of [undefined, "", "   ", ` ${name}-padded `]) {
        const refused = await evaluateMusubi({
          stage: "dev",
          env: { ...stackEnv(arcPrivateJwk), [name]: value },
        });
        const failure = failureOf(refused);
        expect(failure).toBeInstanceOf(SeedSecretError);
        expect(failure).toMatchObject({ variable: name });
        // The message names the variable, never its value.
        expect(String((failure as SeedSecretError).message)).not.toContain(`${name}-padded`);
        expect(existsSync(refused.generatedDir)).toBe(false);
      }
    }
  });
});
