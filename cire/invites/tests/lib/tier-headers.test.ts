import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroConfig, HookParameters } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_API_URL, resolveApiUrl } from "../../src/lib/api-origin";
import tierHeaders, {
  bundleNamesOrigin,
  PRODUCTION_API_ORIGIN,
  retargetHeaders,
} from "../../src/lib/tier-headers";

/** The one part of a Vite plugin the integration adds: its resolved-config hook. */
interface EnvProbe {
  configResolved?: ((config: { env: Record<string, string> }) => unknown) | undefined;
}

const HEADERS = [
  "/*",
  `  Reporting-Endpoints: csp-endpoint="${PRODUCTION_API_ORIGIN}/api/csp-report"`,
  `  Content-Security-Policy-Report-Only: default-src 'self'; img-src 'self' data: ${PRODUCTION_API_ORIGIN}; connect-src 'self' ${PRODUCTION_API_ORIGIN}; report-uri ${PRODUCTION_API_ORIGIN}/api/csp-report; report-to csp-endpoint`,
  "",
].join("\n");

describe("resolveApiUrl", () => {
  it("takes PUBLIC_API_URL, else the local API", () => {
    expect(resolveApiUrl("https://api.dev.cireweddings.com")).toBe(
      "https://api.dev.cireweddings.com",
    );
    expect(resolveApiUrl(undefined)).toBe(LOCAL_API_URL);
  });

  it("keeps an empty value empty, so the header rewrite fails the build on it", () => {
    expect(resolveApiUrl("")).toBe("");
  });
});

describe("retargetHeaders", () => {
  it("leaves the production policy byte-for-byte alone on a production build", () => {
    expect(retargetHeaders(HEADERS, "https://api.cireweddings.com")).toBe(HEADERS);
  });

  it("points every source and the report collector at the tier's own API", () => {
    const dev = retargetHeaders(HEADERS, "https://api.dev.cireweddings.com");
    expect(dev).not.toContain(PRODUCTION_API_ORIGIN);
    expect(dev).toContain("connect-src 'self' https://api.dev.cireweddings.com;");
    expect(dev).toContain("report-uri https://api.dev.cireweddings.com/api/csp-report;");
    expect(dev).toContain('csp-endpoint="https://api.dev.cireweddings.com/api/csp-report"');
  });

  it("refuses a file that does not name the production origin", () => {
    expect(() => retargetHeaders("/*\n  X-Frame-Options: DENY\n", "https://api.dev.x")).toThrow(
      /does not name/,
    );
  });

  it("refuses an API URL that is not one plain http(s) origin", () => {
    for (const bad of ["", "not a url", "ftp://api.example.test", "https://*", "https://a;b"]) {
      expect(() => retargetHeaders(HEADERS, bad)).toThrow(/cire-api URL/);
    }
  });
});

