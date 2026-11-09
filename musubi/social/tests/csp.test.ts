import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build, type Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDirectives,
  contentSecurityPolicy,
  inlineScriptHashes,
  policyIssuerOrigin,
  TURNSTILE_ORIGIN,
  withBuildDirectives,
} from "../vite.config";

/**
 * The Content-Security-Policy the build writes into `_headers`
 * (`contentSecurityPolicy` in `vite.config.ts`). This origin serves
 * `/authorize`, the consent screen, so its `script-src` and `connect-src` are
 * what stand between an injected script and a stolen grant. Every way they
 * break is silent until a page is blocked or let through: a hash that stops
 * matching blocks the theme script, a missing issuer blocks sign-in, a stray
 * source admits a host. One test per way (NEW-FEAT.md C1–C7).
 */

const ROOT = resolve(import.meta.dirname, "..");
const ISSUER = "https://id.example.test";

/** The four directives `public/_headers` sets by hand. */
const COMMITTED = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** The `/*` rule's policy in a `_headers` file. */
function policyOf(headers: string): string {
  const match = /^\/\*\n(?:\s+.*\n)*?\s+Content-Security-Policy:\s*(.*)$/m.exec(headers);
  if (!match) throw new Error("no /* Content-Security-Policy");
  return match[1] ?? "";
}

let outDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(outDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  outDirs = [];
});

