/**
 * A Bend law set (`<workspace>/laws/<topic>/`) ships in nothing: the deploy
 * map redeploys nothing for it and it needs no changeset. That holds only
 * while no file a build reads names one. oxlint refuses an import of a set
 * from a workspace's `src/`; this finds the rest — `.astro` files, which
 * oxlint skips, globs, content loaders, `new URL`, and shipped config outside
 * `src/` — wherever a workspace keeps them.
 */

/** File types a build reads code from. */
const CODE = /\.(?:[cm]?[jt]sx?|astro|svelte|vue)$/;

/** Files no build reads: tests, the law sets themselves, generated output. */
const NOT_SHIPPED = /(?:^|\/)(?:tests|__tests__|node_modules|dist)\/|\.(?:test|spec)\.[^/]+$/;

/** A law set, from inside or outside its workspace: a `laws/` path segment. */
const LAWS_SEGMENT = /(?:^|[/!])laws\//;

/**
 * Where code names a module or a file a build reads: the quoted string after
 * each of these. `import.meta.glob` and Astro's `glob()` and `file()` loaders
 * may take several, so every string inside their parentheses counts.
 */
const ONE_STRING = [
  /\bfrom\s*(['"`])([^'"`\n]*)\1/g,
  /\bimport\s*(['"`])([^'"`\n]*)\1/g,
  /\bimport\s*\(\s*(['"`])([^'"`\n]*)\1/g,
  /\brequire\s*\(\s*(['"`])([^'"`\n]*)\1/g,
  /\bnew\s+URL\s*\(\s*(['"`])([^'"`\n]*)\1/g,
];
const EVERY_STRING_IN = /\b(?:import\.meta\.glob(?:Eager)?|glob|file)\s*\(([^)]*)\)/g;
const QUOTED = /(['"`])([^'"`\n]*)\1/g;

/**
 * Whether `path` (repository-relative) is a file a product build may read:
 * code, inside one of `tops` (the product directories whose workspaces
 * ship), and not a test, a law set or generated output.
 */
export function scanned(path: string, tops: readonly string[]): boolean {
  const [top, , third] = path.split("/");
  if (top === undefined || !tops.includes(top) || third === undefined) return false;
  if (third === "laws") return false;
  return CODE.test(path) && !NOT_SHIPPED.test(path);
}

/** Every module or file name in `source` that points into a law set. */
export function lawSetReferences(source: string): string[] {
  const named: string[] = [];
  for (const pattern of ONE_STRING) {
    for (const match of source.matchAll(pattern)) named.push(match[2]!);
  }
  for (const call of source.matchAll(EVERY_STRING_IN)) {
    for (const match of call[1]!.matchAll(QUOTED)) named.push(match[2]!);
  }
  return named.filter((name) => LAWS_SEGMENT.test(name));
}
