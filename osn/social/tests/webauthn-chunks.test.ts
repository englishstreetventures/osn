import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import viteConfig, { barrelIsSideEffectFree } from "../vite.config";

/**
 * P-I3 (osn-tracker#447). The security-events banner mounts on every Settings
 * visit; the passkey enrolment ceremony only ever runs from the Security tab.
 * Keeping the two apart is worth about 4 kB of JS to every visitor who never
 * opens that tab.
 *
 * The source split alone does not survive bundling — `@simplewebauthn/browser`
 * exports both ceremonies through one barrel — so the split is held by
 * `vite.config.ts`. Every way it can break is silent: a dependency upgrade that
 * moves the method files, a plugin-order change, or someone tidying the config
 * all leave a working build with the enrolment code back in the banner's chunk.
 * Nothing in the app looks wrong; the bytes are just paid again. So the split
 * is pinned here.
 */

const AUTHENTICATION_METHOD = "@simplewebauthn/browser/esm/methods/startAuthentication.js";
const REGISTRATION_METHOD = "@simplewebauthn/browser/esm/methods/startRegistration.js";
/** The one module `webauthnBarrelHasNoSideEffects` flags in `vite.config.ts`. */
const BARREL = "@simplewebauthn/browser/esm/index.js";

/** Rollup hands `manualChunks` a module graph; this config never reads it. */
const emptyGraph = {
  getModuleInfo: () => null,
  getModuleIds: () => ([] as string[]).values(),
};

async function manualChunks() {
  const config = await viteConfig({ command: "build", mode: "production" });
  const output = config.build?.rollupOptions?.output;
  if (output === undefined || Array.isArray(output)) {
    throw new Error("expected build.rollupOptions.output to be a single output config");
  }
  const chunker = output.manualChunks;
  if (typeof chunker !== "function") {
    throw new Error("expected build.rollupOptions.output.manualChunks to be a function");
  }
  return (id: string) => chunker(id, emptyGraph);
}

/** Root of the installed `@simplewebauthn/browser`, whatever hoists it. */
function packageRoot(): string {
  const require = createRequire(import.meta.url);
  // The package's `exports` map only publishes `"."`, so resolve that and walk
  // up out of the entry file's directory.
  return resolve(dirname(require.resolve("@simplewebauthn/browser")), "..");
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** The names a wrapper module pulls out of `@simplewebauthn/browser`. */
function ceremonyImports(relativePath: string): string {
  const match = /import\s*\{([^}]*)\}\s*from\s*"@simplewebauthn\/browser"/.exec(
    readSource(relativePath),
  );
  if (match === null)
    throw new Error(`${relativePath} imports nothing from @simplewebauthn/browser`);
  return match[1] ?? "";
}

describe("webauthn chunk split", () => {
  it("puts each ceremony's method file in its own named chunk", async () => {
    const chunkFor = await manualChunks();
    expect(chunkFor(`/repo/node_modules/${AUTHENTICATION_METHOD}`)).toBe("webauthn-authentication");
    expect(chunkFor(`/repo/node_modules/${REGISTRATION_METHOD}`)).toBe("webauthn-registration");
  });

  it("leaves every other module to Rollup's own chunking", async () => {
    const chunkFor = await manualChunks();
    // Returning a name here would pull unrelated code into a webauthn chunk;
    // returning `undefined` is what keeps the override surgical.
    expect(chunkFor("/repo/node_modules/solid-js/dist/solid.js")).toBeUndefined();
    expect(chunkFor("/repo/osn/social/src/App.tsx")).toBeUndefined();
    expect(chunkFor(`/repo/node_modules/${BARREL}`)).toBeUndefined();
  });

  it("matches file paths the installed package actually ships", () => {
    // Both halves of the fix match on these three paths. A major upgrade that
    // renames or bundles them makes the config silently inert, so fail here
    // rather than in a bundle nobody measures.
    const root = packageRoot();
    for (const shipped of [BARREL, AUTHENTICATION_METHOD, REGISTRATION_METHOD]) {
      const path = join(root, shipped.replace("@simplewebauthn/browser/", ""));
      expect(existsSync(path), `${shipped} is no longer shipped at that path`).toBe(true);
    }
  });

  it("keeps the always-mounted banner off the registration module", () => {
    // The chunk boundary only helps if the source import graph respects it.
    const banner = readSource("../src/components/SecurityEventsBannerMount.tsx");
    expect(banner).toContain("../lib/webauthn-ceremony");
    expect(banner).not.toContain("webauthn-registration");
    // The Security tab is the one surface allowed to reach enrolment.
    const security = readSource("../src/components/SecuritySection.tsx");
    expect(security).toContain("../lib/webauthn-registration");
  });

  it("keeps the two ceremony wrappers in separate modules", () => {
    // Re-merging them would put `startRegistration` back in the banner's chunk
    // whatever the bundler config says. Match the import list, not the whole
    // file — both modules name the other ceremony in their comments.
    expect(ceremonyImports("../src/lib/webauthn-ceremony.ts")).toContain("startAuthentication");
    expect(ceremonyImports("../src/lib/webauthn-ceremony.ts")).not.toContain("startRegistration");
    expect(ceremonyImports("../src/lib/webauthn-registration.ts")).toContain("startRegistration");
    expect(ceremonyImports("../src/lib/webauthn-registration.ts")).not.toContain(
      "startAuthentication",
    );
  });
});

describe("barrelIsSideEffectFree", () => {
  it("accepts the barrel the installed package actually ships", () => {
    // If a release ever puts a statement in the barrel, this fails here rather
    // than quietly losing the chunk split in a bundle nobody diffs.
    const barrel = readFileSync(join(packageRoot(), "esm/index.js"), "utf8");
    expect(barrelIsSideEffectFree(barrel)).toBe(true);
  });

  it("rejects a barrel that runs anything", () => {
    // The failure this guards against: an executable statement smuggled in by a
    // minor bump, which Rollup would drop without a word.
    expect(barrelIsSideEffectFree("export * from './a.js';\nnavigator.credentials;")).toBe(false);
    expect(barrelIsSideEffectFree("import './polyfill.js';\nexport * from './a.js';")).toBe(false);
    expect(barrelIsSideEffectFree("export const VERSION = 1;")).toBe(false);
    // An empty read is not proof of purity.
    expect(barrelIsSideEffectFree("")).toBe(false);
  });

  it("ignores blank lines and line comments", () => {
    expect(barrelIsSideEffectFree("// re-exports\n\nexport * from './a.js';\n")).toBe(true);
  });
});
