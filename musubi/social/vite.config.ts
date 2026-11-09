import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { devPort } from "@shared/dev-urls";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/**
 * `/authorize` is a cold cross-origin landing: the browser arrives
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
 * dependency in the graph and could silently keep dead code Rollup would
 * otherwise drop.
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

/**
 * Cloudflare Turnstile's host: the widget's script (`api.js`) and its frame
 * load from it (`osn/auth-ui/src/TurnstileWidget.tsx`). Cloudflare's Turnstile
 * CSP reference asks for it in `script-src` and `frame-src`; this policy
 * leaves `frame-src` open, so only `script-src` names it.
 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Vite's resolved env, as a build reads it: `VITE_*` strings, and `DEV`/`PROD`/`SSR` booleans. */
type BuildEnv = Readonly<Record<string, string | boolean | undefined>>;

/** The issuer `src/lib/auth.ts` calls when `VITE_OSN_ISSUER_URL` is unset. */
const LOCAL_ISSUER_URL = "http://localhost:4000";

/**
 * A DNS name as `new URL` leaves it. URL parsing lets `*`, `;`, `,` and quotes
 * through in a host; written into the policy, any of them would widen a source
 * list or start a directive.
 */
const PLAIN_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** Hosts on this machine: the only ones the policy may reach over plain http. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";

/**
 * The issuer origin the build's policy names, from the chain `src/lib/auth.ts`
 * reads, so the policy admits exactly the host the bundle calls. Throws on a
 * URL that is not http(s), whose host is not a plain DNS name, or that is
 * plain http off this machine: a deployed issuer is https, and its tokens must
 * not travel in clear.
 */
export function policyIssuerOrigin(env: BuildEnv): string {
  const raw = env.VITE_OSN_ISSUER_URL;
  const issuerUrl = typeof raw === "string" ? raw : LOCAL_ISSUER_URL;
  const bad = (why: string) =>
    new Error(`content-security-policy: VITE_OSN_ISSUER_URL ${JSON.stringify(issuerUrl)} ${why}`);
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    throw bad("is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("is not http(s)");
  if (!PLAIN_HOSTNAME.test(url.hostname)) throw bad("has a host that is not a plain DNS name");
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw bad("is plain http off this machine; a deployed issuer is https");
  }
  return url.origin;
}

/** True when the build carries a Turnstile sitekey: `src/lib/auth.ts` treats a blank one as none. */
export function turnstileOn(env: BuildEnv): boolean {
  const key = env.VITE_TURNSTILE_SITEKEY;
  return typeof key === "string" && key.trim() !== "";
}

/**
 * A `'sha256-…'` source for each inline script in `html`, in page order: the
 * hash of the exact text between the tags, which is what the browser hashes.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const [, attrs = "", body = ""] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return hashes;
}

/**
 * The two directives the build adds to the policy. `script-src` admits the
 * app's own bundle, the page's inline scripts by hash, and Turnstile when the
 * build renders it; `connect-src` admits the app's own origin and the issuer.
 * Neither ever carries `'unsafe-inline'` or `'unsafe-eval'`.
 */
export function buildDirectives(policy: {
  readonly issuerOrigin: string;
  readonly turnstile: boolean;
  readonly inlineHashes: readonly string[];
}): string {
  const scripts = ["'self'", ...policy.inlineHashes];
  if (policy.turnstile) scripts.push(TURNSTILE_ORIGIN);
  return `script-src ${scripts.join(" ")}; connect-src 'self' ${policy.issuerOrigin}`;
}

/**
 * `headers` with `directives` appended to the Content-Security-Policy of the
 * `/*` rule. Throws when that rule has no policy, or when the policy already
 * sets `script-src` or `connect-src`: a second copy of either directive is
 * ignored by the browser, so the build's would never apply.
 */
export function withBuildDirectives(headers: string, directives: string): string {
  const lines = headers.split("\n");
  const rule = lines.findIndex((line) => line.trim() === "/*");
  if (rule === -1) throw new Error("content-security-policy: _headers has no /* rule");
  for (let i = rule + 1; i < lines.length && /^\s+\S/.test(lines[i] ?? ""); i++) {
    const match = /^(\s+Content-Security-Policy:\s*)(.*)$/i.exec(lines[i] ?? "");
    if (!match) continue;
    const policy = (match[2] ?? "").trim().replace(/;\s*$/, "");
    if (/(^|;)\s*(script-src|connect-src)\b/i.test(policy)) {
      throw new Error(
        "content-security-policy: the /* rule already sets script-src or connect-src; the build writes those",
      );
    }
    lines[i] = `${match[1]}${policy}; ${directives}`;
    return lines.join("\n");
  }
  throw new Error(
    "content-security-policy: the /* rule of _headers has no Content-Security-Policy",
  );
}

/**
 * Writes the build's `script-src` and `connect-src` into the built `_headers`.
 *
 * Both depend on the build: the issuer origin differs per tier
 * (`VITE_OSN_ISSUER_URL`), Turnstile loads only when the build carries a
 * sitekey, and the inline scripts' hashes come from the HTML the build emits,
 * so an edit to either script changes its hash with it. A committed policy
 * could only guess at all three. The issuer is read off the resolved config,
 * as `issuerPreconnect` reads it, so it is what `import.meta.env` holds, and
 * the build fails unless a script in the bundle carries that origin: the
 * policy and the code agree, or nothing ships.
 *
 * Build only: the dev server does not serve `_headers` as headers.
 */
export function contentSecurityPolicy(): Plugin {
  let env: BuildEnv = {};
  let outDir = "dist";
  return {
    name: "musubi-content-security-policy",
    apply: "build",
    configResolved(resolved) {
      env = resolved.env;
      outDir = resolve(resolved.root, resolved.build.outDir);
    },
    async writeBundle(_options, bundle) {
      const page = Object.values(bundle).find((file) => file.fileName === "index.html");
      if (page?.type !== "asset") {
        throw new Error("content-security-policy: the build emitted no index.html");
      }
      const html =
        typeof page.source === "string" ? page.source : new TextDecoder().decode(page.source);
      const issuerOrigin = policyIssuerOrigin(env);
      const carried = Object.values(bundle).some(
        (file) => file.type === "chunk" && file.code.includes(issuerOrigin),
      );
      if (!carried) {
        throw new Error(
          `content-security-policy: no script in the bundle calls ${issuerOrigin}, the issuer the policy would name`,
        );
      }
      const path = resolve(outDir, "_headers");
      const directives = buildDirectives({
        issuerOrigin,
        turnstile: turnstileOn(env),
        inlineHashes: inlineScriptHashes(html),
      });
      await writeFile(path, withBuildDirectives(await readFile(path, "utf8"), directives));
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    solid(),
    issuerPreconnect(),
    webauthnBarrelHasNoSideEffects(),
    contentSecurityPolicy(),
  ],

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
        // source-level organisation. Without the split the security-events
        // banner — mounted on every route a signed-in user sees — ends up
        // pulling in `startRegistration`, which only `SecuritySection` (opened
        // rarely) needs. Splitting on the underlying method files forces
        // Rollup to place each method's compiled body in its own chunk.
        manualChunks(id: string) {
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
