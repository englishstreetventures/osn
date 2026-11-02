import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_BUILDS } from "../../src/production-sites";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

/** The repository root. */
export const repoRoot = join(packageDir, "..", "..");

const fromRoot = (path: string): string => relative(repoRoot, path).split(sep).join("/");

/**
 * Every stack declaration, `<product>/infra/src/declaration.ts`, by its path
 * from the repository root. Each is read as text: every stack package
 * depends on this one, so none can be imported here.
 */
export const STACK_DECLARATIONS: readonly string[] = readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `${entry.name}/infra/src/declaration.ts`)
  .filter((path) => existsSync(join(repoRoot, path)))
  .toSorted();

/** The stack declaration that names the guest site's client build. */
export const CIRE_DECLARATION = "cire/infra/src/declaration.ts";

const read = (declaration: string): string => readFileSync(join(repoRoot, declaration), "utf8");

/** `relativePath`, as a declaration's stack package resolves it, from the repository root. */
const resolvedFrom = (declaration: string, relativePath: string): string =>
  fromRoot(resolve(repoRoot, declaration, "..", "..", relativePath));

/**
 * The asset directories `declaration` uploads, from the repository root: each
 * top-level string constant naming a package's `dist` or `dist/client`. A
 * stack's Worker modules (`dist/server`) are not assets.
 */
export function declaredAssetDirectories(declaration: string): readonly string[] {
  return [
    ...read(declaration).matchAll(/^const [A-Z_]+ = "(\.\.\/[a-z-]+\/dist(?:\/client)?)";$/gm),
  ]
    .map((match) => resolvedFrom(declaration, match[1] ?? ""))
    .toSorted();
}

/** The guest site's client build, as the cire stack uploads it: `INVITES_CLIENT`, the `directory` of its `assets`. */
function invitesClient(): string {
  const text = read(CIRE_DECLARATION);
  const value = /^const INVITES_CLIENT = "([^"]+)";$/m.exec(text)?.[1];
  if (value === undefined || !/\bassets: \{\s*directory: INVITES_CLIENT,/.test(text)) {
    throw new Error(
      `${CIRE_DECLARATION} no longer uploads the guest site's assets from a top-level INVITES_CLIENT; update this reader`,
    );
  }
  return resolvedFrom(CIRE_DECLARATION, value);
}

/** The build directory of every asset site Alchemy uploads: each production site's, and the guest site's client build. */
export const ASSET_BUILDS: readonly string[] = [
  ...Object.values(SITE_BUILDS).map((build) => build.directory),
  invitesClient(),
].toSorted();

/** Each asset site's package directory and public directory: its build directory without `dist` or `dist/client`. */
export const ASSET_SITES: readonly { readonly packageDir: string; readonly publicDir: string }[] =
  ASSET_BUILDS.map((build) => {
    const at = /^(.+)\/dist(?:\/client)?$/.exec(build)?.[1];
    if (at === undefined) {
      throw new Error(`${build} is not a package's dist or dist/client; update this reader`);
    }
    return { packageDir: at, publicDir: `${at}/public` };
  });

/** Every file outside this package the lists above are read from. */
export const SOURCES: readonly string[] = STACK_DECLARATIONS;
