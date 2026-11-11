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
  .filter((path) => path !== "" && !path.includes("/tests/"));

/** The host of each route pattern `config` names, in TOML or JSONC. */
const routeHosts = (config: string): string[] =>
  [...readFileSync(`${ROOT}${config}`, "utf8").matchAll(/"?pattern"?\s*[=:]\s*"([^"]+)"/g)].map(
    (match) => (match[1] ?? "").split("/")[0] ?? "",
  );

describe("PS8: the Wrangler-deployed Workers' routes", () => {
  test("are read from every deploying Wrangler config", () => {
    expect(CONFIGS).toEqual(
      expect.arrayContaining([
        "cire/api/wrangler.toml",
        "cire/invites/wrangler.jsonc",
        "osn/api/wrangler.toml",
        "zap/api/wrangler.toml",
      ]),
    );
    expect(CONFIGS.flatMap(routeHosts).toSorted()).toEqual(
      expect.arrayContaining([
        "api.cireweddings.com",
        "id.musubi.social",
        "invite.cireweddings.com",
        "zap.cireweddings.com",
      ]),
    );
  });

  test.each(SITE_SURFACES.map((site) => [site, productionHost(site)] as const))(
    "%s: none names %s",
    (_, host) => {
      for (const config of CONFIGS) {
        expect({ config, routes: routeHosts(config).includes(host) }).toEqual({
          config,
          routes: false,
        });
      }
    },
  );
});
