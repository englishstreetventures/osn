// The invites SSR size guard had no test anywhere in the repo, and the
// generalisation in `scripts/guard-bundle-size.sh` is where
// that test belongs, since writing it against the old
// cire/invites/scripts/guard-ssr-size.sh would have meant writing it twice.
//
// A follow-up correction moved the mode+threshold out of the command line
// (previously `guard-bundle-size.sh <package-dir> <mode> <threshold>`, copied
// by hand into every caller) and into scripts/bundle-size-budgets.txt, the
// single source of truth every caller now looks its app up in. These tests
// run the real script as a subprocess, the same way
// scripts/tests/cire-dev-db-guard.cli.test.ts does, against a FIXTURE budgets
// file (`BUNDLE_SIZE_BUDGETS_FILE`) and a fixture resolution root
// (`BUNDLE_SIZE_BUDGETS_ROOT`, which only `--all` uses) — the same
// env-var-override idiom `ASTRO_TEST_ROUTE_APPS` uses for
// check-astro-test-routes.ts, and `WRANGLER_TOML` for check-d1-database-id.ts
// — so a future re-baseline of the REAL budgets file cannot break these.
//
// Covers, one case per independent decision point:
//
//   1. total under threshold -> exit 0, no "::warning::"
//   2. total over threshold -> exit 0, a "::warning::" line saying "exceeds the"
//   3. the measured directory missing -> exit 1, "is missing"
//   4. the measured directory holding only excluded files -> exit 1, "holds no
//      deployable files"
//   5. a large source map beside its own chunk, sized so counting the map would
//      trip the threshold and excluding it would not -> exit 0
//   5a. a *.map with no chunk beside it, or whose content is not a source map,
//      is measured like any other file
//   5b. only the adapter's top-level wrangler.json is skipped, not one nested
//      deeper
//   6. a source map where the app is served publicly -> exit 1, before
//      anything is measured: a *.map or an inline `sourceMappingURL=data:`
//      map under worker mode's dist/client (read through a link, and a link
//      that cannot be read refused), or anywhere under static mode's dist
//      (any case of `.map`, in .js, .mjs or .css); a clean static dist passes
//   7. static mode counts only *.js/*.css, ignoring everything else; a total
//      exactly at its budget does not warn
//   8. a package-dir with no row in the budgets file -> exit 1, naming the file
//   9. --all runs every row, resolved against BUNDLE_SIZE_BUDGETS_ROOT
//  10. a malformed row (wrong field count / bad mode / non-numeric threshold)
//      -> exit 1, naming the file and line, with nothing measured
//  11. blank lines and comment-only lines in the budgets file are ignored
//  12. --all with a row whose package directory does not exist -> exit 1,
//      naming the directory, and still runs the other rows
//  13. the budgets file missing -> exit 1, with nothing measured
//  14. --all with one row refused and a later row over budget -> exit 1, with
//      the refusal and the warning both printed
//
// No `bun install`: this only imports `bun:test` and Node built-ins, matching
// every other file under scripts/ (the `script-tests` CI job runs with none).

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = new URL("../guard-bundle-size.sh", import.meta.url).pathname;

