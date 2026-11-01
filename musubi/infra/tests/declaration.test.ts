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

describe("musubiDeclaration", () => {
  // osn-api's own tests hold production's limits to its budget table
  // (osn/api/tests/lib/native-rate-limiters.test.ts), so equal to production
  // here means equal to the budget table.
  test("dev's rate-limit tiers are production's, at production's period and limit, each in its own namespace", () => {
    const declared = musubiDeclaration({
      stage: "dev",
      hosts: stageHosts("example.test", "dev"),
      generatedDir: ".generated",
    }).osnApi.bindings;

    const devTiers = Object.entries(declared).flatMap(([name, binding]) =>
      binding.kind === "ratelimit" ? [name] : [],
    );
    expect(devTiers.toSorted()).toEqual(
      wranglerProductionLimits.map((production) => production.name).toSorted(),
    );

    const expected = Object.fromEntries(
      wranglerProductionLimits.map((production) => [
        production.name,
        {
          period: production.simple.period,
          limit: production.simple.limit,
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
