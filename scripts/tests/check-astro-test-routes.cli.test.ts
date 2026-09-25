// The general half of the invites bundle-size finding: Astro
// routes every file under `src/pages`, so an un-prefixed `*.test.ts` there is
// built and deployed as a live route. This is the guard for that, run as a
// subprocess against fixture app roots the same way
// scripts/tests/guard-bundle-size.cli.test.ts and
// scripts/tests/cire-dev-db-guard.cli.test.ts do.
//
// The real script's app list is the six committed Astro apps, which this test
// cannot fixture without touching the real repo — `ASTRO_TEST_ROUTE_APPS`
// (checked only by `import.meta.main`, so it has no effect on the
// `findTestRoutes` import test below) overrides it with fixture roots
// instead, the same test-injection idiom check-d1-database-id.ts uses for
// `WRANGLER_TOML`.
//
// No `bun install`: this only imports `bun:test`, `node:fs/promises`, and the
// script under test, matching every other file under scripts/.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findTestRoutes } from "../check-astro-test-routes";

const SCRIPT = new URL("../check-astro-test-routes.ts", import.meta.url).pathname;

async function runCli(
  appsOverride: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ASTRO_TEST_ROUTE_APPS: appsOverride.join(",") },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function withFixtureApp(
  build: (pagesDir: string) => Promise<void>,
  run: (appRoot: string) => Promise<void>,
): Promise<void> {
  const appRoot = await mkdtemp(join(tmpdir(), "astro-test-routes-cli-"));
  try {
    const pagesDir = join(appRoot, "src/pages");
    await mkdir(pagesDir, { recursive: true });
    await build(pagesDir);
    await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

const SUCCESS_LINE = "no test, spec or fixture files routed under any app's src/pages";

test("the real CLI exits 0 when no name under src/pages is a test, spec or fixture", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await writeFile(join(pagesDir, "index.astro"), "<h1>hi</h1>\n");
    },
    async (appRoot) => {
      const { exitCode, stdout, stderr } = await runCli([appRoot]);
      expect(stderr).toBe("");
      expect(stdout).toContain(SUCCESS_LINE);
      expect(exitCode).toBe(0);
    },
  );
});

test("the real CLI exits non-zero on an un-prefixed *.test.ts under src/pages", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await writeFile(
        join(pagesDir, "drift-guard.test.ts"),
        "export const GET = () => new Response('ok');\n",
      );
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toContain("drift-guard.test.ts");
      expect(stderr).toContain("no `_` prefix");
      expect(exitCode).not.toBe(0);
    },
  );
});

test("the real CLI exits non-zero on an un-prefixed *.spec.ts under src/pages", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await writeFile(
        join(pagesDir, "checkout.spec.ts"),
        "export const GET = () => new Response('ok');\n",
      );
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toContain("checkout.spec.ts");
      expect(exitCode).not.toBe(0);
    },
  );
});

// A fixture is test data, not a page, but Astro cannot tell: an un-prefixed
// `fixtures.ts` under src/pages is an endpoint like any other `.ts` file there.
test.each([
  "fixtures.ts",
  "invite.fixture.ts",
  "InviteFixture.ts",
  "guest-fixtures.json",
  "Checkout.Test.ts",
])("the real CLI exits non-zero on an un-prefixed %s under src/pages", async (name) => {
  await withFixtureApp(
    async (pagesDir) => {
      await writeFile(join(pagesDir, name), "export const GET = () => new Response('ok');\n");
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toContain(`src/pages/${name}`);
      expect(stderr).toContain("Rename it");
      expect(exitCode).not.toBe(0);
    },
  );
});

