import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  evaluateZap,
  productionEnv,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
} from "./evaluate";

interface WranglerTier {
  readonly vars: Readonly<Record<string, string>>;
  readonly d1_databases: readonly { readonly binding: string }[];
  readonly triggers?: { readonly crons: readonly string[] };
}

interface WranglerConfig {
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
  readonly env: { readonly production: WranglerTier };
}

const wrangler = Bun.TOML.parse(
  readFileSync(fileURLToPath(new URL("../../../zap/api/wrangler.toml", import.meta.url)), "utf8"),
) as WranglerConfig;

/** No zap code reads a GrowthBook key; the inventory forbids it on both tiers. */
const RETIRED = "GROWTHBOOK_CLIENT_KEY";

let dev: Evaluation;

beforeAll(async () => {
  dev = await evaluateZap({ stage: "dev", env: stackEnv() });
});

afterAll(removeEvaluations);

describe("zap-api on dev against Wrangler's production config", () => {
  test("K2: binding, var and secret names are production's plus the tier marker and CORS list; the retired GrowthBook key is in neither", () => {
    const production = wrangler.env.production;
    const secrets = tierSecrets("zap-api", "production");
    const productionNames = [
      ...Object.keys(production.vars),
      ...production.d1_databases.map((database) => database.binding),
      ...secrets.secrets,
      ...secrets.optional,
    ].toSorted();
    const devNames = Object.keys(resourcesOf(dev).ZapApi?.Props.env ?? {}).toSorted();

    // Dev adds exactly the tier marker and the CORS list to production's names.
    const devOnly = new Set(["OSN_ENV", "ZAP_CORS_ORIGIN"]);
    expect(devNames.filter((name) => !devOnly.has(name))).toEqual(productionNames);
    expect(devNames).toEqual(
      [
        "DB",
        "INTERNAL_SERVICE_SECRET",
        "OSN_API_URL",
        "OSN_ENV",
        "OSN_ISSUER_URL",
        "OSN_JWKS_URL",
        "ZAP_CORS_ORIGIN",
      ].toSorted(),
    );
    expect(devNames).not.toContain(RETIRED);
    expect(productionNames).not.toContain(RETIRED);
    expect(tierSecrets("zap-api", "dev").forbidden).toContain(RETIRED);
    expect(secrets.forbidden).toContain(RETIRED);
  });

  test("K3: compatibility date and flags equal Wrangler's plus legacy_module_registry; crons equal production's", () => {
    const props = resourcesOf(dev).ZapApi?.Props;
    expect(props?.compatibility).toEqual({
      date: wrangler.compatibility_date,
      flags: [...wrangler.compatibility_flags, "legacy_module_registry"],
    });
    expect(props?.crons).toEqual(wrangler.env.production.triggers?.crons ?? []);
  });
});

describe("PA: zap-api on production against Wrangler's production config", () => {
  let production: Evaluation;

  beforeAll(async () => {
    production = await evaluateZap({ stage: "production", env: productionEnv() });
  });

  test("PA1: zap-api's vars equal [env.production]'s exactly, it binds its database by name, and it uploads no secret", () => {
    const resources = resourcesOf(production);
    const env = resources.ZapApi?.Props.env ?? {};
    const vars = Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === "string"),
    );
    expect(vars).toEqual(wrangler.env.production.vars);
    expect(env.DB).toBe(resources.ZapDb);
    expect(resources.ZapDb?.Props.name).toBe(productionDatabase.database_name);
    expect(Object.keys(env).toSorted()).toEqual(
      [...Object.keys(wrangler.env.production.vars), productionDatabase.binding].toSorted(),
    );
  });

  test("PA3: zap-api's domain, crons and compatibility are [env.production]'s, plus legacy_module_registry; its Workers Logs stay off, as the file sets no observability.enabled", () => {
    const props = resourcesOf(production).ZapApi?.Props;
    expect(productionConfig.routes).toEqual([{ pattern: props?.domain, custom_domain: true }]);
    expect(props?.crons).toEqual(wrangler.env.production.triggers?.crons ?? []);
    expect(props?.compatibility).toEqual({
      date: wrangler.compatibility_date,
      flags: [...wrangler.compatibility_flags, "legacy_module_registry"],
    });
    expect(productionConfig.observability.enabled).toBeUndefined();
    expect(props?.observability).toMatchObject({
      enabled: false,
      redactQueryString: productionConfig.observability.redact_query_string,
      logs: { enabled: false, invocationLogs: false },
      traces: { enabled: productionConfig.observability.traces.enabled },
    });
  });
});

/** `[env.production]` with the fields the production tests read. */
const productionConfig = wrangler.env.production as unknown as {
  readonly routes: readonly { readonly pattern: string; readonly custom_domain: boolean }[];
  readonly observability: {
    readonly enabled?: boolean;
    readonly redact_query_string: boolean;
    readonly traces: { readonly enabled: boolean };
  };
};
const productionDatabase = (
  wrangler.env.production.d1_databases as unknown as readonly {
    readonly binding: string;
    readonly database_name: string;
  }[]
)[0]!;
