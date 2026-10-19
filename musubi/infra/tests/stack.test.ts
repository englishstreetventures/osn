import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  origin,
  SeedValueError,
  SiteBuildError,
  STACK_STEP_SECRETS,
  stageHosts,
} from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { osnSeedSql } from "../src/seeds";
import {
  ARC_KEY_ID,
  DEV_DOMAIN,
  evaluateMusubi,
  failureOf,
  generateArcPublicJwk,
  OIDC_CLIENT_SECRET_SHA256,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
  type SiteFixtures,
} from "./evaluate";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The origins each musubi site's dev build bakes in, under `musubi/`: found by
 * building each with deploy.yml's dev values for example.test and searching
 * its output. musubi social holds osn-api's (VITE_OSN_ISSUER_URL); musubi
 * landing holds the app's (PUBLIC_APP_URL) and its own (SITE).
 */
const SITE_ORIGINS = [
  {
    site: "@musubi/social",
    directory: "social/dist",
    origins: [`https://id.musubi.${DEV_DOMAIN}`],
  },
  {
    site: "@musubi/landing",
    directory: "landing/dist",
    origins: [`https://musubi.${DEV_DOMAIN}`, `https://www.musubi.${DEV_DOMAIN}`],
  },
] as const;

const fixtures = (
  edit: (entry: (typeof SITE_ORIGINS)[number]) => readonly string[] = (entry) => entry.origins,
): SiteFixtures => Object.fromEntries(SITE_ORIGINS.map((entry) => [entry.directory, edit(entry)]));

let arcPublicJwk = "";
let dev: Evaluation;

beforeAll(async () => {
  arcPublicJwk = await generateArcPublicJwk();
  dev = await evaluateMusubi({ stage: "dev", env: stackEnv(arcPublicJwk) });
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
      await evaluateMusubi({ stage: "probe", env: stackEnv(arcPublicJwk) }),
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
        clientSecretSha256: OIDC_CLIENT_SECRET_SHA256,
        arcKeyId: ARC_KEY_ID,
        arcPublicJwk,
      }),
    );
  });

  test("S3: the stack seeds from the cire_seed step's values and holds no cire secret; a value missing, blank or padded refuses the run, naming it, and writes nothing", async () => {
    // The job hands the three cire secrets to the cire_seed step alone; the
    // evaluations above ran with none of them in the environment.
    const cireSecrets = STACK_STEP_SECRETS.musubi.map((secret) => secret.name);
    expect(cireSecrets.toSorted()).toEqual(
      ["CIRE_API_ARC_KEY_ID", "CIRE_API_ARC_PRIVATE_KEY", "CIRE_OIDC_CLIENT_SECRET"].toSorted(),
    );
    expect(STACK_STEP_SECRETS.musubi.filter((secret) => secret.step === "deploy")).toEqual([]);
    const env = stackEnv(arcPublicJwk);
    expect(
      ["CIRE_API_ARC_PRIVATE_KEY", "CIRE_OIDC_CLIENT_SECRET"].filter((name) =>
        Object.hasOwn(env, name),
      ),
    ).toEqual([]);

    for (const name of [
      "CIRE_API_ARC_KEY_ID",
      "CIRE_API_ARC_PUBLIC_JWK",
      "CIRE_OIDC_CLIENT_SECRET_SHA256",
    ]) {
      for (const value of [undefined, "", "   ", ` ${name}-padded `]) {
        const refused = await evaluateMusubi({ stage: "dev", env: { ...env, [name]: value } });
        const failure = failureOf(refused);
        expect(failure).toBeInstanceOf(SeedValueError);
        expect(failure).toMatchObject({ variable: name });
        // The message names the variable, never its value.
        expect(String((failure as SeedValueError).message)).not.toContain(`${name}-padded`);
        expect(existsSync(refused.generatedDir)).toBe(false);
      }
    }
  });

  test("SB9: site output holding exactly the origins each dev build bakes in is accepted", async () => {
    const accepted = await evaluateMusubi({
      stage: "dev",
      env: stackEnv(arcPublicJwk),
      sites: fixtures(),
    });
    expect(Object.keys(resourcesOf(accepted))).toContain("MusubiSocial");
    expect(accepted.fetches).toEqual([]);
  });

  test("SB9: site output built for other hosts, or none, refuses the run before it writes or calls anything", async () => {
    const otherHosts = fixtures((entry) =>
      entry.origins.map((value) => value.replace(DEV_DOMAIN, "other.test")),
    );
    for (const sites of [otherHosts, {}]) {
      const refused = await evaluateMusubi({ stage: "dev", env: stackEnv(arcPublicJwk), sites });
      expect(failureOf(refused)).toBeInstanceOf(SiteBuildError);
      expect(failureOf(refused)).toMatchObject({
        site: "@musubi/social",
        missing: [`https://id.musubi.${DEV_DOMAIN}`],
      });
      expect(existsSync(refused.generatedDir)).toBe(false);
      expect(refused.fetches).toEqual([]);
    }
    // Every origin counts: output lacking any one is refused, naming its site.
    for (const entry of SITE_ORIGINS) {
      for (const lacking of entry.origins) {
        const refused = await evaluateMusubi({
          stage: "dev",
          env: stackEnv(arcPublicJwk),
          sites: fixtures((other) =>
            other === entry ? other.origins.filter((value) => value !== lacking) : other.origins,
          ),
        });
        expect(failureOf(refused)).toMatchObject({ site: entry.site, missing: [lacking] });
        expect(existsSync(refused.generatedDir)).toBe(false);
      }
    }
  });
});
