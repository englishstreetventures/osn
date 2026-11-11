// PS8: no Worker that Wrangler deploys routes a site's production host. The
// plan guard reads the production stacks' site Workers alone, so a host
// PRODUCTION_HOST_HOLDS holds off stays off only while no Wrangler-deployed
// Worker can take it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { productionHost, SITE_SURFACES } from "../src/production-sites";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every tracked Wrangler config outside a test fixture. */
const CONFIGS = Bun.spawnSync(
  ["git", "ls-files", "*wrangler.toml", "*wrangler.jsonc", "*wrangler.json"],
  { cwd: ROOT },
)
  .stdout.toString()
  .split("\n")
  .filter((path) => path !== "" && !path.includes("/tests/"))
  .toSorted();

/** A Wrangler config as data: TOML, or JSON with comments. */
const parse = (config: string): unknown => {
  const text = readFileSync(`${ROOT}${config}`, "utf8");
  return config.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.JSONC.parse(text);
};

/**
 * Every route pattern in `value`, at the top level and in each `env` block:
 * a `route` string, and each `routes` entry, a string or a `{ pattern }`.
 */
function routePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(routePatterns);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]): string[] => {
    if (key === "route" && typeof entry === "string") return [entry];
    if (key === "routes" && Array.isArray(entry)) {
      return entry.flatMap((route: unknown) =>
        typeof route === "string"
          ? [route]
          : typeof route === "object" &&
              route !== null &&
              typeof (route as { pattern?: unknown }).pattern === "string"
            ? [(route as { pattern: string }).pattern]
            : [],
      );
    }
    return routePatterns(entry);
  });
}

/** Whether a route pattern's host part, `*` matching anything, takes `host`. */
const takes = (pattern: string, host: string): boolean => {
  const hostPart = pattern.split("/")[0] ?? "";
  const escaped = hostPart.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(host);
};

describe("PS8: the Wrangler-deployed Workers' routes", () => {
  test("are read from every deploying Wrangler config, in each form a config writes them", () => {
    expect(CONFIGS).toEqual(
      expect.arrayContaining([
        "cire/api/wrangler.toml",
        "cire/invites/wrangler.jsonc",
        "osn/api/wrangler.toml",
        "zap/api/wrangler.toml",
      ]),
    );
    expect(CONFIGS.flatMap((config) => routePatterns(parse(config))).toSorted()).toEqual(
      expect.arrayContaining([
        "api.cireweddings.com",
        "id.musubi.social",
        "invite.cireweddings.com",
        "zap.cireweddings.com",
      ]),
    );
    expect(
      routePatterns({
        route: "a.example/*",
        routes: ["b.example/*", { pattern: "c.example" }],
        env: { production: { routes: [{ pattern: "d.example", custom_domain: true }] } },
      }).toSorted(),
    ).toEqual(["a.example/*", "b.example/*", "c.example", "d.example"]);
    expect(takes("*musubi.social/*", "musubi.social")).toBe(true);
    expect(takes("*.musubi.social/*", "www.musubi.social")).toBe(true);
    expect(takes("id.musubi.social", "musubi.social")).toBe(false);
  });

  test.each(SITE_SURFACES.map((site) => [site, productionHost(site)] as const))(
    "%s: none takes %s",
    (_, host) => {
      for (const config of CONFIGS) {
        const taking = routePatterns(parse(config)).filter((pattern) => takes(pattern, host));
        expect({ config, taking }).toEqual({ config, taking: [] });
      }
    },
  );

  test("each config it reads is an input of the cached `test:repo` task, so a change to one reruns it", () => {
    const turbo = Bun.JSONC.parse(readFileSync(`${ROOT}shared/infra/turbo.json`, "utf8")) as {
      tasks: { "test:repo": { inputs: string[] } };
    };
    const inputs = turbo.tasks["test:repo"].inputs
      .filter((input) => /wrangler\.(toml|jsonc|json)$/.test(input))
      .map((input) => input.replace("$TURBO_ROOT$/", ""))
      .toSorted();
    expect(inputs).toEqual(CONFIGS);
  });
});
