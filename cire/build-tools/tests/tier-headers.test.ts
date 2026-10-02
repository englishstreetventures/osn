import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroConfig, HookParameters } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BuildEnv,
  bundleNamesOrigin,
  PRODUCTION_API_ORIGIN,
  retargetHeaders,
  tierHeaders,
  type TierHeadersOptions,
} from "../src/tier-headers";

const HEADERS = [
  "/*",
  `  Reporting-Endpoints: csp-endpoint="${PRODUCTION_API_ORIGIN}/api/csp-report"`,
  `  Content-Security-Policy-Report-Only: default-src 'self'; img-src 'self' data: ${PRODUCTION_API_ORIGIN}; connect-src 'self' ${PRODUCTION_API_ORIGIN}; report-uri ${PRODUCTION_API_ORIGIN}/api/csp-report; report-to csp-endpoint`,
  "",
].join("\n");

const DEV_API = "https://api.dev.cireweddings.com";

describe("retargetHeaders", () => {
  it("leaves the production policy byte-for-byte alone on a production build", () => {
    expect(retargetHeaders(HEADERS, "https://api.cireweddings.com")).toBe(HEADERS);
  });

  it("points every source and the report collector at the tier's own API", () => {
    const dev = retargetHeaders(HEADERS, DEV_API);
    expect(dev).not.toContain(PRODUCTION_API_ORIGIN);
    expect(dev).toContain(`img-src 'self' data: ${DEV_API};`);
    expect(dev).toContain(`connect-src 'self' ${DEV_API};`);
    expect(dev).toContain(`report-uri ${DEV_API}/api/csp-report;`);
    expect(dev).toContain(`csp-endpoint="${DEV_API}/api/csp-report"`);
  });

  it("uses the origin only, whatever path or trailing slash the URL carries", () => {
    const local = retargetHeaders(HEADERS, "http://localhost:8787/");
    expect(local).toContain("connect-src 'self' http://localhost:8787;");
    expect(local).toContain("report-uri http://localhost:8787/api/csp-report;");
    expect(retargetHeaders(HEADERS, "https://api.cire.localhost/some/path")).toContain(
      "connect-src 'self' https://api.cire.localhost;",
    );
  });

  it("does not touch a host that merely starts with the production origin", () => {
    const lookalikes = `${HEADERS}# ${PRODUCTION_API_ORIGIN}.example ${PRODUCTION_API_ORIGIN}:8443 https://api.cireweddings.community\n`;
    const dev = retargetHeaders(lookalikes, DEV_API);
    expect(dev).toContain(`${PRODUCTION_API_ORIGIN}.example`);
    expect(dev).toContain(`${PRODUCTION_API_ORIGIN}:8443`);
    expect(dev).toContain("https://api.cireweddings.community");
  });

  it("refuses a file that does not name the production origin", () => {
    // Otherwise a policy rewritten by hand to some other origin would ship to
    // every tier unchanged, and the dev tier would block its own API.
    expect(() => retargetHeaders("/*\n  X-Frame-Options: DENY\n", "https://api.dev.x")).toThrow(
      /does not name/,
    );
  });

  it("refuses a host that would be more than one plain source in the policy", () => {
    // WHATWG URL parsing lets `*`, `;`, `,` and quotes through in a host. Written
    // into `connect-src`, `https://*` would allow every https host, and `;` would
    // start a directive of its own.
    for (const bad of ["https://*", "https://a;b", "https://a,b", "https://a'b", 'https://a"b']) {
      expect(() => retargetHeaders(HEADERS, bad)).toThrow(/cire-api URL/);
    }
  });

  it("accepts a plain host, a port, and an internationalised name as punycode", () => {
    expect(retargetHeaders(HEADERS, "https://API.Example.test:8443/x")).toContain(
      "connect-src 'self' https://api.example.test:8443;",
    );
    expect(retargetHeaders(HEADERS, "https://bücher.example")).toContain(
      "connect-src 'self' https://xn--bcher-kva.example;",
    );
  });

  it("refuses an API URL it cannot turn into an origin", () => {
    for (const bad of ["", "not a url", "data:text/plain,hi", "ftp://api.example.test"]) {
      expect(() => retargetHeaders(HEADERS, bad)).toThrow(/cire-api URL/);
    }
  });

  it("refuses plain http for any host that is not loopback", () => {
    // A deployed tier's policy would let the API and its report collector be
    // reached in cleartext, and violation reports carry the page URL.
    for (const bad of [
      "http://api.dev.cireweddings.com",
      "http://api.cireweddings.com",
      "http://localhost.example.test",
      "http://10.0.0.1:8787",
    ]) {
      expect(() => retargetHeaders(HEADERS, bad)).toThrow(/is http but not loopback/);
    }
  });

  it("accepts plain http on a loopback host, where the local cire-api runs", () => {
    for (const local of [
      "http://localhost:8787",
      "http://api.cire.localhost",
      "http://127.0.0.1:8787",
    ]) {
      expect(retargetHeaders(HEADERS, local)).toContain(`connect-src 'self' ${local};`);
    }
  });
});

