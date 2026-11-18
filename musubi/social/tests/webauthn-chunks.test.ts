import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import viteConfig, { barrelIsSideEffectFree } from "../vite.config";

/**
 * `startRegistration` must stay reachable only from the Security-tab-only
 * chunk, never from code shared with the security-events banner. That banner
 * mounts in the application shell, so it is fetched on every route a signed-in
 * user opens, while the passkey enrolment ceremony only ever runs from the
 * Security tab. Keeping the two apart is worth about 4 kB of JS to every
 * visitor who never opens that tab — a wider audience than when the banner sat
 * on the Settings page alone, so the split is worth more now, not less.
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

const SRC = new URL("../src/", import.meta.url).pathname;

/** A static import or re-export, `import type` aside: the bundler erases those. */
const STATIC_IMPORT =
  /^(?:import|export)\s(?!type\s)[^;]*?from\s*"([^"]+)";$|^import\s*"([^"]+)";$/gm;

/** A relative specifier as the bundler finds it: the path itself, or with `.ts`/`.tsx`. */
function resolveSource(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * What the entry chunk holds: every file in `src/` that `entry` reaches
 * through static imports, by its path under `src/`, and every package
 * specifier named on the way. A dynamic `import()` ends the walk, as it ends
 * the chunk.
 */
function staticGraph(entry: string): Set<string> {
  const reached = new Set<string>();
  const queue = [join(SRC, entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const name = file.slice(SRC.length);
    if (reached.has(name)) continue;
    reached.add(name);
    if (!/\.tsx?$/.test(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? match[2] ?? "";
      if (!specifier.startsWith(".")) {
        reached.add(specifier);
        continue;
      }
      const target = resolveSource(file, specifier);
      if (target === null) throw new Error(`${name} imports ${specifier}, which does not resolve`);
      queue.push(target);
    }
  }
  return reached;
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
    expect(chunkFor("/repo/musubi/social/src/App.tsx")).toBeUndefined();
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

  it("keeps the entry chunk off the banner stack", () => {
    // `AccountBanners` is imported statically by `App.tsx`, so whatever it
    // names statically lands in the chunk every anonymous visitor downloads —
    // `/authorize` included, a cold cross-origin landing deliberately kept
    // thin. The stack it mounts reaches `StepUpDialog` and through it
    // `@simplewebauthn/browser`, so it may only be named in a dynamic import.
    //
    // An allowlist, not a pair of `toContain` checks: asserting merely that
    // the file says `lazy(` and `import(` still passes when it ALSO imports
    // the stack, the banner mount or the ceremony statically, which is the
    // exact failure being guarded — a working build, no error, and the bytes
    // paid by everyone.
    const gate = readSource("../src/components/AccountBanners.tsx");
    const staticSpecifiers = [...gate.matchAll(/^import\s[^;]*?from\s*"([^"]+)";$/gm)].map(
      (m) => m[1],
    );
    expect(staticSpecifiers.toSorted()).toEqual(["@osn/client/solid", "solid-js"]);
    expect(gate).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(\s*"\.\/AccountBannerStack"\s*\)\s*\)/);
  });

  it("keeps the entry chunk off the sign-in and switcher dialogs", () => {
    // The dialogs reach `@osn/auth-ui`'s `SignIn` and `Register`, which
    // `/authorize` must not pay for before it paints. `ShellDialogs`, in the
    // entry chunk, names them in one dynamic import; a static import of any of
    // them from anywhere the entry reaches would put them back.
    const entry = staticGraph("index.tsx");
    expect(entry, "the walk reaches the dialogs' provider").toContain(
      "components/ShellDialogs.tsx",
    );
    for (const dialogModule of [
      "components/ShellDialogSet.tsx",
      "components/AuthDialogs.tsx",
      "components/ProfileSwitcherDialog.tsx",
    ]) {
      expect(entry, `${dialogModule} is in the entry chunk`).not.toContain(dialogModule);
    }
    expect([...entry].filter((specifier) => specifier.startsWith("@osn/auth-ui"))).toEqual([]);

    // One dynamic import for all three dialogs: one per dialog makes the
    // bundler split the entry chunk and keep client code it otherwise drops.
    const provider = readSource("../src/components/ShellDialogs.tsx");
    expect([...provider.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])).toEqual([
      "./ShellDialogSet",
    ]);
  });

  it("keeps the sign-in dialog off a static registration import", () => {
    // `AuthDialogs` is loaded by `ShellDialogs` with the shell, so it is code
    // every anonymous visitor loads. Its recovery path can end in
    // passkey enrolment, and naming the ceremony statically would put
    // `startRegistration` in that shell — paid by everyone, used by the few
    // who lose a passkey. The deferring module is what keeps it out, and it
    // only works while the import inside it stays dynamic.
    const deferred = readSource("../src/lib/webauthn-registration-deferred.ts");
    expect(deferred).toMatch(/await import\(\s*"\.\/webauthn-registration"\s*\)/);
    expect(ceremonyImports("../src/lib/webauthn-registration.ts")).toContain("startRegistration");

    for (const shell of [
      "../src/components/AuthDialogs.tsx",
      "../src/components/AuthorizeSignIn.tsx",
    ]) {
      const source = readSource(shell);
      expect(source).toContain("webauthn-registration-deferred");
      // The deferred module's own name contains the bare one, so match the
      // import specifier rather than the substring.
      expect(source).not.toMatch(/from "\.\.\/lib\/webauthn-registration"/);
    }
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