async function runCli(
  budgetsFile: string,
  budgetsRoot: string,
  ...args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      BUNDLE_SIZE_BUDGETS_FILE: budgetsFile,
      BUNDLE_SIZE_BUDGETS_ROOT: budgetsRoot,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// The guard measures `gzip -nc <file> | wc -c`, so a test that hardcodes an
// expected total is really asserting gzip's own output size — pin the fixture
// file's OWN gzip size the same way the guard computes it, instead of guessing.
async function gzipSize(path: string): Promise<number> {
  const proc = Bun.spawn(["gzip", "-nc", path], { stdout: "pipe" });
  const [buf] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  return buf.byteLength;
}

// A source map in the shape the SSR build writes: a JSON object with a numeric
// `version`, a `sources` array and a `mappings` string. The mappings are
// random base64, so the file stays large after gzip.
function sourceMapJson(file: string, mappingsLength: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = crypto.getRandomValues(new Uint8Array(mappingsLength));
  const mappings = Array.from(bytes, (b) => alphabet[b % 64]).join("");
  return JSON.stringify({ version: 3, file, sources: ["../src/entry.ts"], names: [], mappings });
}

// A fixture "package directory" needs two path segments under the root for
// resolve_label() to produce a deterministic, known label ("fixture-app/pkg")
// to key a budgets-file row on — a bare mkdtemp root has an unpredictable
// parent directory name (varies by OS temp-dir layout) and would not.
async function withFixture(
  budgetsLines: readonly string[],
  run: (opts: {
    readonly pkgDir: string;
    readonly root: string;
    readonly budgetsFile: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const pkgDir = join(root, "fixture-app", "pkg");
    await mkdir(pkgDir, { recursive: true });
    const budgetsFile = join(root, "budgets.txt");
    await writeFile(budgetsFile, budgetsLines.join("\n") + "\n");
    await run({ pkgDir, root, budgetsFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("exits 0 when the worker total is under the threshold", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("gzip total");
    expect(stdout).not.toContain("::warning::");
    expect(exitCode).toBe(0);
  });
});

test("warns and exits 0 when the worker total exceeds the threshold", async () => {
  await withFixture(["fixture-app/pkg worker 0"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("::warning::fixture-app/pkg dist/server gzip total");
    expect(stdout).toContain("exceeds the 0 byte guard");
    expect(stdout).not.toContain("::error::");
    expect(exitCode).toBe(0);
  });
});

test("exits non-zero when dist/server is missing", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("is missing");
    expect(exitCode).not.toBe(0);
  });
});

test("exits non-zero when dist/server holds only excluded files", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/wrangler.json"), "{}");

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("holds no deployable files");
    expect(exitCode).not.toBe(0);
  });
});

