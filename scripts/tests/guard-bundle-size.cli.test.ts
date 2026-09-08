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
//   1. total under threshold -> exit 0
//   2. total over threshold -> exit 1, "exceeds the"
//   3. the measured directory missing -> exit 1, "is missing"
//   4. the measured directory holding only excluded files -> exit 1, "holds no
//      deployable files"
//   5. a large *.map beside small real files, sized so counting the map would
//      trip the threshold and excluding it would not -> exit 0
//   6. a *.map under the sibling dist/client -> exit 1
//   7. static mode counts only *.js/*.css, ignoring everything else
//   8. a package-dir with no row in the budgets file -> exit 1, naming the file
//   9. --all runs every row, resolved against BUNDLE_SIZE_BUDGETS_ROOT
//  10. a malformed row (wrong field count / bad mode / non-numeric threshold)
//      -> exit 1, naming the file and line
//  11. blank lines and comment-only lines in the budgets file are ignored
//  12. --all with a row whose package directory does not exist -> exit 1,
//      naming the directory, and still runs the other rows
//
// No `bun install`: this only imports `bun:test` and Node built-ins, matching
// every other file under scripts/ (the `script-tests` CI job runs with none).

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(exitCode).toBe(0);
  });
});

test("exits non-zero when the worker total exceeds the threshold", async () => {
  await withFixture(["fixture-app/pkg worker 0"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    await writeFile(join(pkgDir, "dist/server/entry.mjs"), "export default 1;\n");

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("exceeds the");
    expect(exitCode).not.toBe(0);
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
    await writeFile(join(pkgDir, "dist/server/entry.mjs.map"), "{}");

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain("holds no deployable files");
    expect(exitCode).not.toBe(0);
  });
});

test("excluding *.map is load-bearing: counting it would trip the threshold, excluding it does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-bundle-size-cli-"));
  try {
    const pkgDir = join(root, "fixture-app", "pkg");
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });
    const entryPath = join(pkgDir, "dist/server/entry.mjs");
    const mapPath = join(pkgDir, "dist/server/entry.mjs.map");
    await writeFile(entryPath, "export default 1;\n");
    // Random, so it does not gzip down to nothing — a genuinely large map.
    await writeFile(mapPath, crypto.getRandomValues(new Uint8Array(20000)));

    const entrySize = await gzipSize(entryPath);
    const mapSize = await gzipSize(mapPath);
    // Between the real total alone and the real total plus the map, so
    // counting the map trips it and excluding it does not.
    const threshold = entrySize + Math.floor(mapSize / 2);
    const budgetsFile = join(root, "budgets.txt");
    await writeFile(budgetsFile, `fixture-app/pkg worker ${threshold}\n`);

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(`${entrySize} bytes`);
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
    expect(exitCode).not.toBe(0);
  });
});

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
    await writeFile(budgetsFile, `fixture-app/pkg static ${jsSize}\n`);

    const { exitCode, stdout } = await runCli(budgetsFile, root, pkgDir);
    expect(stdout).toContain(`${jsSize} bytes across 1 files`);
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

test("--all fails, but still reports both apps, when one of two rows is over budget", async () => {
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
    expect(stdout).toContain("fixture-a/pkg dist/server gzip total");
    expect(stdout).toContain("exceeds the");
    expect(stdout).toContain("fixture-b/pkg dist/_astro gzip total");
    expect(exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exits non-zero on a malformed row (wrong field count), naming the file and line", async () => {
  await withFixture(["fixture-app/pkg worker"], async ({ pkgDir, root, budgetsFile }) => {
    await mkdir(join(pkgDir, "dist/server"), { recursive: true });

    const { exitCode, stderr } = await runCli(budgetsFile, root, pkgDir);
    expect(stderr).toContain(budgetsFile);
    expect(stderr).toContain(":1:");
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

      const { exitCode, stderr } = await runCli(budgetsFile, root, pkgDir);
      expect(stderr).toContain("must be a positive integer");
      expect(exitCode).not.toBe(0);
    },
  );
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
