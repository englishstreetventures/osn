// The real script as CI runs it, against fixture builds: the import tests in
// check-directory-links.test.ts never reach its `import.meta.main` block,
// which `bun test` leaves dead. With arguments it checks those directories
// instead of the four cire builds, each one both its pages and its scan.
//
// No `bun install`: this only imports `bun:test`, `node:*` and nothing else.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = new URL("../check-directory-links.ts", import.meta.url).pathname;

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

/** A fresh directory holding one built site at `dist/`. */
async function site(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-directory-links-cli-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, "dist", path)), { recursive: true });
    await writeFile(join(root, "dist", path), content);
  }
  return root;
}

test("a slash-less link fails the run and names its file and address", async () => {
  const root = await site({
    "index.html": `<a href="/privacy">Privacy</a> <a href="/terms/">Terms</a>`,
    "privacy/index.html": "<html></html>",
    "terms/index.html": "<html></html>",
  });
  try {
    const { exitCode, stdout, stderr } = await runCli(root, ["dist"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("::error::dist/index.html: /privacy — links /privacy without");
    expect(stderr).not.toContain("/terms —");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean build passes and says what it read", async () => {
  const root = await site({
    "index.html": `<a href="/privacy/">Privacy</a>`,
    "privacy/index.html": `<a href="/privacy/">Privacy</a>`,
  });
  try {
    const { exitCode, stdout, stderr } = await runCli(root, ["dist"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("dist: 1 directory page, 2 files, 2 links in the slash form");
    expect(exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
