import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  evaluateMusubi,
  generateArcPublicJwk,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
} from "./evaluate";

interface WranglerTier {
  readonly vars: Readonly<Record<string, string>>;
  readonly ratelimits: readonly {
    readonly name: string;
    readonly namespace_id: string;
    readonly simple: { readonly limit: number; readonly period: number };
  }[];
  readonly d1_databases: readonly { readonly binding: string }[];
  readonly durable_objects: {
    readonly bindings: readonly { readonly name: string; readonly class_name: string }[];
  };
  readonly triggers: { readonly crons: readonly string[] };
}

interface WranglerConfig {
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
  readonly env: { readonly production: WranglerTier };
}

const wrangler = Bun.TOML.parse(
  readFileSync(fileURLToPath(new URL("../../../osn/api/wrangler.toml", import.meta.url)), "utf8"),
) as WranglerConfig;

/** Binding, var and secret names osn-api holds on dev and not on production, each with why. */
const DEV_ONLY: Readonly<Record<string, string>> = {
  DEV_LOGIN_RETURN_ORIGINS: "dev-login targets exist only off production",
  DEV_LOGIN_SECRET: "dev login is refused on production",
};

/** Names osn-api holds on production and not on dev, each with why. */
const PRODUCTION_ONLY: Readonly<Record<string, string>> = {
  TURNSTILE_SECRET_KEY: "dev does not enforce Turnstile; osn-api is key-optional",
  OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS:
    "dev is on Workers Free: unset, the sweep keeps its default of 10 chunks, inside the 50 D1 queries one cron run may make",
};

let dev: Evaluation;

beforeAll(async () => {
  dev = await evaluateMusubi({ stage: "dev", env: stackEnv(await generateArcPublicJwk()) });
});

afterAll(removeEvaluations);

describe("osn-api on dev against Wrangler's production config", () => {
  test("K2: binding, var and secret names equal production's, apart from the listed differences", () => {
    const production = wrangler.env.production;
    const secrets = tierSecrets("osn-api", "production");
    const productionNames = new Set([
      ...Object.keys(production.vars),
      ...production.ratelimits.map((limit) => limit.name),
      ...production.d1_databases.map((database) => database.binding),
      ...production.durable_objects.bindings.map((binding) => binding.name),
      ...secrets.secrets,
      ...secrets.optional,
    ]);
    const devEnv = resourcesOf(dev).OsnApi?.Props.env ?? {};
    const devNames = new Set(Object.keys(devEnv));

    expect([...devNames].filter((name) => !productionNames.has(name)).toSorted()).toEqual(
      Object.keys(DEV_ONLY).toSorted(),
    );
    expect([...productionNames].filter((name) => !devNames.has(name)).toSorted()).toEqual(
      Object.keys(PRODUCTION_ONLY).toSorted(),
    );

    // Each limiter keeps production's budget in the dev range (production's
    // namespace id plus 100), so dev traffic never spends a production counter.
    for (const limiter of production.ratelimits) {
      expect({ [limiter.name]: devEnv[limiter.name] }).toMatchObject({
        [limiter.name]: {
          kind: "Cloudflare.RateLimit",
          namespaceId: String(Number(limiter.namespace_id) + 100),
          simple: limiter.simple,
        },
      });
    }

    // Each Durable Object namespace binds production's class, hosted by
    // osn-api itself: no script name, so the dev Worker exports the class.
    for (const binding of production.durable_objects.bindings) {
      expect({ [binding.name]: devEnv[binding.name] }).toMatchObject({
        [binding.name]: { kind: "Cloudflare.DurableObject", className: binding.class_name },
      });
      expect(devEnv[binding.name]).not.toHaveProperty("scriptName", expect.anything());
    }
  });

  test("K3: compatibility date and flags equal Wrangler's plus legacy_module_registry; crons equal production's", () => {
    const props = resourcesOf(dev).OsnApi?.Props;
    expect(props?.compatibility).toEqual({
      date: wrangler.compatibility_date,
      flags: [...wrangler.compatibility_flags, "legacy_module_registry"],
    });
    expect(props?.crons).toEqual(wrangler.env.production.triggers.crons);
  });
});