test("excluding a real source map is load-bearing: counting it would trip the threshold, excluding it does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const pkgDir = join(root, "fixture-app", "pkg");
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    const entryPath = join(pkgDir, "dist/server/entry.mjs");
    const mapPath = join(pkgDir, "dist/server/entry.mjs.map");
    await writeFile(entryPath, "export default 1;\n");
    // Random mappings, so it does not gzip down to nothing — a genuinely large map.
    await writeFile(mapPath, sourceMapJson("entry.mjs", 20000));

    const entrySize = await gzipSize(entryPath);
    const mapSize = await gzipSize(mapPath);
    // Between the real total alone and the real total plus the map, so
    // counting the map trips it and excluding it does not.
    const threshold = entrySize + Math.floor(mapSize / 2);
    const budgetsFile = join(root, "budgets.txt");
    await writeFile(budgetsFile, `fixture-app/pkg worker ${threshold}\n`);

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(`${entrySize} bytes`);
    expect(stdout).not.toContain("exceeds the");
    expect(exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exits non-zero when dist/client holds a source map", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(pkgDir, "dist/client/_astro"), { recursive: true });
    await writeFile(join(pkgDir, "dist/client/_astro/chunk.js.map"), "{}");

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("dist/client");
    expect(stdout).toContain("source map");
    expect(stdout).toContain("served publicly");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

// A source map wherever an app's files are served publicly publishes its
// unminified source, so it is refused in either form: a `*.map` file, or a
// map inlined into a file as a `sourceMappingURL=data:` comment. Each case
// below sets a budget nothing can reach and asserts nothing was measured, so
// the refusal stands on its own, apart from the budget.
const INLINE_MAP_BASE64 = btoa(
  JSON.stringify({ version: 3, sources: ["../src/client.ts"], names: [], mappings: "AAAA" }),
);

// The comment the build appends with `vite.build.sourcemap: "inline"`.
function withInlineMap(file: string, code: string): string {
  return file.endsWith(".css")
    ? `${code}/*# sourceMappingURL=data:application/json;base64,${INLINE_MAP_BASE64} */\n`
    : `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${INLINE_MAP_BASE64}\n`;
}

test.each([
  ["beside its chunk in dist/_astro", "dist/_astro/client.js.map"],
  ["outside dist/_astro, as a copy from public/ lands", "dist/vendor/lib.js.map"],
  ["named in upper case", "dist/_astro/CLIENT.JS.MAP"],
])("static mode exits non-zero on a source map file %s", async (_where, mapPath) => {
  await withFixture(["fixture-app/pkg static 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/_astro"), { recursive: true });
    await writeFile(join(pkgDir, "dist/_astro/client.js"), "console.log(1);\n");
    await mkdir(join(pkgDir, dirname(mapPath)), { recursive: true });
    await writeFile(join(pkgDir, mapPath), sourceMapJson("client.js", 200));

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("::error::fixture-app/pkg dist holds 1 source map");
    expect(stdout).toContain(mapPath);
    expect(stdout).toContain("served publicly");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

test.each([
  "dist/_astro/client.js",
  "dist/_astro/client.mjs",
  "dist/_astro/style.css",
  "dist/vendor/lib.js",
])("static mode exits non-zero on an inline source map in %s", async (file) => {
  await withFixture(["fixture-app/pkg static 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/_astro"), { recursive: true });
    await writeFile(join(pkgDir, "dist/_astro/other.js"), "console.log(0);\n");
    await mkdir(join(pkgDir, dirname(file)), { recursive: true });
    await writeFile(join(pkgDir, file), withInlineMap(file, "console.log(1);\n"));

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(
      "::error::fixture-app/pkg dist holds 1 file(s) with an inline source map",
    );
    expect(stdout).toContain(file);
    expect(stdout).toContain("served publicly");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

test("worker mode exits non-zero on an inline source map in dist/client", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(pkgDir, "dist/client/_astro"), { recursive: true });
    const file = "dist/client/_astro/client.js";
    await writeFile(join(pkgDir, file), withInlineMap(file, "console.log(1);\n"));

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(
      "::error::fixture-app/pkg dist/client holds 1 file(s) with an inline source map",
    );
    expect(stdout).toContain(file);
    expect(stdout).toContain("served publicly");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

// Static Assets serve the file a link points at, so a link is read through,
// and one that cannot be read is refused rather than passed unchecked.
test("worker mode reads an inline source map through a link in dist/client", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(pkgDir, "dist/client/_astro"), { recursive: true });
    const outside = join(root, "outside.js");
    await writeFile(outside, withInlineMap(outside, "console.log(1);\n"));
    await symlink(outside, join(pkgDir, "dist/client/_astro/linked.js"));

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("holds 1 file(s) with an inline source map");
    expect(stdout).toContain("dist/client/_astro/linked.js");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

test("worker mode exits non-zero on a link in dist/client it cannot read", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(pkgDir, "dist/client/_astro"), { recursive: true });
    await symlink(join(root, "does-not-exist.js"), join(pkgDir, "dist/client/_astro/gone.js"));

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("::error::fixture-app/pkg could not read dist/client/_astro/gone.js");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

test("static mode passes a clean dist: pages, headers, chunks, styles and fonts, no source map", async () => {
  await withFixture(["fixture-app/pkg static 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/_astro/fonts"), { recursive: true });
    await writeFile(
      join(pkgDir, "dist/index.html"),
      '<!doctype html><script type="module" src="/_astro/client.js"></script>\n',
    );
    await writeFile(join(pkgDir, "dist/_headers"), "/*\n  X-Frame-Options: DENY\n");
    await writeFile(join(pkgDir, "dist/favicon.svg"), "<svg></svg>\n");
    await writeFile(join(pkgDir, "dist/_astro/client.js"), "console.log(1);\n");
    await writeFile(join(pkgDir, "dist/_astro/style.css"), "body{margin:0}\n");
    await writeFile(
      join(pkgDir, "dist/_astro/fonts/inter.woff2"),
      crypto.getRandomValues(new Uint8Array(2000)),
    );

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("fixture-app/pkg dist/_astro gzip total");
    expect(stdout).not.toContain("::error::");
    expect(exitCode).toBe(0);
  });
});

// A file is left out of the worker total because it IS a source map, not
// because its name ends in `.map`. Each case writes a real chunk plus one
// `.map`-named file that fails one half of that test, and asserts the total
// covers both files — under a threshold high enough that a pass proves the file
// was counted, not that the script died on it.
async function expectMapCounted(mapName: string, mapContent: string | Uint8Array): Promise<void> {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    const entryPath = join(pkgDir, "dist/server/entry.mjs");
    await writeFile(entryPath, "export default 1;\n");
    const mapPath = join(pkgDir, "dist/server", mapName);
    await writeFile(mapPath, mapContent);

    const expected = (await gzipSize(entryPath)) + (await gzipSize(mapPath));
    const { exitCode, stdout, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toBe("");
    expect(stdout).toContain(`gzip total: ${expected} bytes across 2 files`);
    expect(exitCode).toBe(0);
  });
}

test("a *.map with no chunk of the same name beside it is measured, even when it parses as a source map", async () => {
  await expectMapCounted("payload.map", sourceMapJson("payload", 2000));
});

test("a *.map named after a real chunk is measured when its content is not JSON", async () => {
  await expectMapCounted("entry.mjs.map", crypto.getRandomValues(new Uint8Array(2000)));
});

test.each([
  ["an empty object", "{}"],
  ["an array", "[]"],
  ["null", "null"],
  ["an object with no mappings", JSON.stringify({ version: 3, sources: [] })],
  ["an object with no sources", JSON.stringify({ version: 3, mappings: "AAAA" })],
  ["an object with no version", JSON.stringify({ sources: [], mappings: "AAAA" })],
  ["a string version", JSON.stringify({ version: "3", sources: [], mappings: "AAAA" })],
  ["a non-string mappings", JSON.stringify({ version: 3, sources: [], mappings: [1] })],
])(
  "a *.map named after a real chunk is measured when it is JSON but %s, not a source map",
  async (_label, content) => {
    await expectMapCounted("entry.mjs.map", content);
  },
);

// The file name reaches the checker as an argument, never as part of its
// source, so a chunk named with quotes and `$(…)` is read, not run.
test("a real source map beside a chunk whose name holds shell and JS metacharacters is still excluded", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    const chunkName = "weird $(touch pwned) ' \" `x` name.mjs";
    const chunkPath = join(pkgDir, "dist/server", chunkName);
    await writeFile(chunkPath, "export default 1;\n");
    await writeFile(
      join(pkgDir, "dist/server", `${chunkName}.map`),
      sourceMapJson(chunkName, 2000),
    );

    const expected = await gzipSize(chunkPath);
    const { exitCode, stdout, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toBe("");
    expect(stdout).toContain(`gzip total: ${expected} bytes across 1 files`);
    expect(exitCode).toBe(0);
    expect(await Bun.file(join(pkgDir, "pwned")).exists()).toBe(false);
    expect(await Bun.file(join(pkgDir, "dist/server/pwned")).exists()).toBe(false);
  });
});

// Without bun every real map would read as "not a map" and the total would
// roughly double, failing with a misleading "exceeds the" line. The guard names
// the missing tool instead.
const PATH_WITHOUT_BUN = "/usr/bin:/bin";
test.skipIf(Bun.which("bun", { PATH: PATH_WITHOUT_BUN }) !== null)(
  "worker mode exits non-zero, naming bun, when bun is not on PATH",
  async () => {
    await withFixture(
      ["fixture-app/pkg worker 999999999"],
      async ({ pkgDir, root, budgetsFile }) => {
        await mkdir(join(pkgDir, "dist/server"), { recursive: true });
        await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

        const proc = Bun.spawn(["/bin/bash", SCRIPT, pkgDir], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: PATH_WITHOUT_BUN,
            BUNDLE_SIZE_BUDGETS_FILE: budgetsFile,
            BUNDLE_SIZE_BUDGETS_ROOT: root,
          },
        });
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(stdout).toContain("bun is not on PATH");
        expect(stdout).not.toContain("gzip total");
        expect(exitCode).not.toBe(0);
      },
    );
  },
);