/** The one part of a Vite plugin the integration adds: its resolved-config hook. */
interface EnvProbe {
  configResolved?: ((config: { env: Record<string, unknown> }) => unknown) | undefined;
}

/** One env name, else the local API: the shape of every app's `resolveApiUrl`. */
const fromEnv = (env: BuildEnv) => env.PUBLIC_API_URL ?? "http://localhost:8787";
const CLIENT: TierHeadersOptions = { apiUrl: fromEnv, bundle: "client" };
const SERVER: TierHeadersOptions = { apiUrl: fromEnv, bundle: "server" };

describe("tierHeaders", () => {
  // A server build's layout: `_headers` and the client chunks in `client/`,
  // the server chunks in `server/`. A static build has only the first half,
  // which the integration finds the same way, as the `dir` Astro reports.
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "cire-tier-headers-"));
    await mkdir(join(dist, "client", "_astro"), { recursive: true });
    await mkdir(join(dist, "server", "chunks"), { recursive: true });
    await writeFile(join(dist, "client", "_headers"), HEADERS);
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  const builtHeaders = () => readFile(join(dist, "client", "_headers"), "utf8");

  /**
   * Runs the integration the way `astro build` does: `env` is Vite's resolved
   * env, or `null` when Vite never resolves its config; `astroConfig: false`
   * skips the hook that hands over Astro's final config.
   */
  async function build(
    options: TierHeadersOptions,
    env: Record<string, unknown> | null,
    { astroConfig = true } = {},
  ) {
    const integration = tierHeaders(options);
    const plugins: EnvProbe[] = [];
    await integration.hooks["astro:config:setup"]!({
      command: "build",
      updateConfig: (config: { vite?: { plugins?: EnvProbe[] } }) => {
        plugins.push(...(config.vite?.plugins ?? []));
        return config;
      },
    } as unknown as HookParameters<"astro:config:setup">);
    if (astroConfig) {
      await integration.hooks["astro:config:done"]!({
        config: { build: { server: pathToFileURL(`${dist}/server/`) } } as unknown as AstroConfig,
      } as unknown as HookParameters<"astro:config:done">);
    }
    if (env !== null) {
      for (const plugin of plugins) await plugin.configResolved?.({ env });
    }
    const info = vi.fn();
    await integration.hooks["astro:build:done"]!({
      dir: pathToFileURL(`${dist}/client/`),
      logger: { info },
    } as unknown as HookParameters<"astro:build:done">);
    return { info, headers: await builtHeaders() };
  }

  it("rewrites _headers to the API the client bundle was built against", async () => {
    await writeFile(join(dist, "client", "_astro", "osn.abc123.js"), `const a="${DEV_API}";`);
    const { headers, info } = await build(CLIENT, { PUBLIC_API_URL: DEV_API });
    expect(headers).toContain(`connect-src 'self' ${DEV_API};`);
    expect(headers).not.toContain(PRODUCTION_API_ORIGIN);
    expect(info).toHaveBeenCalledWith(`CSP in _headers points at ${DEV_API}`);
  });

  it("rewrites _headers to the API the server bundle calls", async () => {
    await writeFile(join(dist, "server", "chunks", "invite_x.mjs"), `const API_URL="${DEV_API}";`);
    const { headers } = await build(SERVER, { PUBLIC_API_URL: DEV_API });
    expect(headers).toContain(`connect-src 'self' ${DEV_API};`);
    expect(headers).not.toContain(PRODUCTION_API_ORIGIN);
  });

  it("hands the app's chain Vite's string values only", async () => {
    // Vite's env also carries the booleans `DEV`, `PROD` and `SSR`.
    await writeFile(join(dist, "client", "_astro", "osn.js"), `"${DEV_API}"`);
    const apiUrl = vi.fn(fromEnv);
    await build({ apiUrl, bundle: "client" }, { PUBLIC_API_URL: DEV_API, MODE: "dev", DEV: true });
    expect(apiUrl).toHaveBeenCalledWith({ PUBLIC_API_URL: DEV_API, MODE: "dev" });
  });

  it("names whatever the app's chain falls back to when the env is unset", async () => {
    await writeFile(join(dist, "client", "_astro", "osn.js"), 'fetch("http://localhost:8787/api")');
    const { headers } = await build(CLIENT, {});
    expect(headers).toContain("connect-src 'self' http://localhost:8787;");
  });

  it("fails the build on an empty API URL and leaves the file alone", async () => {
    await expect(build(CLIENT, { PUBLIC_API_URL: "" })).rejects.toThrow(/cire-api URL/);
    expect(await builtHeaders()).toBe(HEADERS);
  });

  it("logs under the name every cire app's build shares", () => {
    expect(tierHeaders(CLIENT).name).toBe("cire-tier-headers");
  });

  it("fails the build when the output holds no _headers to rewrite", async () => {
    // A tier must never deploy with no policy at all.
    await rm(join(dist, "client", "_headers"));
    await writeFile(join(dist, "client", "_astro", "osn.js"), `"${DEV_API}"`);
    await expect(build(CLIENT, { PUBLIC_API_URL: DEV_API })).rejects.toThrow(/ENOENT/);
  });

  it("adds the env probe only to a build", async () => {
    const plugins: unknown[] = [];
    await tierHeaders(CLIENT).hooks["astro:config:setup"]!({
      command: "dev",
      updateConfig: (config: { vite?: { plugins?: unknown[] } }) => {
        plugins.push(...(config.vite?.plugins ?? []));
        return config;
      },
    } as unknown as HookParameters<"astro:config:setup">);
    expect(plugins).toEqual([]);
  });

  it("fails the build when Vite never handed over its env", async () => {
    await expect(build(CLIENT, null)).rejects.toThrow(/never received Vite's env/);
    // Nothing half-written: the copied production file is still there as-is.
    expect(await builtHeaders()).toBe(HEADERS);
  });

  it("fails a server-bundle build when Astro's config never arrived", async () => {
    await writeFile(join(dist, "server", "chunks", "invite.mjs"), `"${DEV_API}"`);
    await expect(
      build(SERVER, { PUBLIC_API_URL: DEV_API }, { astroConfig: false }),
    ).rejects.toThrow(/never received Astro's config/);
    expect(await builtHeaders()).toBe(HEADERS);
  });

  it("fails the build when only the server bundle names the API a client build calls", async () => {
    // The header would name the dev API, but the client bundle was built
    // against production: the one mismatch this whole step exists to prevent.
    await writeFile(join(dist, "client", "_astro", "osn.js"), `"${PRODUCTION_API_ORIGIN}"`);
    await writeFile(join(dist, "server", "chunks", "x.mjs"), `"${DEV_API}"`);
    await expect(build(CLIENT, { PUBLIC_API_URL: DEV_API })).rejects.toThrow(/no client script/);
    expect(await builtHeaders()).toBe(HEADERS);
  });

  it("fails the build when only the client bundle names the API a server build calls", async () => {
    // A server-rendered site reads the API URL on the server and hands it to
    // islands as a prop, so a client chunk is no evidence of what it calls.
    await writeFile(join(dist, "client", "_astro", "a.js"), `"${DEV_API}"`);
    await writeFile(join(dist, "server", "chunks", "invite.mjs"), `"${PRODUCTION_API_ORIGIN}"`);
    await expect(build(SERVER, { PUBLIC_API_URL: DEV_API })).rejects.toThrow(/no server script/);
    expect(await builtHeaders()).toBe(HEADERS);
  });
});

describe("bundleNamesOrigin", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cire-tier-bundle-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const namesDevApi = () => bundleNamesOrigin(pathToFileURL(`${dir}/`), DEV_API);

  it("finds the origin in a nested client chunk", async () => {
    await mkdir(join(dir, "_astro", "chunks"), { recursive: true });
    await writeFile(join(dir, "_astro", "chunks", "x.js"), `"${DEV_API}"`);
    expect(await namesDevApi()).toBe(true);
  });

  it("reads a server bundle's .mjs chunks", async () => {
    await mkdir(join(dir, "chunks"));
    await writeFile(join(dir, "chunks", "x.mjs"), `"${DEV_API}"`);
    expect(await namesDevApi()).toBe(true);
  });

  it("ignores anything that is not a script", async () => {
    await writeFile(join(dir, "index.html"), DEV_API);
    await writeFile(join(dir, "_headers"), DEV_API);
    await writeFile(join(dir, "wrangler.json"), DEV_API);
    expect(await namesDevApi()).toBe(false);
  });
});