/** `vite build` of this app, as a deploy runs it, with `env`; the built `_headers`. */
async function buildWith(env: Record<string, string | undefined>): Promise<string> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const outDir = await mkdtemp(join(tmpdir(), "musubi-csp-"));
  outDirs.push(outDir);
  await build({
    root: ROOT,
    configFile: resolve(ROOT, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
  return readFile(join(outDir, "_headers"), "utf8");
}

describe("the built policy", () => {
  it("C7: the committed files build to the production policy, and nothing looser", async () => {
    const headers = await buildWith({
      VITE_OSN_ISSUER_URL: "https://id.musubi.social",
      VITE_TURNSTILE_SITEKEY: "0x4AAAAAAA-production-sitekey",
    });
    const hashes = inlineScriptHashes(await readFile(resolve(ROOT, "index.html"), "utf8"));

    // The theme script and the pages.dev redirect.
    expect(hashes).toHaveLength(2);
    expect(policyOf(headers)).toBe(
      `${COMMITTED}; script-src 'self' ${hashes.join(" ")} ${TURNSTILE_ORIGIN}; connect-src 'self' https://id.musubi.social`,
    );
    expect(headers).not.toMatch(/unsafe-inline|unsafe-eval|default-src/);
  });

  it("C1: names the issuer the build calls, and only that one", async () => {
    const policy = policyOf(await buildWith({ VITE_OSN_ISSUER_URL: `${ISSUER}/` }));

    expect(policy).toMatch(new RegExp(`; connect-src 'self' ${ISSUER}$`));
    expect(policy).not.toContain("id.musubi.social");
  });

  it("C1: names the local issuer the app falls back to when none is set", async () => {
    const policy = policyOf(await buildWith({ VITE_OSN_ISSUER_URL: undefined }));

    expect(policy).toMatch(/; connect-src 'self' http:\/\/localhost:4000$/);
  });

  it.each([
    ["unset", undefined],
    ["blank", "  "],
  ])("C3: leaves Turnstile out when the sitekey is %s", async (_name, sitekey) => {
    const policy = policyOf(
      await buildWith({ VITE_OSN_ISSUER_URL: ISSUER, VITE_TURNSTILE_SITEKEY: sitekey }),
    );

    expect(policy).not.toContain(TURNSTILE_ORIGIN);
    expect(policy).toMatch(/script-src 'self' 'sha256-[^']+' 'sha256-[^']+'; connect-src/);
  });
});

describe("the policy's parts", () => {
  it("C2: hashes each inline script's exact text, in page order, and no script with a src", () => {
    const first = "\n      var a = 1;\n    ";
    const second = "console.log('x')";
    const html = `<head><script>${first}</script><script type="module" crossorigin src="/assets/a.js"></script></head><body><SCRIPT data-x="1">${second}</SCRIPT></body>`;

    expect(inlineScriptHashes(html)).toEqual([sha256(first), sha256(second)]);
    expect(inlineScriptHashes("<p>no scripts</p>")).toEqual([]);
  });

  it("C3: adds Turnstile's host after the hashes only when asked", () => {
    expect(buildDirectives({ issuerOrigin: ISSUER, turnstile: true, inlineHashes: ["'h'"] })).toBe(
      `script-src 'self' 'h' ${TURNSTILE_ORIGIN}; connect-src 'self' ${ISSUER}`,
    );
    expect(buildDirectives({ issuerOrigin: ISSUER, turnstile: false, inlineHashes: [] })).toBe(
      `script-src 'self'; connect-src 'self' ${ISSUER}`,
    );
  });

  it.each([
    ["not a URL", "id.example.test"],
    ["not http(s)", "ftp://id.example.test"],
    ["a wildcard host", "https://*.example.test"],
    ["a host that starts a directive", "https://id.example.test;script-src"],
    ["a host with a quote", "https://id.example.test'"],
    ["plain http off this machine", "http://id.example.test"],
  ])("C4: refuses an issuer URL that is %s", (_name, url) => {
    expect(() => policyIssuerOrigin({ VITE_OSN_ISSUER_URL: url })).toThrow(/VITE_OSN_ISSUER_URL/);
  });

  it.each([
    ["https://id.musubi.social/some/path?x=1", "https://id.musubi.social"],
    ["http://localhost:4000", "http://localhost:4000"],
    ["http://id.musubi.localhost", "http://id.musubi.localhost"],
    ["http://127.0.0.1:4000", "http://127.0.0.1:4000"],
  ])("C4: takes %s as the origin %s", (url, origin) => {
    expect(policyIssuerOrigin({ VITE_OSN_ISSUER_URL: url })).toBe(origin);
  });

  it("C5: appends to the /* rule's policy and leaves every other rule alone", () => {
    const headers = [
      "/*",
      "  Content-Security-Policy: frame-ancestors 'none';",
      "  X-Frame-Options: DENY",
      "",
      "/other",
      "  Content-Security-Policy: sandbox",
      "",
    ].join("\n");

    expect(withBuildDirectives(headers, "script-src 'self'")).toBe(
      headers.replace("frame-ancestors 'none';", "frame-ancestors 'none'; script-src 'self'"),
    );
  });

  it.each([
    ["no /* rule", "/other\n  Content-Security-Policy: frame-ancestors 'none'\n"],
    [
      "no policy in the /* rule",
      "/*\n  X-Frame-Options: DENY\n\n/x\n  Content-Security-Policy: a\n",
    ],
    ["a script-src already", "/*\n  Content-Security-Policy: base-uri 'none'; script-src *\n"],
    ["a connect-src already", "/*\n  Content-Security-Policy: connect-src *; base-uri 'none'\n"],
  ])("C5: refuses a _headers with %s", (_name, headers) => {
    expect(() => withBuildDirectives(headers, "script-src 'self'")).toThrow(
      /content-security-policy/,
    );
  });
});

describe("the plugin's own checks", () => {
  /** Runs the plugin's two hooks over `bundle`, writing into a temporary dist; the `_headers` it leaves. */
  async function writeBundle(bundle: Record<string, unknown>): Promise<string> {
    const outDir = await mkdtemp(join(tmpdir(), "musubi-csp-hooks-"));
    outDirs.push(outDir);
    await writeFile(join(outDir, "_headers"), `/*\n  Content-Security-Policy: ${COMMITTED}\n`);
    const plugin: Plugin = contentSecurityPolicy();
    const hooks = plugin as unknown as {
      configResolved: (config: object) => void;
      writeBundle: (options: object, bundle: Record<string, unknown>) => Promise<void>;
    };
    hooks.configResolved({
      env: { VITE_OSN_ISSUER_URL: ISSUER },
      root: outDir,
      build: { outDir: "." },
    });
    await hooks.writeBundle({}, bundle);
    return readFile(join(outDir, "_headers"), "utf8");
  }

  const page = { type: "asset", fileName: "index.html", source: "<script>x</script>" };

  it("C6: refuses a bundle whose scripts do not call the issuer the policy names", async () => {
    await expect(
      writeBundle({
        "index.html": page,
        "assets/a.js": { type: "chunk", fileName: "assets/a.js", code: '"https://elsewhere.test"' },
      }),
    ).rejects.toThrow(/no script in the bundle calls https:\/\/id\.example\.test/);
  });

  it("C6: writes the policy when a script calls the issuer", async () => {
    const headers = await writeBundle({
      "index.html": page,
      "assets/a.js": { type: "chunk", fileName: "assets/a.js", code: `"${ISSUER}"` },
    });

    expect(policyOf(headers)).toBe(
      `${COMMITTED}; script-src 'self' ${sha256("x")}; connect-src 'self' ${ISSUER}`,
    );
  });

  it("C6: refuses a build with no index.html", async () => {
    await expect(
      writeBundle({ "assets/a.js": { type: "chunk", fileName: "assets/a.js", code: ISSUER } }),
    ).rejects.toThrow(/no index\.html/);
  });
});
