import { describe, expect, it } from "bun:test";

import { DAILY_CRON, HAND_BACK_CRON } from "../src/lib/crons";

/**
 * The realtime push bindings, per Wrangler tier. Named environments inherit
 * no bindings, so each tier must declare its own; a tier that forgets ships
 * with push off and nothing fails. The class declaration is the opposite: a
 * top-level migration is inherited, and declaring it once is the rule. The
 * dev Worker is declared by the cire stack, not here (cire/infra's K2).
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
  env: { production: Tier & { migrations?: unknown } };
}

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
) as Config;

const tiers: [string, Tier][] = [
  ["the top level", config],
  ["env.production", config.env.production],
];

describe("wrangler.toml — realtime push", () => {
  it("makes the module that exports the hub class the Worker's entry", () => {
    expect(config.main).toBe("src/entry.ts");
  });

  it("declares TopicHub once, SQLite-backed, at the top level only", () => {
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TopicHub"] }]);
    expect(config.env.production.migrations).toBeUndefined();
  });

  it.each(tiers)("%s binds REALTIME_HUB to TopicHub", (_label, tier) => {
    expect(tier.durable_objects?.bindings).toContainEqual({
      name: "REALTIME_HUB",
      class_name: "TopicHub",
    });
  });

  // A rate-limit namespace id is the whole scope of its counter, so two
  // bindings on one id in a tier share one count under two limits.
  it.each(tiers)("%s gives every rate-limit binding its own namespace", (_label, tier) => {
    const ids = (tier.unsafe?.bindings ?? []).map((binding) => binding.namespace_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * `scheduled` tells its two jobs apart by the expression Cloudflare hands it,
 * character for character. A tier whose list drifts from the constants never
 * runs the hand-back, and runs the daily jobs twice a day.
 */
describe("wrangler.toml — cron triggers", () => {
  const crons = (tier: { triggers?: { crons?: string[] } }) => tier.triggers?.crons;

  it.each([
    ["the top level", config as unknown as { triggers?: { crons?: string[] } }],
    ["env.production", config.env.production as unknown as { triggers?: { crons?: string[] } }],
  ])("%s declares the daily run and the hand-back, as `scheduled` reads them", (_label, tier) => {
    expect(crons(tier)).toEqual([DAILY_CRON, HAND_BACK_CRON]);
  });
});