// Every file under an un-prefixed `fixtures/` directory is routed
// (`/fixtures/<name>`), whatever the file itself is called. The directory is
// reported once, not once per file inside it.
test("the real CLI reports an un-prefixed fixtures directory once, not each file in it", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await mkdir(join(pagesDir, "fixtures"), { recursive: true });
      await writeFile(join(pagesDir, "fixtures/data.ts"), "export const GET = () => 1;\n");
      await writeFile(join(pagesDir, "fixtures/b.fixture.ts"), "export const GET = () => 1;\n");
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toContain("src/pages/fixtures/ ");
      expect(stderr.match(/::error::/g)).toHaveLength(1);
      expect(exitCode).not.toBe(0);
    },
  );
});

test("the real CLI exits non-zero on an un-prefixed *.spec.* directory under src/pages", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await mkdir(join(pagesDir, "checkout.spec.d"), { recursive: true });
      await writeFile(join(pagesDir, "checkout.spec.d/index.ts"), "export const GET = () => 1;\n");
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toContain("src/pages/checkout.spec.d/");
      expect(exitCode).not.toBe(0);
    },
  );
});

// `test` and `spec` count only between dots, so an ordinary page whose name
// merely contains the letters is left alone.
test.each([
  "latest.astro",
  "contest.ts",
  "test-drive.astro",
  "inspect.astro",
  "specials/index.astro",
])("the real CLI exits 0 on %s, a page name that only contains test or spec", async (name) => {
  await withFixtureApp(
    async (pagesDir) => {
      await mkdir(join(pagesDir, name, ".."), { recursive: true });
      await writeFile(join(pagesDir, name), "<h1>hi</h1>\n");
    },
    async (appRoot) => {
      const { exitCode, stdout, stderr } = await runCli([appRoot]);
      expect(stderr).toBe("");
      expect(stdout).toContain(SUCCESS_LINE);
      expect(exitCode).toBe(0);
    },
  );
});

test("the real CLI exits 0 on `_`-prefixed fixture files and directories", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await writeFile(join(pagesDir, "_fixtures.ts"), "export const GET = () => 1;\n");
      await mkdir(join(pagesDir, "_fixtures"), { recursive: true });
      await writeFile(
        join(pagesDir, "_fixtures/invite.fixture.ts"),
        "export const GET = () => 1;\n",
      );
    },
    async (appRoot) => {
      const { exitCode, stdout, stderr } = await runCli([appRoot]);
      expect(stderr).toBe("");
      expect(stdout).toContain(SUCCESS_LINE);
      expect(exitCode).toBe(0);
    },
  );
});

// Astro follows a symlink under src/pages and routes what it points at,
// whatever that is called, so the check refuses any link it would walk past.
test.each([
  ["a file", "about.astro", false],
  ["a directory", "weddings", true],
] as const)(
  "the real CLI exits non-zero on an un-prefixed symlink to %s under src/pages",
  async (_label, linkName, isDir) => {
    await withFixtureApp(
      async (pagesDir) => {
        const target = join(pagesDir, "..", isDir ? "elsewhere" : "elsewhere.astro");
        if (isDir) {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "drift-guard.test.ts"), "export const GET = () => 1;\n");
        } else {
          await writeFile(target, "<h1>hi</h1>\n");
        }
        await symlink(target, join(pagesDir, linkName));
      },
      async (appRoot) => {
        const { exitCode, stderr } = await runCli([appRoot]);
        expect(stderr).toContain(`src/pages/${linkName}`);
        expect(stderr).toContain("symlink");
        expect(exitCode).not.toBe(0);
      },
    );
  },
);

test("the real CLI exits 0 on a `_`-prefixed symlink under src/pages", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      const target = join(pagesDir, "..", "elsewhere");
      await mkdir(target, { recursive: true });
      await symlink(target, join(pagesDir, "_linked"));
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
  );
});

test("the real CLI exits 0 on a *.test.ts file whose own name is `_`-prefixed", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await writeFile(
        join(pagesDir, "_drift-guard.test.ts"),
        "export const GET = () => new Response('ok');\n",
      );
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
  );
});

