// S-H1 (see check-release-age-excludes.cli.test.ts for the pattern this
// mirrors) — the pure-function tests in check-astro-fonts.test.ts import
// `checkAstroFonts` directly and never exercise the `import.meta.main` CLI
// block, so they prove nothing about the real binary CI actually runs
// (`bun run ../../scripts/check-astro-fonts.ts dist` from inside each
// package's `build` script). `bun test` sets `import.meta.main` to `false`
// for every file it loads, so that block is dead code as far as the test
// run above is concerned. These tests run the actual script file as a
// subprocess against a synthetic `dist/`, the same way each package's
// `build` script invokes it.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../check-astro-fonts.ts", import.meta.url).pathname;

async function runCli(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function makeFixture(packageName: string | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-astro-fonts-cli-"));
  if (packageName !== undefined) {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: packageName }));
  }
  return dir;
}

test("the real CLI exits 0 against a fixture dist with fonts and a @font-face rule", async () => {
  const dir = await makeFixture("@cire/host");

  try {
    await mkdir(join(dir, "dist", "_astro", "fonts"), { recursive: true });
    await writeFile(join(dir, "dist", "_astro", "fonts", "abc.woff2"), "fake");
    await writeFile(
      join(dir, "dist", "index.html"),
      `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
    );

    const { exitCode, stdout, stderr } = await runCli(dir, ["dist"]);

    expect(stderr).toBe("");
    expect(stdout).toContain("@cire/host shipped a real font build");
    expect(exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real CLI exits non-zero, naming the package, against an empty fonts dir", async () => {
  const dir = await makeFixture("@cire/vendor");

  try {
    await mkdir(join(dir, "dist", "_astro", "fonts"), { recursive: true });
    await writeFile(
      join(dir, "dist", "index.html"),
      `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
    );

    const { exitCode, stdout, stderr } = await runCli(dir, ["dist"]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("@cire/vendor shipped a fontless build");
    expect(stderr).toContain("is missing or empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real CLI exits non-zero, naming the package, when no @font-face rule was emitted", async () => {
  const dir = await makeFixture("@cire/landing");

  try {
    await mkdir(join(dir, "dist", "_astro", "fonts"), { recursive: true });
    await writeFile(join(dir, "dist", "_astro", "fonts", "abc.woff2"), "fake");
    await writeFile(join(dir, "dist", "index.html"), `<html><body>fontless</body></html>`);

    const { exitCode, stdout, stderr } = await runCli(dir, ["dist"]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("@cire/landing shipped a fontless build");
    expect(stderr).toContain('no "@font-face" rule found');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real CLI exits non-zero when called with no dist argument", async () => {
  const dir = await makeFixture("@cire/host");

  try {
    const { exitCode, stderr } = await runCli(dir, []);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("usage:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real CLI falls back to the cwd when package.json has no name field", async () => {
  const dir = await makeFixture(undefined);

  try {
    await mkdir(join(dir, "dist", "_astro", "fonts"), { recursive: true });
    await writeFile(join(dir, "dist", "_astro", "fonts", "abc.woff2"), "fake");
    await writeFile(
      join(dir, "dist", "index.html"),
      `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
    );

    const { exitCode, stdout } = await runCli(dir, ["dist"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("shipped a real font build");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
