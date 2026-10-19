import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tierSecrets } from "@shared/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  evaluateCire,
  removeEvaluations,
  resourcesOf,
  stackEnv,
  type Evaluation,
} from "./evaluate";

interface UnsafeBinding {
  readonly name: string;
  readonly type: string;
  readonly namespace_id: string;
  readonly simple: { readonly limit: number; readonly period: number };
}

interface WranglerTier {
  readonly vars: Readonly<Record<string, string>>;
  readonly unsafe: { readonly bindings: readonly UnsafeBinding[] };
  readonly d1_databases: readonly { readonly binding: string }[];
  readonly r2_buckets: readonly { readonly binding: string }[];
  readonly images: { readonly binding: string };
  readonly triggers: { readonly crons: readonly string[] };
}

interface WranglerConfig {
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
  /** The top-level bindings: what the D1 latency probe paces itself by. */
  readonly unsafe: { readonly bindings: readonly UnsafeBinding[] };
  readonly env: { readonly production: WranglerTier };
}

const readRepo = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

const wrangler = Bun.TOML.parse(readRepo("cire/api/wrangler.toml")) as WranglerConfig;

/** `cire/invites/wrangler.jsonc`: the guest site's committed config, which the adapter's generated config extends. */
const invitesWrangler = Bun.JSONC.parse(readRepo("cire/invites/wrangler.jsonc")) as {
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
};

/** Binding, var and secret names cire-api holds on dev and not on production, each with why. */
const DEV_ONLY: Readonly<Record<string, string>> = {
  STRIPE_PLATFORM_WEBHOOK_SECRET:
    "production does not run Stripe yet: its inventory row holds no Stripe secret and production-release.yml passes none",
  STRIPE_SECRET_KEY: "the same: Stripe runs on dev only",
  STRIPE_WEBHOOK_SECRET: "the same: Stripe runs on dev only",
};

/** Names cire-api holds on production and not on dev, each with why. */
const PRODUCTION_ONLY: Readonly<Record<string, string>> = {
  ZAP_API_URL:
    "dev does not call zap: unset, the enquiry chat bridge is off and no vendor mail is sent",
  GROWTHBOOK_CLIENT_KEY: "dev has no GrowthBook key; every flag serves its coded default",
};

/** Keys of `cire/invites/wrangler.jsonc` that declare no var, binding or secret. */
const INVITES_NON_BINDING_KEYS = new Set([
  "name",
  "compatibility_date",
  "compatibility_flags",
  "observability",
  "upload_source_maps",
  "routes",
]);

let dev: Evaluation;

beforeAll(async () => {
  dev = await evaluateCire({ stage: "dev", env: stackEnv() });
});

afterAll(removeEvaluations);

describe("cire on dev against Wrangler's production config", () => {
  test("K2: cire-api's binding, var and secret names equal production's, apart from the listed differences; cire-invites holds none on either tier", () => {
    const production = wrangler.env.production;
    const secrets = tierSecrets("cire-api", "production");
    const limiters = production.unsafe.bindings.filter((binding) => binding.type === "ratelimit");
    const productionNames = new Set([
      ...Object.keys(production.vars),
      ...limiters.map((limiter) => limiter.name),
      ...production.d1_databases.map((database) => database.binding),
      ...production.r2_buckets.map((bucket) => bucket.binding),
      production.images.binding,
      ...secrets.secrets,
      ...secrets.optional,
    ]);
    const devEnv = resourcesOf(dev).CireApi?.Props.env ?? {};
    const devNames = new Set(Object.keys(devEnv));

    expect([...devNames].filter((name) => !productionNames.has(name)).toSorted()).toEqual(
      Object.keys(DEV_ONLY).toSorted(),
    );
    expect([...productionNames].filter((name) => !devNames.has(name)).toSorted()).toEqual(
      Object.keys(PRODUCTION_ONLY).toSorted(),
    );

    // Each limiter keeps production's budget in the dev range (production's
    // namespace id plus 100), so dev traffic never spends a production counter.
    for (const limiter of limiters) {
      expect({ [limiter.name]: devEnv[limiter.name] }).toMatchObject({
        [limiter.name]: {
          kind: "Cloudflare.RateLimit",
          namespaceId: String(Number(limiter.namespace_id) + 100),
          simple: limiter.simple,
        },
      });
    }

    expect(resourcesOf(dev).CireInvites?.Props.env).toEqual({});
    expect(tierSecrets("cire-invites", "production")).toMatchObject({ secrets: [], optional: [] });
    expect(
      Object.keys(invitesWrangler).filter((key) => !INVITES_NON_BINDING_KEYS.has(key)),
    ).toEqual([]);
  });

  test("L7: the dev session-restore limiter keeps the budget the D1 latency probe paces itself by", () => {
    // cire/api/scripts/d1-latency-probe.ts spaces its requests to the
    // top-level CLAIM_SESSION_RATE_LIMITER in cire/api/wrangler.toml and
    // probes the dev Worker, so the two must hold one budget.
    const name = "CLAIM_SESSION_RATE_LIMITER";
    const topLevel = wrangler.unsafe.bindings.find((binding) => binding.name === name);
    expect(topLevel).toBeDefined();
    expect(resourcesOf(dev).CireApi?.Props.env?.[name]).toMatchObject({
      kind: "Cloudflare.RateLimit",
      simple: topLevel?.simple,
    });
  });

  test("K3: cire-api's compatibility equals Wrangler's plus legacy_module_registry and its crons production's; cire-invites' equals its own config verbatim", () => {
    const resources = resourcesOf(dev);
    expect(resources.CireApi?.Props.compatibility).toEqual({
      date: wrangler.compatibility_date,
      flags: [...wrangler.compatibility_flags, "legacy_module_registry"],
    });
    expect(resources.CireApi?.Props.crons).toEqual(wrangler.env.production.triggers.crons);

    // Prebuilt and uploaded as it is: the flags reach Cloudflare verbatim.
    expect(resources.CireInvites?.Props.compatibility).toEqual({
      date: invitesWrangler.compatibility_date,
      flags: invitesWrangler.compatibility_flags,
    });
    expect(resources.CireInvites?.Props.crons).toEqual([]);
  });
});