describe("the build hooks", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "invites-tier-headers-"));
    await mkdir(join(dist, "client", "_astro"), { recursive: true });
    await mkdir(join(dist, "server", "chunks"), { recursive: true });
    await writeFile(join(dist, "client", "_headers"), HEADERS);
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  const clientHeaders = () => readFile(join(dist, "client", "_headers"), "utf8");

  /** Runs the integration the way `astro build` does, with `env` as Vite's resolved env. */
  async function build(env: Record<string, string> | null) {
    const integration = tierHeaders();
    const plugins: EnvProbe[] = [];
    await integration.hooks["astro:config:setup"]!({
      command: "build",
      updateConfig: (config: { vite?: { plugins?: EnvProbe[] } }) => {
        plugins.push(...(config.vite?.plugins ?? []));
        return config;
      },
    } as unknown as HookParameters<"astro:config:setup">);
    await integration.hooks["astro:config:done"]!({
      config: { build: { server: pathToFileURL(`${dist}/server/`) } } as unknown as AstroConfig,
    } as unknown as HookParameters<"astro:config:done">);
    if (env !== null) {
      for (const plugin of plugins) await plugin.configResolved?.({ env });
    }
    const info = vi.fn();
    await integration.hooks["astro:build:done"]!({
      dir: pathToFileURL(`${dist}/client/`),
      logger: { info },
    } as unknown as HookParameters<"astro:build:done">);
    return { info, headers: await clientHeaders() };
  }

  it("rewrites dist/client/_headers to the API the server bundle calls", async () => {
    await writeFile(
      join(dist, "server", "chunks", "invite_x.mjs"),
      'const API_URL="https://api.dev.cireweddings.com";',
    );
    const { headers, info } = await build({ PUBLIC_API_URL: "https://api.dev.cireweddings.com" });
    expect(headers).toContain("connect-src 'self' https://api.dev.cireweddings.com;");
    expect(headers).not.toContain(PRODUCTION_API_ORIGIN);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("https://api.dev.cireweddings.com"));
  });

  it("names the local API when the env is unset, as the bundle does", async () => {
    await writeFile(join(dist, "server", "chunks", "invite.mjs"), '"http://localhost:8787"');
    const { headers } = await build({});
    expect(headers).toContain("connect-src 'self' http://localhost:8787;");
  });

  it("fails the build on an empty API URL and leaves the file alone", async () => {
    await expect(build({ PUBLIC_API_URL: "" })).rejects.toThrow(/cire-api URL/);
    expect(await clientHeaders()).toBe(HEADERS);
  });

  it("fails the build when Vite never handed over its env", async () => {
    await expect(build(null)).rejects.toThrow(/never received/);
    expect(await clientHeaders()).toBe(HEADERS);
  });

  it("fails the build when the header would name an API the server bundle does not call", async () => {
    // Only the client names it: the pages read the API URL on the server, so a
    // client chunk is no evidence of what the site calls.
    await writeFile(join(dist, "client", "_astro", "a.js"), '"https://api.dev.cireweddings.com"');
    await writeFile(join(dist, "server", "chunks", "invite.mjs"), '"https://api.cireweddings.com"');
    await expect(build({ PUBLIC_API_URL: "https://api.dev.cireweddings.com" })).rejects.toThrow(
      /no server script/,
    );
    expect(await clientHeaders()).toBe(HEADERS);
  });

  it("adds the env probe only to a build", async () => {
    const plugins: unknown[] = [];
    await tierHeaders().hooks["astro:config:setup"]!({
      command: "dev",
      updateConfig: (config: { vite?: { plugins?: unknown[] } }) => {
        plugins.push(...(config.vite?.plugins ?? []));
        return config;
      },
    } as unknown as HookParameters<"astro:config:setup">);
    expect(plugins).toEqual([]);
  });
});

describe("bundleNamesOrigin", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "invites-tier-bundle-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the server bundle's .mjs chunks", async () => {
    await mkdir(join(dir, "chunks"));
    await writeFile(join(dir, "chunks", "x.mjs"), '"https://api.dev.cireweddings.com"');
    expect(
      await bundleNamesOrigin(pathToFileURL(`${dir}/`), "https://api.dev.cireweddings.com"),
    ).toBe(true);
  });

  it("ignores anything that is not a script", async () => {
    await writeFile(join(dir, "wrangler.json"), "https://api.dev.cireweddings.com");
    expect(
      await bundleNamesOrigin(pathToFileURL(`${dir}/`), "https://api.dev.cireweddings.com"),
    ).toBe(false);
  });
});

describe("astro.config.mjs", () => {
  it("runs the rewrite on every build", async () => {
    const config = await readFile(join(import.meta.dirname, "../../astro.config.mjs"), "utf8");
    expect(config).toMatch(/^import tierHeaders from "\.\/src\/lib\/tier-headers\.ts";$/m);
    expect(config).toMatch(/^\s*integrations: \[[^\]]*\btierHeaders\(\)[^\]]*\],$/m);
  });
});
