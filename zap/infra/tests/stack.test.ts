import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { refusedTargets } from "../../../shared/infra/tests/support/refused-targets";
import {
  DEV_DOMAIN,
  evaluateZap,
  failureOf,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
} from "./evaluate";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let dev: Evaluation;

beforeAll(async () => {
  dev = await evaluateZap({ stage: "dev", env: stackEnv() });
});

afterAll(removeEvaluations);

describe("the zap stack, evaluated offline", () => {
  test("K1: zap-api and its database take their dev names, and zap-api its host under DEV_DOMAIN", async () => {
    const resources = resourcesOf(dev);
    expect(dev.fetches).toEqual([]);
    // Logical ids key the state rows, so they never change once deployed.
    expect(Object.keys(resources).toSorted()).toEqual(["ZapApi", "ZapDb"]);
    expect(resources.ZapApi?.Props.name).toBe("zap-api-dev");
    // The script the secret inventory checks on dev.
    expect(resources.ZapApi?.Props.name).toBe(tierSecrets("zap-api", "dev").scriptName);
    expect(resources.ZapDb?.Props.name).toBe("zap-db-dev");
    expect(resources.ZapApi?.Props.domain).toBe(`zap.cire.${DEV_DOMAIN}`);

    const env = resources.ZapApi?.Props.env ?? {};
    // OSN_ENV marks a deployed tier, so zap-api runs its fail-closed checks
    // on the JWKS URL, the issuer and the CORS list; ZAP_CORS_ORIGIN names
    // the one browser origin on dev that calls it.
    expect({
      OSN_ENV: env.OSN_ENV,
      OSN_JWKS_URL: env.OSN_JWKS_URL,
      OSN_ISSUER_URL: env.OSN_ISSUER_URL,
      OSN_API_URL: env.OSN_API_URL,
      ZAP_CORS_ORIGIN: env.ZAP_CORS_ORIGIN,
    }).toEqual({
      OSN_ENV: "dev",
      OSN_JWKS_URL: `https://id.musubi.${DEV_DOMAIN}/.well-known/jwks.json`,
      OSN_ISSUER_URL: `https://id.musubi.${DEV_DOMAIN}`,
      OSN_API_URL: `https://id.musubi.${DEV_DOMAIN}`,
      ZAP_CORS_ORIGIN: `https://musubi.${DEV_DOMAIN}`,
    });
    // The D1 binding is the database this stack declares, so zap-api reaches
    // the dev database and nothing else.
    expect(env.DB).toBe(resources.ZapDb);

    // An investigation stage derives every name and host from its own name.
    const investigation = resourcesOf(await evaluateZap({ stage: "probe", env: stackEnv() }));
    expect(investigation.ZapApi?.Props.name).toBe("zap-api-probe");
    expect(investigation.ZapDb?.Props.name).toBe("zap-db-probe");
    expect(investigation.ZapApi?.Props.domain).toBe(`zap.cire.probe.${DEV_DOMAIN}`);
    expect(investigation.ZapApi?.Props.env?.OSN_ISSUER_URL).toBe(
      `https://id.musubi.probe.${DEV_DOMAIN}`,
    );
  });

  test.each(refusedTargets(["zap-api"]))(
    "K12: $name refuses the run before it writes or calls anything",
    async (target) => {
      const refused = await evaluateZap({
        stage: target.stage,
        env: target.edit(stackEnv()),
        workingDirFiles: target.workingDirFiles,
      });
      expect(failureOf(refused)).toBeInstanceOf(target.refusal);
      expect(failureOf(refused)).toMatchObject(target.fields(refused));
      expect(existsSync(refused.generatedDir)).toBe(false);
      expect(refused.fetches).toEqual([]);
    },
  );

  test("K5: every resource the dev stage keeps is retained on destroy and replacement", () => {
    const resources = resourcesOf(dev);
    expect(
      Object.values(resources).map((resource) => [resource.LogicalId, resource.RemovalPolicy]),
    ).toEqual(Object.keys(resources).map((logicalId) => [logicalId, "retain"]));
  });

  test("K6: zap-db-dev takes production's read replication in oc, migrated from the flattened chain, with nothing imported", () => {
    const props = resourcesOf(dev).ZapDb?.Props;
    // Production's zap-db-prod: read replication disabled, region OC, the default jurisdiction.
    expect(props?.readReplication).toEqual({ mode: "disabled" });
    expect(props?.jurisdiction).toBe("default");
    expect(props?.primaryLocationHint).toBe("oc");
    expect(props?.importFiles).toBeUndefined();

    const migrations = join(dev.generatedDir, "migrations", "zap-db");
    expect(props?.migrations).toBe(migrations);
    const chain = readdirSync(join(repoRoot, "zap/db/drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
    expect(chain.length).toBeGreaterThan(0);
    expect(readdirSync(migrations).toSorted()).toEqual(chain);
  });
});
