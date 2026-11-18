import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The workerd import carve-out, asserted statically.
 *
 * `osn/api` and `cire/api` are deployed as Cloudflare Workers. Neither
 * `@effect/opentelemetry`'s `NodeSdk` nor the `@opentelemetry/sdk-*` packages
 * run on workerd, so the subpaths those Workers import
 * (`@shared/observability/config`, `/logger`, `/metrics` and `/tracing`) must
 * not reach them.
 *
 * `osn/api/tests/observability.test.ts` guards the same property, but only by
 * importing the module under vitest, where a Node-only dependency resolves
 * fine and the test still passes. This one walks the real static import graph
 * from each entry file and fails on the first banned specifier, naming the file
 * that introduced it — so a re-export of `./layer` (which is `NodeSdk`) added
 * to `src/tracing/index.ts` breaks the build rather than the production deploy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../../src");

/**
 * Import specifiers that cannot run on workerd. Node built-ins are matched by
 * the `node:` prefix and by bare name; everything else is a prefix match, so
 * `@opentelemetry/sdk-trace-base` is caught by `@opentelemetry/sdk-`.
 *
 * `@opentelemetry/api` is deliberately NOT here: it is a dependency-free
 * façade, and it ships in every Worker bundle via `@shared/observability/metrics`.
 */
const BANNED_PREFIXES = [
  "@effect/opentelemetry",
  "@opentelemetry/sdk-",
  "@opentelemetry/exporter-",
  "@opentelemetry/resources",
  "node:",
];

const BANNED_BARE = new Set([
  "fs",
  "path",
  "os",
  "crypto",
  "http",
  "https",
  "net",
  "tls",
  "stream",
  "zlib",
  "worker_threads",
  "perf_hooks",
  "child_process",
]);

/**
 * One `import … from` or `export … from` clause, which may span lines: the
 * barrels re-export as `export {\n  a,\n  b,\n} from "./x"`. The clause is
 * spelled out (braces, `*`, `* as x`, a default name, an optional `type`)
 * rather than matched as "anything up to `from`", so a type union or a comment
 * that holds the word `from` before a quote yields no specifier.
 */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s*from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/**
 * Resolve a relative specifier the way a bundler would (`x`, `x.ts`,
 * `x/index.ts`) and return the RESOLVED path alongside the source — the
 * resolved path is what the next hop's own relative specifiers are relative to,
 * so returning only the text would resolve `./instrument` inside `fetch/index.ts`
 * against `src/` instead of `src/fetch/`.
 */
const readSource = (file: string): { path: string; source: string } | undefined => {
  for (const candidate of [file, `${file}.ts`, `${file}/index.ts`]) {
    try {
      return { path: candidate, source: readFileSync(candidate, "utf8") };
    } catch {
      // try the next candidate
    }
  }
  return undefined;
};

/**
 * Every specifier statically imported by `entry`, recursively through relative
 * paths (`found`, specifier to importing file), and every source file the walk
 * opened (`visited`, relative to `src/`).
 */
const collectImports = (entry: string): { found: Map<string, string>; visited: Set<string> } => {
  const found = new Map<string, string>();
  const visited = new Set<string>();
  const seen = new Set<string>();

  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const resolved = readSource(file);
    if (resolved === undefined) throw new Error(`workerd-safety: cannot read ${file}`);
    seen.add(resolved.path);
    visited.add(resolved.path.slice(srcRoot.length + 1));

    const specifiers: Array<string> = [];
    for (const match of resolved.source.matchAll(IMPORT_RE)) specifiers.push(match[1]!);
    for (const match of resolved.source.matchAll(BARE_IMPORT_RE)) specifiers.push(match[1]!);

    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        walk(resolve(dirname(resolved.path), specifier));
      } else if (!found.has(specifier)) {
        found.set(specifier, resolved.path);
      }
    }
  };

  walk(entry);
  return { found, visited };
};

const banned = (specifier: string): boolean =>
  BANNED_PREFIXES.some((prefix) => specifier.startsWith(prefix)) || BANNED_BARE.has(specifier);

describe("workerd import carve-out", () => {
  // The exact subpaths `osn/api/src/observability.ts` and
  // `cire/api/src/observability.ts` import.
  const workerEntries = {
    "@shared/observability/tracing": `${srcRoot}/tracing/index.ts`,
    "@shared/observability/logger": `${srcRoot}/logger/index.ts`,
    "@shared/observability/config": `${srcRoot}/config.ts`,
    "@shared/observability/metrics": `${srcRoot}/metrics/index.ts`,
  };

  for (const [subpath, entry] of Object.entries(workerEntries)) {
    it(`${subpath} imports nothing that fails to run on workerd`, () => {
      const offenders = [...collectImports(entry).found]
        .filter(([specifier]) => banned(specifier))
        .map(
          ([specifier, importer]) => `${specifier} (from ${importer.slice(srcRoot.length + 1)})`,
        );

      expect(offenders).toEqual([]);
    });
  }

  it("still finds the Node-only imports when they ARE reachable (guard is not vacuous)", () => {
    // `src/index.ts` is the Bun-only package root; it reaches NodeSdk on
    // purpose. If this stops failing the detector has broken, and the
    // assertions above would be passing for the wrong reason.
    const offenders = [...collectImports(`${srcRoot}/index.ts`).found].filter(([specifier]) =>
      banned(specifier),
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("follows a multi-line re-export into the file it names", () => {
    // The barrels re-export as `export {\n  a,\n} from "./workers"`. A walk that
    // misses that shape never opens these files, and a Node-only import in one
    // of them passes every check above.
    expect([...collectImports(workerEntries["@shared/observability/tracing"]).visited]).toEqual(
      expect.arrayContaining(["tracing/workers.ts"]),
    );
    expect([...collectImports(workerEntries["@shared/observability/metrics"]).visited]).toEqual(
      expect.arrayContaining(["metrics/factory.ts", "metrics/http.ts"]),
    );
  });

  it("the tracing barrel does not re-export the NodeSdk layer module", () => {
    const barrel = readFileSync(`${srcRoot}/tracing/index.ts`, "utf8");
    expect(barrel).not.toMatch(/from\s*["']\.\/layer["']/);
  });
});