// The chunk a map is named after has to be a file. A directory of the same
// name does not make the map a real one.
test("a source-map-shaped *.map beside a directory of the same name is measured", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server/chunks"), { recursive: true });
    const entryPath = join(pkgDir, "dist/server/entry.mjs");
    await writeFile(entryPath, "export default 1;\n");
    const mapPath = join(pkgDir, "dist/server/chunks.map");
    await writeFile(mapPath, sourceMapJson("chunks", 2000));

    const expected = (await gzipSize(entryPath)) + (await gzipSize(mapPath));
    const { exitCode, stdout, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toBe("");
    expect(stdout).toContain(`gzip total: ${expected} bytes across 2 files`);
    expect(exitCode).toBe(0);
  });
});

test("only the top-level wrangler.json is skipped; one nested deeper is measured", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server/chunks"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/wrangler.json"), "{}");
    const entryPath = join(pkgDir, "dist/server/entry.mjs");
    await writeFile(entryPath, "export default 1;\n");
    const nestedPath = join(pkgDir, "dist/server/chunks/wrangler.json");
    await writeFile(nestedPath, JSON.stringify({ payload: "x".repeat(500) }));

    const expected = (await gzipSize(entryPath)) + (await gzipSize(nestedPath));
    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(`gzip total: ${expected} bytes across 2 files`);
    expect(exitCode).toBe(0);
  });
});

