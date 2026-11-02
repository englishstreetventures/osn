// Runs the real script as a subprocess against a fixture repository, pointed
// at it with PLAYWRIGHT_PINS_ROOT, the way `bun run check:playwright-pins` and
// the `script-tests` CI job invoke it. The last test runs it against this repo.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../check-playwright-pins.ts", import.meta.url).pathname;

type Deps = Record<string, string>;

async function run(
  workspaces: Record<string, Deps>,
  root?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const dir = root ?? (await mkdtemp(join(tmpdir(), "playwright-pins-")));
  try {
    if (root === undefined) {
      await writeFile(join(dir, "package.json"), JSON.stringify({ workspaces: ["pkg/*"] }));
      for (const [name, devDependencies] of Object.entries(workspaces)) {
        await mkdir(join(dir, "pkg", name), { recursive: true });
        await writeFile(
          join(dir, "pkg", name, "package.json"),
          JSON.stringify({ name, devDependencies }),
        );
      }
    }
    const proc = Bun.spawn(["bun", "run", SCRIPT], {
      env: { ...Bun.env, PLAYWRIGHT_PINS_ROOT: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (root === undefined) await rm(dir, { recursive: true, force: true });
  }
}

test("fails and names the workspace and specifier when a playwright pin drifts", async () => {
  const { exitCode, stderr } = await run({
    a: { playwright: "1.64.1" },
    b: { playwright: "1.64.1", "@playwright/test": "1.64.1" },
    c: { playwright: "1.62.1" },
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("pkg/c");
  expect(stderr).toContain("playwright@1.62.1");
  expect(stderr).not.toContain("pkg/a");
});

test("fails on a caret range", async () => {
  const { exitCode, stderr } = await run({ a: { playwright: "^1.64.1" } });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("pkg/a");
  expect(stderr).toContain("playwright@^1.64.1");
  expect(stderr).toContain("not an exact version");
});

test("fails when a vitest package drifts from vitest", async () => {
  const { exitCode, stderr } = await run({
    a: { vitest: "5.0.5", "@vitest/browser": "5.0.5" },
    b: { "@vitest/ui": "5.0.4" },
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("pkg/b");
  expect(stderr).toContain("@vitest/ui@5.0.4");
});

test("passes on agreeing exact pins", async () => {
  const { exitCode, stdout, stderr } = await run({
    a: { playwright: "1.64.1", vitest: "5.0.5" },
    b: { "@playwright/test": "1.64.1", "@vitest/ui": "5.0.5" },
  });

  expect(stderr).toBe("");
  expect(stdout).toContain("check-playwright-pins");
  expect(exitCode).toBe(0);
});

test("passes on this repository", async () => {
  const { exitCode, stderr } = await run({}, new URL("../..", import.meta.url).pathname);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
