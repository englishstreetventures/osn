import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { HookParameters } from "astro";
import type { Plugin, ResolvedConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import tierHeaders, {
  bundleNamesOrigin,
  PRODUCTION_API_ORIGIN,
  retargetHeaders,
} from "../../src/lib/tier-headers";

const HEADERS = [
  "/*",
  `  Reporting-Endpoints: csp-endpoint="${PRODUCTION_API_ORIGIN}/api/csp-report"`,
  `  Content-Security-Policy-Report-Only: default-src 'self'; img-src 'self' data: ${PRODUCTION_API_ORIGIN}; connect-src 'self' ${PRODUCTION_API_ORIGIN}; report-uri ${PRODUCTION_API_ORIGIN}/api/csp-report; report-to csp-endpoint`,
  "",
].join("\n");

describe("retargetHeaders", () => {
  it("leaves the production policy byte-for-byte alone on a production build", () => {
    expect(retargetHeaders(HEADERS, "https://api.cireweddings.com")).toBe(HEADERS);
  });

  it("points every source and the report collector at the tier's own API", () => {
    const dev = retargetHeaders(HEADERS, "https://api.dev.cireweddings.com");
    expect(dev).not.toContain(PRODUCTION_API_ORIGIN);
    expect(dev).toContain("img-src 'self' data: https://api.dev.cireweddings.com;");
    expect(dev).toContain("connect-src 'self' https://api.dev.cireweddings.com;");
    expect(dev).toContain("report-uri https://api.dev.cireweddings.com/api/csp-report;");
    expect(dev).toContain('csp-endpoint="https://api.dev.cireweddings.com/api/csp-report"');
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
    const dev = retargetHeaders(lookalikes, "https://api.dev.cireweddings.com");
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
});

describe("the build hooks", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "tier-headers-"));
    await mkdir(join(dist, "_astro"));
    await writeFile(join(dist, "_headers"), HEADERS);
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  /** Runs the integration the way `astro build` does, with `env` as Vite's resolved env. */
  async function build(env: Record<string, string> | null) {
    const integration = tierHeaders();
    const plugins: Plugin[] = [];
    const setup = integration.hooks["astro:config:setup"]!;
    await setup({
      command: "build",
      updateConfig: (config: { vite?: { plugins?: Plugin[] } }) => {
        plugins.push(...(config.vite?.plugins ?? []));
        return config;
      },
    } as unknown as HookParameters<"astro:config:setup">);
    if (env !== null) {
      for (const plugin of plugins) {
        const hook = plugin.configResolved;
        const fn = typeof hook === "function" ? hook : hook?.handler;
        await fn?.call({} as never, { env } as unknown as ResolvedConfig);
      }
    }
    const info = vi.fn();
    const done = integration.hooks["astro:build:done"]!;
    await done({
      dir: pathToFileURL(`${dist}/`),
      logger: { info },
    } as unknown as HookParameters<"astro:build:done">);
    return { info, headers: await readFile(join(dist, "_headers"), "utf8") };
  }

  it("rewrites dist/_headers to the API the bundle was built against", async () => {
    await writeFile(
      join(dist, "_astro", "osn.abc123.js"),
      'const a="https://api.dev.cireweddings.com";',
    );
    const { headers, info } = await build({
      PUBLIC_CIRE_API_URL: "https://api.dev.cireweddings.com",
    });
    expect(headers).toContain("connect-src 'self' https://api.dev.cireweddings.com;");
    expect(headers).not.toContain(PRODUCTION_API_ORIGIN);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("https://api.dev.cireweddings.com"));
  });

  it("follows the same fallback chain as the bundle", async () => {
    await writeFile(join(dist, "_astro", "osn.js"), 'fetch("http://localhost:8787/api")');
    const { headers } = await build({});
    expect(headers).toContain("connect-src 'self' http://localhost:8787;");
  });

  it("reads the legacy name when the canonical one is unset", async () => {
    await writeFile(join(dist, "_astro", "osn.js"), '"https://legacy.example.test"');
    const { headers } = await build({ PUBLIC_API_URL: "https://legacy.example.test" });
    expect(headers).toContain("connect-src 'self' https://legacy.example.test;");
  });

  it("prefers the canonical name over the legacy one", async () => {
    await writeFile(join(dist, "_astro", "osn.js"), '"https://api.dev.cireweddings.com"');
    const { headers } = await build({
      PUBLIC_CIRE_API_URL: "https://api.dev.cireweddings.com",
      PUBLIC_API_URL: "https://legacy.example.test",
    });
    expect(headers).toContain("connect-src 'self' https://api.dev.cireweddings.com;");
    expect(headers).not.toContain("legacy.example.test");
  });

  it("fails the build on an empty API URL and leaves the file alone", async () => {
    await expect(build({ PUBLIC_CIRE_API_URL: "" })).rejects.toThrow(/cire-api URL/);
    expect(await readFile(join(dist, "_headers"), "utf8")).toBe(HEADERS);
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

  it("fails the build when Vite never handed over its env", async () => {
    await expect(build(null)).rejects.toThrow(/never received/);
    // Nothing half-written: the copied production file is still there as-is.
    expect(await readFile(join(dist, "_headers"), "utf8")).toBe(HEADERS);
  });

  it("fails the build when the header would name an API the bundle does not call", async () => {
    // The bundle was built against dev, but the env the hook saw says
    // production — the one mismatch this whole step exists to prevent.
    await writeFile(join(dist, "_astro", "osn.js"), 'const a="https://api.dev.cireweddings.com";');
    await expect(build({ PUBLIC_CIRE_API_URL: PRODUCTION_API_ORIGIN })).rejects.toThrow(
      /no client script/,
    );
    expect(await readFile(join(dist, "_headers"), "utf8")).toBe(HEADERS);
  });
});

describe("bundleNamesOrigin", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "tier-bundle-"));
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it("finds the origin in a nested client chunk", async () => {
    await mkdir(join(dist, "_astro", "chunks"), { recursive: true });
    await writeFile(join(dist, "_astro", "chunks", "x.js"), '"https://api.dev.cireweddings.com"');
    expect(
      await bundleNamesOrigin(pathToFileURL(`${dist}/`), "https://api.dev.cireweddings.com"),
    ).toBe(true);
  });

  it("ignores anything that is not a script", async () => {
    await writeFile(join(dist, "index.html"), "https://api.dev.cireweddings.com");
    await writeFile(join(dist, "_headers"), "https://api.dev.cireweddings.com");
    expect(
      await bundleNamesOrigin(pathToFileURL(`${dist}/`), "https://api.dev.cireweddings.com"),
    ).toBe(false);
  });
});
