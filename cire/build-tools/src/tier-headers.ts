/**
 * Points the CSP in a cire app's built `_headers` at the cire-api that build
 * calls. Shared by the organiser portal (`cire/host`), the vendor portal
 * (`cire/vendor`) and the guest site (`cire/invites`); each app's
 * `src/lib/tier-headers.ts` passes its own {@link TierHeadersOptions}.
 *
 * Each app's `public/_headers` is written for production: `connect-src`,
 * `img-src`, `report-uri` and `Reporting-Endpoints` all name
 * `https://api.cireweddings.com`. Astro copies it into the directory it serves
 * (`dist/` for a static portal, `dist/client/` for the guest-site Worker)
 * unchanged, and the same file would otherwise ship to every tier — the dev
 * tier calls `https://api.dev.cireweddings.com`, which that policy does not
 * allow, and would file its violation reports with the production collector.
 * After the build, this integration swaps the production origin for the origin
 * of the cire-api URL the app's own code resolves, so each tier's policy names
 * its own API and its own collector. On a production build the file is left
 * byte-for-byte as committed.
 *
 * The env comes from Vite's resolved config, the same object that fills
 * `import.meta.env.PUBLIC_*` in the build, `.env` files and mode included, and
 * goes through the app's own chain ({@link TierHeadersOptions.apiUrl}). As a
 * check that the two agree, the build fails unless some script in the bundle
 * that carries the API URL contains the origin the header now names.
 *
 * Build-only: an app's `astro.config.mjs` is the one way in. Never import it
 * from app code — it reads the filesystem.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";

import type { AstroIntegration } from "astro";

/** The cire-api origin every app's `public/_headers` is written for. */
export const PRODUCTION_API_ORIGIN = "https://api.cireweddings.com";

/**
 * The production origin where it ends: not the start of `…com.example`,
 * `…com:8443` or `…community`. A function, so each caller gets its own
 * `lastIndex`.
 */
const productionOrigin = () => /https:\/\/api\.cireweddings\.com(?![\w.:-])/g;

/**
 * A DNS name as `new URL` leaves it: lowercased, internationalised labels in
 * punycode. URL parsing lets `*`, `;`, `,` and quotes through in a host; any of
 * them written into the policy would widen a source list or start a directive.
 */
const PLAIN_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** The origin of a cire-api URL, or a build error naming the bad value. */
function originOf(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`tier-headers: cannot read the cire-api URL ${JSON.stringify(apiUrl)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`tier-headers: the cire-api URL ${JSON.stringify(apiUrl)} is not http(s)`);
  }
  if (!PLAIN_HOSTNAME.test(url.hostname)) {
    throw new Error(
      `tier-headers: the cire-api URL ${JSON.stringify(apiUrl)} has a host that is not a plain DNS name`,
    );
  }
  return url.origin;
}

/**
 * `contents` with every production cire-api origin replaced by `apiUrl`'s.
 * Throws when the file names no production origin, since there would be
 * nothing to point at the tier's API and the policy would ship unchanged.
 */
export function retargetHeaders(contents: string, apiUrl: string): string {
  const origin = originOf(apiUrl);
  if (!productionOrigin().test(contents)) {
    throw new Error(`tier-headers: _headers does not name ${PRODUCTION_API_ORIGIN}`);
  }
  return contents.replace(productionOrigin(), () => origin);
}

/** Whether any `.js` or `.mjs` file under `dir` contains `origin`. */
export async function bundleNamesOrigin(dir: URL, origin: string): Promise<boolean> {
  const scripts = (await readdir(dir, { recursive: true })).filter(
    (entry) => entry.endsWith(".js") || entry.endsWith(".mjs"),
  );
  const sources = await Promise.all(scripts.map((entry) => readFile(new URL(entry, dir), "utf8")));
  return sources.some((source) => source.includes(origin));
}

/** The string values of Vite's resolved env, by name. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

export interface TierHeadersOptions {
  /**
   * The cire-api URL this build calls: the same chain the app's own code
   * resolves from `import.meta.env`, applied to Vite's resolved env.
   */
  apiUrl: (env: BuildEnv) => string;
  /**
   * The build output that carries the API URL, and so must name the origin the
   * header now names. `client` is the directory Astro reports when the build
   * is done, which also holds `_headers`: a static site whose client scripts
   * call the API. `server` is Astro's `build.server` directory: a
   * server-rendered site whose pages read the URL on the server and hand it to
   * islands as a prop, so no client script carries it.
   */
  bundle: "client" | "server";
}

export function tierHeaders({
  apiUrl: resolveApiUrl,
  bundle,
}: TierHeadersOptions): AstroIntegration {
  // The API URL Vite's env resolves to. Vite resolves its config more than once
  // in one `astro build`; every copy carries the same env, so the last one kept
  // is as good as the first.
  let apiUrl: string | undefined;
  // Where the server bundle is written, from Astro's final config.
  let serverDir: URL | undefined;

  return {
    name: "cire-tier-headers",
    hooks: {
      "astro:config:setup": ({ command, updateConfig }) => {
        if (command !== "build") return;
        updateConfig({
          vite: {
            plugins: [
              {
                name: "cire-tier-headers:env",
                configResolved(config) {
                  const env = Object.entries(config.env).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  );
                  apiUrl = resolveApiUrl(Object.fromEntries(env));
                },
              },
            ],
          },
        });
      },

      "astro:config:done": ({ config }) => {
        serverDir = config.build.server;
      },

      "astro:build:done": async ({ dir, logger }) => {
        if (apiUrl === undefined) {
          throw new Error("tier-headers: never received Vite's env, so cannot set the CSP origin");
        }
        const bundleDir = bundle === "client" ? dir : serverDir;
        if (bundleDir === undefined) {
          throw new Error(
            "tier-headers: never received Astro's config, so cannot find the server bundle",
          );
        }
        const file = new URL("_headers", dir);
        const headers = retargetHeaders(await readFile(file, "utf8"), apiUrl);
        const origin = originOf(apiUrl);
        if (!(await bundleNamesOrigin(bundleDir, origin))) {
          throw new Error(
            `tier-headers: no ${bundle} script names ${origin}, so the CSP would not match the API this build calls`,
          );
        }
        await writeFile(file, headers);
        logger.info(`CSP in _headers points at ${origin}`);
      },
    },
  };
}
