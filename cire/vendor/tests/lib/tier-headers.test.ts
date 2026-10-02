import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PRODUCTION_API_ORIGIN } from "@cire/build-tools/tier-headers";
import type { AstroConfig, HookParameters } from "astro";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import tierHeaders from "../../src/lib/tier-headers";

/** The one part of a Vite plugin the integration adds: its resolved-config hook. */
interface EnvProbe {
  configResolved?: ((config: { env: Record<string, unknown> }) => unknown) | undefined;
}

const CANONICAL = "https://canonical.example.test";
const LEGACY = "https://legacy.example.test";

// The rewrite itself is tested in `@cire/build-tools`. This checks what the
// portal hands it: the env chain `lib/osn.ts` reads, and the bundle to check.
describe("the portal's tier-headers wiring", () => {
  // `dist/` is what the portal serves; `server/` stands in for Astro's
  // `build.server`, which a static build leaves outside it.
  let root: string;
  let dist: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vendor-tier-headers-"));
    dist = join(root, "dist");
    await mkdir(join(dist, "_astro"), { recursive: true });
    await mkdir(join(root, "server"));
    // A client chunk naming every origin the cases below expect.
    await writeFile(
      join(dist, "_astro", "osn.js"),
      `"${CANONICAL}";"${LEGACY}";"http://localhost:8787"`,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Runs this portal's integration as `astro build` does; returns the `_headers` it leaves. */
  async function build(env: Record<string, string>): Promise<string> {
    await writeFile(join(dist, "_headers"), `/*\n  CSP: connect-src ${PRODUCTION_API_ORIGIN}\n`);
    const integration = tierHeaders();
    const plugins: EnvProbe[] = [];
    await integration.hooks["astro:config:setup"]!({
      command: "build",
      updateConfig: (config: { vite?: { plugins?: EnvProbe[] } }) => {
        plugins.push(...(config.vite?.plugins ?? []));
        return config;
      },
    } as unknown as HookParameters<"astro:config:setup">);
    await integration.hooks["astro:config:done"]?.({
      config: { build: { server: pathToFileURL(`${root}/server/`) } } as unknown as AstroConfig,
    } as unknown as HookParameters<"astro:config:done">);
    for (const plugin of plugins) await plugin.configResolved?.({ env });
    await integration.hooks["astro:build:done"]!({
      dir: pathToFileURL(`${dist}/`),
      logger: { info: () => {} },
    } as unknown as HookParameters<"astro:build:done">);
    return readFile(join(dist, "_headers"), "utf8");
  }

  it("prefers PUBLIC_CIRE_API_URL over PUBLIC_API_URL", async () => {
    const headers = await build({ PUBLIC_CIRE_API_URL: CANONICAL, PUBLIC_API_URL: LEGACY });
    expect(headers).toContain(`connect-src ${CANONICAL}\n`);
  });

  it("reads the legacy PUBLIC_API_URL when PUBLIC_CIRE_API_URL is unset", async () => {
    expect(await build({ PUBLIC_API_URL: LEGACY })).toContain(`connect-src ${LEGACY}\n`);
  });

  it("names the local cire-api when neither is set", async () => {
    expect(await build({})).toContain("connect-src http://localhost:8787\n");
  });

  it("checks the client bundle, so an API only the server output names fails the build", async () => {
    const elsewhere = "https://server-only.example.test";
    await writeFile(join(root, "server", "entry.mjs"), `"${elsewhere}"`);
    await expect(build({ PUBLIC_CIRE_API_URL: elsewhere })).rejects.toThrow(/no client script/);
  });
});
