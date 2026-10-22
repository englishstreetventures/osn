// The real script, run as a subprocess from the root of a throwaway git
// repository, the way the prep-pr and review-docs skills run it. The pure
// tests in check-wikilinks.test.ts never reach the `import.meta.main` block,
// which decides the exit code and which files count as pages.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "check-wikilinks.ts");

let root = "";

async function page(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function run(): { exitCode: number; stdout: string; stderr: string } {
  // The ceiling stops git from finding a repository above the temp folder.
  const result = Bun.spawnSync(["bun", SCRIPT], {
    cwd: root,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("check-wikilinks CLI", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "check-wikilinks-"));
    git("init", "-q");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a wiki/-prefixed link fails the run and names the file, line and target", async () => {
    await page("wiki/shared/component-library.md", "# Components\n");
    await page(
      "wiki/shared/design-tokens.md",
      "# Tokens\n\nSee [[wiki/shared/component-library]].\n",
    );
    git("add", "-A");

    const { exitCode, stdout } = run();

    expect(stdout).toContain("wiki/shared/design-tokens.md:3: [[wiki/shared/component-library]]");
    expect(stdout).toContain("drop the wiki/ prefix");
    expect(exitCode).toBe(1);
  });

  test("a vault whose links all resolve passes and lists none", async () => {
    await page("wiki/shared/component-library.md", "# Components\n\nSee [[design-tokens]].\n");
    await page("wiki/shared/design-tokens.md", "# Tokens\n\nSee [[shared/component-library]].\n");
    git("add", "-A");

    const { exitCode, stdout } = run();

    expect(stdout).not.toContain("[[");
    expect(exitCode).toBe(0);
  });

  test("a run with no wiki/ folder under the working directory refuses with exit 2", () => {
    const { exitCode, stdout, stderr } = run();

    expect(stdout).toBe("");
    expect(stderr).toContain("wiki/");
    expect(exitCode).toBe(2);
  });

  test("a wiki/ folder git cannot list refuses with exit 2 instead of passing on no pages", async () => {
    await page("wiki/index.md", "# Index\n\n[[nowhere]]\n");
    await rm(join(root, ".git"), { recursive: true, force: true });

    const { exitCode, stdout, stderr } = run();

    expect(stdout).toBe("");
    expect(stderr).toContain("git ls-files failed");
    expect(exitCode).toBe(2);
  });

  test("a page deleted from the working tree but not from the index is not a page", async () => {
    await page("wiki/index.md", "# Index\n\n[[old-page]]\n");
    await page("wiki/shared/old-page.md", "# Old\n");
    git("add", "-A");
    await rm(join(root, "wiki/shared/old-page.md"));

    const { exitCode, stdout } = run();

    expect(stdout).toContain("wiki/index.md:3: [[old-page]]");
    expect(exitCode).toBe(1);
  });

  test("a page git ignores is not a page, and its own links are not checked", async () => {
    await page(".gitignore", "wiki/private/\n");
    await page("wiki/private/notes.md", "# Notes\n\n[[nowhere]]\n");
    await page("wiki/index.md", "# Index\n\n[[private/notes]]\n");
    git("add", "-A");

    const { exitCode, stdout } = run();

    expect(stdout).toContain("wiki/index.md:3: [[private/notes]]");
    expect(stdout).not.toContain("nowhere");
    expect(exitCode).toBe(1);
  });

  test("a new page nobody has staged yet counts as a page", async () => {
    await page("wiki/index.md", "# Index\n\n[[new-page]]\n");
    await page("wiki/shared/new-page.md", "# New\n\n[[index]]\n");

    const { exitCode, stdout } = run();

    expect(stdout).not.toContain("[[");
    expect(exitCode).toBe(0);
  });
});
