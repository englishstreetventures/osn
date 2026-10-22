import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { evaluateZap, removeEvaluations, resourcesOf, stackEnv, type Evaluation } from "./evaluate";

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
