import { describe, expect, it } from "bun:test";

/**
 * The realtime push bindings, per tier. Named environments inherit no
 * bindings, so each tier must declare its own; a tier that forgets ships with
 * push off and nothing fails. The class declaration is the opposite: a
 * top-level migration is inherited, and declaring it once is the rule.
 */

interface RateLimit {
  name: string;
  type: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}
interface Tier {
  durable_objects?: { bindings?: { name: string; class_name: string }[] };
  unsafe?: { bindings?: RateLimit[] };
}
interface Config extends Tier {
  main: string;
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  env: { dev: Tier & { migrations?: unknown }; production: Tier & { migrations?: unknown } };
}

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
) as Config;

const tiers: [string, Tier, string][] = [
  ["the top level", config, "1006"],
  ["env.dev", config.env.dev, "1106"],
  ["env.production", config.env.production, "1006"],
];

describe("wrangler.toml — realtime push", () => {
  it("makes the module that exports the hub class the Worker's entry", () => {
    expect(config.main).toBe("src/entry.ts");
  });

  it("declares TopicHub once, SQLite-backed, at the top level only", () => {
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TopicHub"] }]);
    expect(config.env.dev.migrations).toBeUndefined();
    expect(config.env.production.migrations).toBeUndefined();
  });

  it.each(tiers)("%s binds REALTIME_HUB to TopicHub", (_label, tier) => {
    expect(tier.durable_objects?.bindings).toContainEqual({
      name: "REALTIME_HUB",
      class_name: "TopicHub",
    });
  });

  it.each(tiers)(
    "%s binds REALTIME_RATE_LIMITER on its own namespace",
    (_label, tier, namespace) => {
      const bindings = tier.unsafe?.bindings ?? [];
      expect(bindings.find((binding) => binding.name === "REALTIME_RATE_LIMITER")).toEqual({
        name: "REALTIME_RATE_LIMITER",
        type: "ratelimit",
        namespace_id: namespace,
        simple: { limit: 30, period: 60 },
      });
      const ids = bindings.map((binding) => binding.namespace_id);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
