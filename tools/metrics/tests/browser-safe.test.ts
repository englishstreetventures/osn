/**
 * The dashboard must not reach a Node builtin.
 *
 * This test reads source text rather than importing anything, which is unusual
 * and deliberate: the property under test belongs to the module graph as Vite
 * builds it for a browser, and no runtime available here can observe it. Vitest
 * runs on node (`tools/metrics/vitest.config.ts`), where `import "node:fs"`
 * simply succeeds — so a test that imported `Dashboard.tsx` and asserted it
 * rendered would have passed against the very bug this guards.
 *
 * What actually happens in the browser: Vite replaces `node:fs` with a stub
 * that throws on first property access, the throw lands during module
 * evaluation before `render()` is reached, and the page stays blank with no
 * failure reported anywhere but the console.
 *
 * It follows imports rather than listing files, because the leak that prompted
 * it was one hop past anything the dashboard names: `shape.ts` imports
 * `report.ts`, and `report.ts` statically imported `index.ts`. A guard that
 * only checked the file in the stack trace would have stayed green.
 *
 * Only *static* imports are walked, and that is the point rather than a gap:
 * they are exactly the set evaluated when a module loads. `require()` and
 * dynamic `import()` are the escape hatch — `report.ts` reaches `node:fs` and
 * `index.ts` through both, on purpose, inside the functions that need them.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const CLI = new URL("../../pr-metrics/index.ts", import.meta.url).pathname;

/**
 * Every module a file statically imports.
 *
 * Two forms, because a check that knows only the first lets the second through
 * unseen: `… from "x"`, which also covers `export … from`, and the side-effect
 * `import "x"`, which has no `from` at all. Type-only imports and exports come
 * out first — TypeScript erases those, so they pull nothing into the browser.
 */
function staticImports(source: string): string[] {
  const runtime = source.replaceAll(/^\s*(?:import|export)\s+type\s[^;]*;/gm, "");

  return [
    ...runtime.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...runtime.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ].map((match) => match[1] as string);
}

/** A specifier written without its extension, or pointing at a directory,
 * still names a real module. Try what the bundler would try. */
function resolveFile(base: string): string | null {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];

  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

/**
 * Where a specifier's file lives, or `null` for a third-party package.
 *
 * Workspace packages are resolved as well as relative paths. `@osn/ui` is one,
 * and leaving bare specifiers unwalked would put every component the dashboard
 * renders outside this test — which is precisely the shape of hop that hid the
 * original defect.
 */
function locate(specifier: string, importer: string): string | null {
  if (specifier.startsWith(".")) return resolveFile(resolve(dirname(importer), specifier));
  if (specifier.startsWith("node:") || !specifier.startsWith("@")) return null;

  const [scope, name, ...subpath] = specifier.split("/");

  // Bun links a workspace dependency into the *consuming* package's
  // `node_modules`, not the root's, so this walks up from the importer the way
  // resolution actually does. Looking only in the root finds nothing.
  let search = dirname(importer);
  let linked = join(search, "node_modules", `${scope}/${name}`);
  while (!existsSync(linked) && search.startsWith(ROOT) && search !== ROOT) {
    search = dirname(search);
    linked = join(search, "node_modules", `${scope}/${name}`);
  }
  if (!existsSync(linked)) return null;

  const dir = realpathSync(linked);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  const target = manifest.exports?.[subpath.length > 0 ? `./${subpath.join("/")}` : "."];

  return target === undefined ? null : resolveFile(resolve(dir, target));
}

/** Every file reachable from `entries` by static import, and the builtins they name. */
function walk(entries: string[]): { files: Set<string>; builtins: Map<string, string> } {
  const files = new Set<string>();
  const builtins = new Map<string, string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);

    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) builtins.set(file, specifier);

      const next = locate(specifier, file);
      if (next !== null) queue.push(next);
    }
  }

  return { files, builtins };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);

    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the dashboard's module graph stays browser-safe", () => {
  const { files, builtins } = walk(sourceFiles(SRC));

  it("never reaches the pr-metrics CLI entry point", () => {
    expect([...files].filter((file) => file === CLI)).toEqual([]);
  });

  it("statically imports no Node builtin", () => {
    expect([...builtins].map(([file, specifier]) => `${file} → ${specifier}`)).toEqual([]);
  });

  it("walks past a workspace package rather than stopping at it", () => {
    // Without this the first two assertions could pass by seeing almost
    // nothing. `@osn/ui` is the dashboard's one workspace dependency, and its
    // files must be inside the graph for their imports to have been checked.
    expect([...files].some((file) => file.includes("/osn/ui/src/"))).toBe(true);
  });
});
