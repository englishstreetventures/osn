import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StageNotDeclaredError, stageHosts } from "@shared/infra";
import { describe, expect, test } from "vitest";

import { musubiDeclaration } from "../src/declaration";

interface WranglerRateLimit {
  readonly name: string;
  readonly namespace_id: string;
  readonly simple: { readonly limit: number; readonly period: number };
}

const wranglerProductionLimits: readonly WranglerRateLimit[] = (
  Bun.TOML.parse(
    readFileSync(fileURLToPath(new URL("../../../osn/api/wrangler.toml", import.meta.url)), "utf8"),
  ) as { env: { production: { ratelimits: WranglerRateLimit[] } } }
).env.production.ratelimits;

/** Dev tiers whose limit differs from production's, each with why. Every other tier must match. */
const DEV_LIMIT_DIFFERENCES: Readonly<Record<string, number>> = {
  RL_AUTH_IP_30_60: 60,
};

describe("musubiDeclaration", () => {
  test("dev's auth rate-limit tiers share production's period, keep their own namespace, and match its limit bar the listed differences", () => {
    const declared = musubiDeclaration({
      stage: "dev",
      hosts: stageHosts("example.test", "dev"),
      generatedDir: ".generated",
    }).osnApi.bindings;

    const expected = Object.fromEntries(
      wranglerProductionLimits.map((production) => [
        production.name,
        {
          period: production.simple.period,
          limit: DEV_LIMIT_DIFFERENCES[production.name] ?? production.simple.limit,
        },
      ]),
    );
    const actual = Object.fromEntries(
      wranglerProductionLimits.map((production) => {
        const dev = declared[production.name];
        if (dev?.kind !== "ratelimit") throw new Error(`${production.name} is not a ratelimit`);
        return [production.name, { period: dev.period, limit: dev.limit }];
      }),
    );
    expect(actual).toEqual(expected);

    for (const production of wranglerProductionLimits) {
      const dev = declared[production.name];
      if (dev?.kind !== "ratelimit") throw new Error(`${production.name} is not a ratelimit`);
      expect(String(dev.namespaceId)).not.toBe(production.namespace_id);
    }
  });
});

describe("musubiDeclaration", () => {
  test("K8: a production stage throws, naming the phase that declares it", () => {
    const declare = () =>
      musubiDeclaration({
        stage: "production",
        hosts: stageHosts("example.test", "dev"),
        generatedDir: ".generated",
      });
    expect(declare).toThrow(StageNotDeclaredError);
    expect(declare).toThrow(/P3/);
  });
});
