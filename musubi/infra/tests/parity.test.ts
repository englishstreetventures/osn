import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  evaluateMusubi,
  generateArcPublicJwk,
  productionEnv,
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
  readonly d1_databases: readonly { readonly binding: string; readonly database_name: string }[];
  readonly durable_objects: {
    readonly bindings: readonly { readonly name: string; readonly class_name: string }[];
  };
  readonly triggers: { readonly crons: readonly string[] };
  readonly routes: readonly { readonly pattern: string; readonly custom_domain: boolean }[];
  readonly observability: {
    readonly enabled: boolean;
    readonly head_sampling_rate: number;
    readonly redact_query_string: boolean;
    readonly traces: { readonly enabled: boolean };
    readonly logs?: { readonly invocation_logs: boolean };
  };
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

describe("PA: osn-api on production against Wrangler's production config", () => {
  let production: Evaluation;

  beforeAll(async () => {
    production = await evaluateMusubi({ stage: "production", env: productionEnv() });
  });

  test("PA1: osn-api's vars equal [env.production]'s exactly, and it uploads no secret", () => {
    const env = resourcesOf(production).OsnApi?.Props.env ?? {};
    const vars = Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === "string"),
    );
    expect(vars).toEqual(wrangler.env.production.vars);
    const row = tierSecrets("osn-api", "production");
    for (const name of [...row.secrets, ...row.optional]) expect(env).not.toHaveProperty(name);
  });

  test("PA2: osn-api's bindings are [env.production]'s: the database by name, the coordination store's class, and each limiter's id and budget", () => {
    const production_ = wrangler.env.production;
    const resources = resourcesOf(production);
    const env = resources.OsnApi?.Props.env ?? {};
    expect(env.DB).toBe(resources.OsnDb);
    expect(resources.OsnDb?.Props.name).toBe(production_.d1_databases[0]?.database_name);
    for (const binding of production_.durable_objects.bindings) {
      expect({ [binding.name]: env[binding.name] }).toMatchObject({
        [binding.name]: { kind: "Cloudflare.DurableObject", className: binding.class_name },
      });
    }
    for (const limiter of production_.ratelimits) {
      expect({ [limiter.name]: env[limiter.name] }).toMatchObject({
        [limiter.name]: {
          kind: "Cloudflare.RateLimit",
          namespaceId: limiter.namespace_id,
          simple: limiter.simple,
        },
      });
    }
    expect(Object.keys(env).toSorted()).toEqual(
      [
        ...Object.keys(production_.vars),
        ...production_.d1_databases.map((d) => d.binding),
        ...production_.durable_objects.bindings.map((b) => b.name),
        ...production_.ratelimits.map((r) => r.name),
      ].toSorted(),
    );
  });

  test("PA3: osn-api's domain, crons, compatibility and observability are [env.production]'s, plus legacy_module_registry", () => {
    const props = resourcesOf(production).OsnApi?.Props;
    const production_ = wrangler.env.production;
    expect(production_.routes).toEqual([{ pattern: props?.domain, custom_domain: true }]);
    expect(props?.crons).toEqual(production_.triggers.crons);
    expect(props?.compatibility).toEqual({
      date: wrangler.compatibility_date,
      flags: [...wrangler.compatibility_flags, "legacy_module_registry"],
    });
    expect(props?.observability).toEqual({
      enabled: production_.observability.enabled,
      headSamplingRate: production_.observability.head_sampling_rate,
      redactQueryString: production_.observability.redact_query_string,
      // The file sets no invocation logs, which Cloudflare keeps on.
      logs: {
        enabled: true,
        invocationLogs: production_.observability.logs?.invocation_logs ?? true,
      },
      traces: { enabled: production_.observability.traces.enabled },
      issues: { enabled: true },
    });
  });
});
