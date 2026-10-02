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

const DEV_API = "https://api.dev.cireweddings.com";

// The rewrite itself is tested in `@cire/build-tools`. This checks what the
// guest site hands it: the env chain `lib/invite.ts` reads, and the bundle to
// check.
describe("the guest site's tier-headers wiring", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "invites-tier-headers-"));
    await mkdir(join(dist, "client", "_astro"), { recursive: true });
    await mkdir(join(dist, "server", "chunks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  /** Runs the guest site's integration as `astro build` does; returns the `_headers` it leaves. */
  async function build(env: Record<string, string>): Promise<string> {
    const file = join(dist, "client", "_headers");
    await writeFile(file, `/*\n  CSP: connect-src ${PRODUCTION_API_ORIGIN}\n`);
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
      config: { build: { server: pathToFileURL(`${dist}/server/`) } } as unknown as AstroConfig,
    } as unknown as HookParameters<"astro:config:done">);
    for (const plugin of plugins) await plugin.configResolved?.({ env });
    await integration.hooks["astro:build:done"]!({
      dir: pathToFileURL(`${dist}/client/`),
      logger: { info: () => {} },
    } as unknown as HookParameters<"astro:build:done">);
    return readFile(file, "utf8");
  }

  it("reads PUBLIC_API_URL from the server bundle's own build", async () => {
    await writeFile(join(dist, "server", "chunks", "invite_x.mjs"), `const API_URL="${DEV_API}";`);
    expect(await build({ PUBLIC_API_URL: DEV_API })).toContain(`connect-src ${DEV_API}\n`);
  });

  it("names the local cire-api when PUBLIC_API_URL is unset", async () => {
    await writeFile(join(dist, "server", "chunks", "invite.mjs"), '"http://localhost:8787"');
    expect(await build({})).toContain("connect-src http://localhost:8787\n");
  });

  it("ignores PUBLIC_CIRE_API_URL, which the guest site never reads", async () => {
    await writeFile(join(dist, "server", "chunks", "invite.mjs"), `"${DEV_API}"`);
    const headers = await build({
      PUBLIC_API_URL: DEV_API,
      PUBLIC_CIRE_API_URL: "https://other.example.test",
    });
    expect(headers).toContain(`connect-src ${DEV_API}\n`);
  });

  it("checks the server bundle, so an API only a client chunk names fails the build", async () => {
    // The pages read the API URL on the server and hand it to the islands as a
    // prop, so a client chunk is no evidence of what the site calls.
    await writeFile(join(dist, "client", "_astro", "a.js"), `"${DEV_API}"`);
    await expect(build({ PUBLIC_API_URL: DEV_API })).rejects.toThrow(/no server script/);
  });
});

describe("astro.config.mjs", () => {
  it("runs the rewrite on every build", async () => {
    const config = await readFile(join(import.meta.dirname, "../../astro.config.mjs"), "utf8");
    expect(config).toMatch(/^import tierHeaders from "\.\/src\/lib\/tier-headers\.ts";$/m);
    expect(config).toMatch(/^\s*integrations: \[[^\]]*\btierHeaders\(\)[^\]]*\],$/m);
  });
});
