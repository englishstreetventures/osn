import { readFile } from "node:fs/promises";

import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/**
 * AZ-P-I1. `/authorize` is a cold cross-origin landing: the browser arrives
 * from the relying party with no warm connection to the OSN issuer, so
 * `GET /authorize/context` pays DNS + TCP + TLS before a byte moves. A
 * `preconnect` overlaps that handshake with the JS parse instead.
 *
 * The origin comes from `VITE_OSN_ISSUER_URL`, the same build input the
 * client uses, so a per-environment issuer can never be preconnected to the
 * wrong host. `crossorigin` is required: the context read is
 * `credentials: "include"`, and a preconnect opened in the wrong CORS mode is
 * a second connection rather than a reused one.
 *
 * The value is read off the resolved config rather than `process.env`, so it
 * sees exactly what the app's `import.meta.env` will — `.env` files included.
 * A malformed or missing URL emits no tag rather than a dead one.
 */
export function issuerPreconnect(): Plugin {
  let issuerUrl: string | undefined;
  return {
    name: "osn-issuer-preconnect",
    configResolved(resolved) {
      issuerUrl = resolved.env.VITE_OSN_ISSUER_URL as string | undefined;
    },
    transformIndexHtml() {
      let origin: string;
      try {
        origin = new URL(issuerUrl ?? "").origin;
      } catch {
        return [];
      }
      return [
        {
          tag: "link",
          // `use-credentials`, NOT a bare `crossorigin` — an empty value means
          // anonymous mode, and the connection-pool key includes the
          // credentials flag. The call this warms (`GET /authorize/context`) is
          // `credentials: "include"`, so an anonymous preconnect lands in a
          // different pool bucket: the handshake is not reused AND an extra
          // idle TLS connection is opened. That is strictly worse than
          // shipping no tag at all.
          attrs: { rel: "preconnect", href: origin, crossorigin: "use-credentials" },
          injectTo: "head-prepend" as const,
        },
      ];
    },
  };
}

/**
 * True when every statement in the resolved barrel is a bare `export * from`
 * re-export, i.e. importing the module runs nothing.
 *
 * The dependency floats (`^13.3.0`), so a minor release lands without review.
 * `moduleSideEffects: false` tells Rollup to stop traversing the module, and
 * anything executable a future release puts in the barrel — a feature detect, a
 * singleton, a polyfill — would then be dropped from the bundle with no error
 * and a broken passkey ceremony in production. Checking the file instead of
 * trusting the comment turns that into a fallback rather than a silent break.
 */
export function barrelIsSideEffectFree(source: string): boolean {
  const statements = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
  return (
    statements.length > 0 &&
    statements.every((line) => /^export \* from ["'][^"']+["'];?$/.test(line))
  );
}

/**
 * `@simplewebauthn/browser`'s `package.json` only exports the `"."` subpath
 * (`esm/index.js`), a barrel that does `export * from './methods/
 * startRegistration.js'` and `export * from './methods/startAuthentication.
 * js'`. Every importer — whether it names one or the other — resolves
 * through that same barrel module, and the package ships no `"sideEffects":
 * false`, so Rollup conservatively keeps a static import of the barrel alive
 * in any chunk that pulls a name from it. Combined with the `manualChunks`
 * split below, that undoes the split: the barrel unconditionally re-imports
 * BOTH method chunks, so the banner's ceremony chunk still fetches
 * `startRegistration`'s chunk even though its code no longer lives beside
 * `startAuthentication`'s.
 *
 * The barrel's own body is nothing but those `export *` statements — no
 * runtime effect — so it is safe to mark side-effect-free, and
 * `barrelIsSideEffectFree` re-checks that against the installed file on every
 * build rather than trusting this paragraph. Scoped to this one
 * resolved id (via `resolveId`, deferring to Vite's own resolution first)
 * rather than a blanket `treeshake.moduleSideEffects` override, which would
 * also flip Rollup's default (side-effectful) assumption for every other
 * dependency in the graph and could silently keep dead code that used to be
 * dropped.
 */
export function webauthnBarrelHasNoSideEffects(): Plugin {
  return {
    name: "webauthn-barrel-has-no-side-effects",
    // Build only — the flag this sets only matters to Rollup's tree-shaker,
    // which the dev server never runs.
    apply: "build",
    // Must win the resolveId race against Vite's own resolver
    // (`vite:resolve`) — the first plugin to return a non-null result
    // resolves the specifier, and only this plugin's result carries the
    // `moduleSideEffects: false` flag Rollup needs. A plugin placed in
    // `build.rollupOptions.plugins` instead runs too late to win that race,
    // since Vite's core resolver already sits ahead of it.
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source !== "@simplewebauthn/browser") return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.id.includes("?")) return resolved;
      if (!resolved.id.endsWith("@simplewebauthn/browser/esm/index.js")) return resolved;
      // Never take the claim on trust — see `barrelIsSideEffectFree`. Falling
      // back to the unflagged resolution costs the chunk split, never
      // correctness.
      const barrel = await readFile(resolved.id, "utf8").catch(() => null);
      if (barrel === null || !barrelIsSideEffectFree(barrel)) return resolved;
      return { ...resolved, moduleSideEffects: false };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), solid(), issuerPreconnect(), webauthnBarrelHasNoSideEffects()],

  clearScreen: false,
  // Portless assigns the port and passes it as `PORT`; the literal is the
  // fallback for a devloop without portless (`PORTLESS=0`, or running
  // `dev:app` directly). `strictPort` keeps the old promise that the app
  // fails rather than silently moving to another port.
  server: {
    port: devPort(1422),
    strictPort: true,
  },

  build: {
    rollupOptions: {
      output: {
        // `@simplewebauthn/browser`'s single-entry barrel (see above) also
        // means Rollup's default chunking groups `startAuthentication` and
        // `startRegistration` into one shared vendor chunk regardless of
        // source-level organisation. That defeats P-I1: the security-events
        // banner (mounted on every settings visit) ends up pulling in
        // `startRegistration`, which only `SecuritySection` (opened rarely)
        // needs. Splitting on the underlying method files forces Rollup to
        // place each method's compiled body in its own chunk.
        manualChunks(id) {
          if (id.includes("@simplewebauthn/browser/esm/methods/startAuthentication")) {
            return "webauthn-authentication";
          }
          if (id.includes("@simplewebauthn/browser/esm/methods/startRegistration")) {
            return "webauthn-registration";
          }
          return undefined;
        },
      },
    },
  },
}));