test("the real CLI exits 0 on a *.test.ts file inside a `_`-prefixed directory", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await mkdir(join(pagesDir, "_tests"), { recursive: true });
      await writeFile(
        join(pagesDir, "_tests/drift-guard.test.ts"),
        "export const GET = () => new Response('ok');\n",
      );
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
  );
});

test("a violation nested under an ordinary subdirectory is still found", async () => {
  await withFixtureApp(
    async (pagesDir) => {
      await mkdir(join(pagesDir, "weddings"), { recursive: true });
      await writeFile(
        join(pagesDir, "weddings/drift-guard.test.ts"),
        "export const GET = () => new Response('ok');\n",
      );
    },
    async (appRoot) => {
      const { exitCode, stderr } = await runCli([appRoot]);
      expect(stderr).toContain("weddings/drift-guard.test.ts");
      expect(exitCode).not.toBe(0);
    },
  );
});

test("the real CLI checks every app in the override list, not just the first", async () => {
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), "astro-test-routes-cli-")),
    mkdtemp(join(tmpdir(), "astro-test-routes-cli-")),
  ]);
  try {
    await mkdir(join(roots[0]!, "src/pages"), { recursive: true });
    await mkdir(join(roots[1]!, "src/pages"), { recursive: true });
    await writeFile(join(roots[0]!, "src/pages/index.astro"), "<h1>hi</h1>\n");
    await writeFile(
      join(roots[1]!, "src/pages/drift-guard.test.ts"),
      "export const GET = () => new Response('ok');\n",
    );

    const { exitCode, stderr } = await runCli(roots);
    expect(stderr).toContain("drift-guard.test.ts");
    expect(exitCode).not.toBe(0);
  } finally {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  }
});

test("findTestRoutes returns [] against a src/pages directory that does not exist", async () => {
  const violations = await findTestRoutes(
    join(tmpdir(), "astro-test-routes-does-not-exist", "src/pages"),
  );
  expect(violations).toEqual([]);
});

test("the real CLI exits non-zero, naming the path, when a configured app's src/pages does not exist", async () => {
  const { exitCode, stderr } = await runCli(["definitely/does-not-exist"]);
  expect(stderr).toContain("definitely/does-not-exist's src/pages does not exist");
  expect(stderr).toContain("src/pages");
  expect(exitCode).not.toBe(0);
});

// ASTRO_TEST_ROUTE_APPS uses `?? DEFAULT_ASTRO_APPS`, which only falls back on
// undefined/null — set to "", `.split(",").filter(Boolean)` reduces it to
// `[]`, and without the guard added for this finding the for loop below would
// just never run, `failed` would stay false, and the success banner would
// print having checked zero apps. `runCli([])` joins to the empty string, the
// same value the CLI test harness itself could produce by accident.
test("the real CLI exits non-zero when the app override list is empty", async () => {
  const { exitCode, stdout, stderr } = await runCli([]);
  expect(stderr).toContain("empty list");
  expect(stdout).not.toContain(SUCCESS_LINE);
  expect(exitCode).not.toBe(0);
});

// Pins the DEFAULT (unset ASTRO_TEST_ROUTE_APPS) relative-join resolution
// against the real repo, rather than a fixture — every other test above
// overrides ASTRO_TEST_ROUTE_APPS, so none of them exercise
// `resolvePagesDir`'s `new URL("../${app}/src/pages", import.meta.url)`
// branch, the one a future scripts/ reorganisation could silently break. If
// that join ever stops landing on cire/invites' real `src/pages`, the new
// pagesDirIsMissing() check added for this same finding turns this red
// instead of the old silent-success behavior.
test("the real CLI resolves the default apps' real src/pages with no override set", async () => {
  const env = { ...Bun.env };
  delete env.ASTRO_TEST_ROUTE_APPS;
  const proc = Bun.spawn(["bun", "run", SCRIPT], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).not.toContain("does not exist");
  expect(stdout).toContain("check-astro-test-routes");
  expect(exitCode).toBe(0);
});