// `find -type f` does not list a symlink, but wrangler uploads the file a
// link points at and Pages serves it, so a link is refused rather than left
// out of the total.
test.each([
  ["worker", "dist/server", "entry.mjs"],
  ["static", "dist/_astro", "client.js"],
] as const)(
  "%s mode exits non-zero, naming the link, when the measured directory holds a symlink",
  async (mode, dir, realName) => {
    await withFixture(
      [`fixture-app/pkg ${mode} 999999999`],
      async ({ pkgDir, root, budgetsFile }) => {
        await mkdir(join(pkgDir, dir), { recursive: true });
        await writeFile(join(pkgDir, dir, realName), "export default 1;\n");
        const outside = join(root, "payload.mjs");
        await writeFile(outside, "export const big = 1;\n");
        await symlink(outside, join(pkgDir, dir, "linked.mjs"));

        const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
        expect(stdout).toContain("symlink");
        expect(stdout).toContain(`${dir}/linked.mjs`);
        expect(stdout).not.toContain("gzip total");
        expect(exitCode).not.toBe(0);
      },
    );
  },
);

test("static mode counts only *.js and *.css, ignoring everything else in dist/_astro", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const pkgDir = join(root, "fixture-app", "pkg");
    await mkdir(join(pkgDir, "dist/_astro"), { recursive: true });
    const jsPath = join(pkgDir, "dist/_astro/client.js");
    await writeFile(jsPath, "console.log(1);\n");
    // A large, incompressible font file that must NOT count toward the total.
    await writeFile(
      join(pkgDir, "dist/_astro/font.woff2"),
      crypto.getRandomValues(new Uint8Array(50000)),
    );

    const jsSize = await gzipSize(jsPath);
    const budgetsFile = join(root, "budgets.txt");
    // The budget is exactly the total, which also pins the boundary: a total
    // equal to its budget is not over it and does not warn.
    await writeFile(budgetsFile, `fixture-app/pkg static ${jsSize}\n`);

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(`${jsSize} bytes across 1 files`);
    expect(stdout).not.toContain("::warning::");
    expect(exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exits non-zero for a package-dir with no row in the budgets file, naming the file", async () => {
  await withFixture(
    ["some-other-app/pkg worker 999999999"],
    async ({ pkgDir, root, budgetsFile }) => {
      await mkdir(join(pkgDir, "dist/server"), { recursive: true });

      const { exitCode, stderr } = await runCli(budgetsFile, root, pkgDir);
      expect(stderr).toContain("no budget recorded");
      expect(stderr).toContain(budgetsFile);
      expect(exitCode).not.toBe(0);
    },
  );
});

