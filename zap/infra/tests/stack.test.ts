import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SURFACES, type SurfaceKey } from "../../../scripts/deploy-surfaces";
import { listMigrations } from "../../../scripts/migration-files";
import { devTarget, productionTarget } from "../../../scripts/smoke-check";
import { refusedTargets } from "../../../shared/infra/tests/support/refused-targets";
import { API_LOGICAL_IDS, PRODUCTION_ADOPTED, PRODUCTION_RESOURCE_KINDS } from "../src/declaration";
import {
  DEV_DOMAIN,
  evaluateZap,
  failureOf,
  productionEnv,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
} from "./evaluate";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Each dev surface of the zap stack and the logical id of the Worker it
 * deploys: the smoke check's snapshot, compare and rollback act on that
 * surface's dev target.
 */
const SURFACE_WORKERS = [["zap_api", "ZapApi"]] as const satisfies readonly (readonly [
  SurfaceKey,
  string,
])[];

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

  test("K11: no Worker serves a workers.dev host or version preview URLs, each a public host outside Access", async () => {
    const investigation = await evaluateZap({ stage: "probe", env: stackEnv() });
    for (const evaluation of [dev, investigation]) {
      const workers = Object.values(resourcesOf(evaluation)).filter(
        (resource) => resource.Type === "Cloudflare.Worker",
      );
      expect(workers.map((worker) => worker.LogicalId).toSorted()).toEqual(["ZapApi"]);
      for (const worker of workers) {
        expect({ [worker.LogicalId]: worker.Props.workersDev }).toEqual({
          [worker.LogicalId]: { enabled: false, previewsEnabled: false },
        });
      }
    }
  });

  test("K13: each dev surface's smoke target names the Worker the stack deploys for it", () => {
    const resources = resourcesOf(dev);
    expect(
      SURFACES.filter((surface) => surface.stack === "zap")
        .map((surface) => surface.key)
        .toSorted(),
    ).toEqual(SURFACE_WORKERS.map(([key]) => key).toSorted());
    expect(SURFACE_WORKERS.map(([key]) => [key, devTarget(key)?.worker])).toEqual(
      SURFACE_WORKERS.map(([key, logicalId]) => [key, resources[logicalId]?.Props.name]),
    );
  });

  test.each(refusedTargets(["zap-api"], "declared"))(
    "K12: $name refuses the run before it writes or calls anything",
    async (target) => {
      const refused = await evaluateZap({
        stage: target.stage,
        env: target.edit(stackEnv()),
        workingDirFiles: target.workingDirFiles,
      });
      expect(failureOf(refused)).toMatchObject({ _tag: target.refusal, ...target.fields(refused) });
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
    const chain = listMigrations(join(repoRoot, "zap/db/drizzle")).toSorted();
    expect(chain.length).toBeGreaterThan(0);
    expect(readdirSync(migrations).toSorted()).toEqual(chain);
  });
});

describe("the zap stack on production", () => {
  let production: Evaluation;

  beforeAll(async () => {
    production = await evaluateZap({ stage: "production", env: productionEnv() });
  });

  test("KP1: declares zap-api and its database under today's production names, retained, zap-api to be adopted, and nothing the guard does not know", () => {
    const resources = resourcesOf(production);
    expect(production.fetches).toEqual([]);
    expect(
      Object.fromEntries(
        Object.entries(resources).map(([id, resource]) => [
          id,
          [resource.Type, resource.Props.name, resource.RemovalPolicy, resource.Adopt],
        ]),
      ),
    ).toEqual({
      ZapApi: ["Cloudflare.Worker", "zap-api-production", "retain", true],
      ZapDb: ["Cloudflare.D1Database", "zap-db-prod", "retain", undefined],
    });
    expect(PRODUCTION_RESOURCE_KINDS).toEqual({ ZapApi: "api-worker", ZapDb: "d1" });
    expect(API_LOGICAL_IDS).toEqual({ zap_api: "ZapApi" });
  });

  test("KP2: zap-api serves zap.cireweddings.com, with no workers.dev or preview URL; zap-db-prod has no migrations or imports", () => {
    const resources = resourcesOf(production);
    expect(resources.ZapApi?.Props.domain).toBe("zap.cireweddings.com");
    expect(resources.ZapApi?.Props.workersDev).toEqual({ enabled: false, previewsEnabled: false });
    expect(resources.ZapDb?.Props).toEqual({
      name: "zap-db-prod",
      readReplication: { mode: "disabled" },
      jurisdiction: "default",
    });
  });

  test("KP3: reads no zap secret or DEV_DOMAIN, uploads no secret, and writes nothing", async () => {
    expect(existsSync(production.generatedDir)).toBe(false);
    const names = (["dev", "production"] as const).flatMap((tier) => {
      const row = tierSecrets("zap-api", tier);
      return row.secrets.concat(row.optional, row.forbidden);
    });
    const withSecrets = await evaluateZap({
      stage: "production",
      env: {
        ...stackEnv(),
        ...Object.fromEntries(names.map((name) => [name, `placeholder-${name}`])),
        ...productionEnv(),
      },
    });
    const env = resourcesOf(withSecrets).ZapApi?.Props.env ?? {};
    expect(Object.values(env).some((value) => Redacted.isRedacted(value))).toBe(false);
    expect(existsSync(withSecrets.generatedDir)).toBe(false);
  });

  test("KP6: zap-api's production smoke target names the Worker the stack deploys", () => {
    expect(productionTarget("zap_api")?.worker).toBe(resourcesOf(production).ZapApi?.Props.name);
  });

  test("KA4: the adopted resources the live read and the guard compare are the ones the stack declares", () => {
    const props = resourcesOf(production).ZapApi?.Props;
    const adopted = PRODUCTION_ADOPTED.workers.ZapApi;
    expect({ name: props?.name, crons: props?.crons }).toEqual({
      name: adopted?.name,
      crons: adopted?.crons,
    });
    // Every declared name, and besides them only those the provider adds.
    const declaredNames = Object.keys(props?.env ?? {}).toSorted();
    expect(adopted?.envNames.filter((name) => declaredNames.includes(name))).toEqual(declaredNames);
    expect(
      adopted?.envNames.filter(
        (name) => !declaredNames.includes(name) && !/^(ALCHEMY_[A-Z_]+|ASSETS)$/.test(name),
      ),
    ).toEqual([]);
    expect(adopted?.envNames).toContain("ALCHEMY_STAGE");
    expect(PRODUCTION_ADOPTED.databases).toEqual({
      ZapDb: { name: "zap-db-prod", readReplication: "disabled" },
    });
  });
});