test("--all runs every row, resolved against BUNDLE_SIZE_BUDGETS_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const appADir = join(root, "fixture-a", "pkg");
    const appBDir = join(root, "fixture-b", "pkg");
    await mkdir(join(appADir, "dist/server"), { recursive: true });
    await writeFile(join(appADir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(appBDir, "dist/_astro"), { recursive: true });
    await writeFile(join(appBDir, "dist/_astro/client.js"), "console.log(1);\n");

    const budgetsFile = join(root, "budgets.txt");
    await writeFile(
      budgetsFile,
      "fixture-a/pkg worker 999999999\nfixture-b/pkg static 999999999\n",
    );

    const { exitCode, stdout } = await runCli(budgetsFile, root, "--all");
    expect(stdout).toContain("fixture-a/pkg dist/server gzip total");
    expect(stdout).toContain("fixture-b/pkg dist/_astro gzip total");
    expect(exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--all warns for the row over budget, reports both apps, and exits 0", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const appADir = join(root, "fixture-a", "pkg");
    const appBDir = join(root, "fixture-b", "pkg");
    await mkdir(join(appADir, "dist/server"), { recursive: true });
    await writeFile(join(appADir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(appBDir, "dist/_astro"), { recursive: true });
    await writeFile(join(appBDir, "dist/_astro/client.js"), "console.log(1);\n");

    const budgetsFile = join(root, "budgets.txt");
    // fixture-a is given an impossible (zero) threshold; fixture-b is fine.
    await writeFile(budgetsFile, "fixture-a/pkg worker 0\nfixture-b/pkg static 999999999\n");

    const { exitCode, stdout } = await runCli(budgetsFile, root, "--all");
    expect(stdout).toContain("::warning::fixture-a/pkg dist/server gzip total");
    expect(stdout).toContain("exceeds the");
    expect(stdout).toContain("fixture-b/pkg dist/_astro gzip total");
    expect(exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// What ci.yml runs: a refusal in one row fails the whole run, and a warning in
// another neither hides it nor stops that row being measured. The refusing
// row comes first, so the warning row after it must not clear the failure.
test("--all exits non-zero when one row refuses, and still warns for a later row over budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const appADir = join(root, "fixture-a", "pkg");
    const appBDir = join(root, "fixture-b", "pkg");
    await mkdir(join(appADir, "dist/server"), { recursive: true });
    await writeFile(join(appADir, "dist/server/entry.mjs"), "export default 1;\n");
    await mkdir(join(appADir, "dist/client/_astro"), { recursive: true });
    await writeFile(join(appADir, "dist/client/_astro/chunk.js.map"), "{}");
    await mkdir(join(appBDir, "dist/server"), { recursive: true });
    await writeFile(join(appBDir, "dist/server/entry.mjs"), "export default 1;\n");

    const budgetsFile = join(root, "budgets.txt");
    // fixture-a is well under budget but publishes a source map; fixture-b is
    // clean but given an impossible (zero) threshold.
    await writeFile(budgetsFile, "fixture-a/pkg worker 999999999\nfixture-b/pkg worker 0\n");

    const { exitCode, stdout } = await runCli(budgetsFile, root, "--all");
    expect(stdout).toContain("::error::fixture-a/pkg dist/client holds 1 source map");
    expect(stdout).toContain("::warning::fixture-b/pkg dist/server gzip total");
    expect(exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The malformed-row cases hold a real build, so the directory could be
// measured and nothing but the row's validation is left to refuse it.
test("exits non-zero on a malformed row (wrong field count), naming the file and line", async () => {
  await withFixture(["fixture-app/pkg worker"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

    const { exitCode, stdout, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toContain(budgetsFile);
    expect(stderr).toContain(":1:");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

test("exits non-zero on a row with an unrecognised mode", async () => {
  await withFixture(["fixture-app/pkg bogus 999999999"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });

    const { exitCode, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toContain("must be 'worker' or 'static'");
    expect(exitCode).not.toBe(0);
  });
});

test("exits non-zero on a row with a non-numeric threshold", async () => {
  await withFixture(
    ["fixture-app/pkg worker not-a-number"],
    async ({ pkgDir, root, budgetsFile }) => {
      await mkdir(join(pkgDir, "dist/server"), { recursive: true });
      await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

      const { exitCode, stdout, stderr } = await runCli(budgetsFile, root, pkgDir);
      expect(stderr).toContain("must be a positive integer");
      expect(stdout).not.toContain("gzip total");
      expect(exitCode).not.toBe(0);
    },
  );
});

test("exits non-zero when the budgets file does not exist, measuring nothing", async () => {
  await withFixture(["fixture-app/pkg worker 999999999"], async ({ pkgDir, root }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

    const { exitCode, stdout, stderr } = await runCli(
      join(root, "no-such-budgets.txt"),
      root,
      pkgDir,
    );
    expect(stderr).toContain("budgets file not found");
    expect(stdout).not.toContain("gzip total");
    expect(exitCode).not.toBe(0);
  });
});

test("blank lines and comment-only lines in the budgets file are ignored", async () => {
  await withFixture(
    ["", "# a full-line comment", "fixture-app/pkg worker 999999999   # measured 42", "   "],
    async ({ pkgDir, root, budgetsFile }) => {
      await mkdir(join(pkgDir, "dist/server"), { recursive: true });
      await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

      const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
      expect(stdout).toContain("gzip total");
      expect(exitCode).toBe(0);
    },
  );
});

// Every other "package directory" case above mkdirs the fixture path
// first — even the ones asserting a DIFFERENT failure (missing dist/server,
// no matching row) always start from a package directory that exists. This
// is the sibling branch: the package directory argument itself was never
// created, so resolve_label()'s own `cd` fails before a budgets lookup ever
// happens.
test("exits non-zero when the package directory itself was never created", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    // Deliberately no mkdir — the fixture root exists, the package directory
    // under it (unlike every withFixture-based case above) never does.
    const pkgDir = join(root, "fixture-app", "pkg");
    const budgetsFile = join(root, "budgets.txt");
    await writeFile(budgetsFile, "fixture-app/pkg worker 999999999\n");

    const { exitCode, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toContain("does not exist");
    expect(stderr).toContain(pkgDir);
    expect(exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The one existing blank/comment-lines test above always includes a
// real record alongside the blank/comment lines, so `any_record` in run_all()
// never actually reaches 0 through that case. This is the vacuous-pass guard
// itself: a budgets file that is ALL comments/blank lines still passes
// validate_budgets_file (nothing malformed to reject) and must still be
// caught before reporting success — the scenario is someone commenting out
// every row to debug and forgetting to restore it.
test("--all exits non-zero on a budgets file containing only comments and blank lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const budgetsFile = join(root, "budgets.txt");
    await writeFile(budgetsFile, "# nothing but comments\n\n   \n# still nothing\n");

    const { exitCode, stderr } = await runCli(budgetsFile, root, "--all");
    expect(stderr).toContain("has no records");
    expect(stderr).toContain(budgetsFile);
    expect(exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// lookup_and_run's single-package path checks the directory exists (via
// resolve_label) before ever consulting the budgets file, and emits a
// polished ::error:: naming it. run_all() built its
// pkg_dir straight from BUDGETS_ROOT/REC_PKG and handed it to run_guard with
// no such check, so a stale or typo'd row surfaced as a raw, unprefixed
// `cd: no such file or directory` from the subshell instead. This asserts
// --all fails closed the same way lookup_and_run does, and — since run_all
// keeps going after a failing row — that a real sibling row still runs.
test("--all exits non-zero, naming the directory, when a row's package directory does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const appBDir = join(root, "fixture-b", "pkg");
    await mkdir(join(appBDir, "dist/_astro"), { recursive: true });
    await writeFile(join(appBDir, "dist/_astro/client.js"), "console.log(1);\n");

    const budgetsFile = join(root, "budgets.txt");
    await writeFile(
      budgetsFile,
      "fixture-a/pkg worker 999999999\nfixture-b/pkg static 999999999\n",
    );

    const { exitCode, stdout, stderr } = await runCli(budgetsFile, root, "--all");
    expect(stderr).toContain("does not exist");
    expect(stderr).toContain(join(root, "fixture-a/pkg"));
    expect(stdout).toContain("fixture-b/pkg dist/_astro gzip total");
    expect(exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
