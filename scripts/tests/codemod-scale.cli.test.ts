/**
 * The pure-function tests beside this one feed `rewriteScales` strings and
 * never touch the filesystem, so they prove nothing about whether the binary
 * walks a tree, writes files, honours `--dry`, or prints a skip report anyone
 * can act on. These run the real script as a subprocess against a throwaway
 * fixture tree, the way `bun run scripts/codemod-scale.ts <app>/src` does.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../codemod-scale.ts", import.meta.url).pathname;

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codemod-scale-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
}

async function run(dir: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args, dir], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

test("rewrites a real file in place", async () => {
  const dir = await fixture({ "src/Card.tsx": '<p class="text-[0.72rem]">x</p>' });
  const { exitCode, stdout } = await run(dir);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("1 value(s) across 1 file(s)");
  expect(await readFile(join(dir, "src/Card.tsx"), "utf8")).toBe('<p class="text-ui-xs">x</p>');
  await rm(dir, { recursive: true });
});

test("--dry changes nothing on disk", async () => {
  const before = '<p class="text-[0.72rem]">x</p>';
  const dir = await fixture({ "src/Card.tsx": before });
  const { stdout } = await run(dir, "--dry");
  expect(stdout).toContain("would rewrite");
  expect(await readFile(join(dir, "src/Card.tsx"), "utf8")).toBe(before);
  await rm(dir, { recursive: true });
});

test("names every computed value it left alone", async () => {
  // The report is the reviewable artefact: "19 computed skipped" has to be
  // visible, or the difference between the total and the rewritten count is
  // something a reader has to notice for themselves.
  const dir = await fixture({
    "src/Hero.tsx": '<h1 class="text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]">',
    "src/Badge.tsx": '<span class="text-[1em]">',
  });
  const { stdout } = await run(dir, "--dry");
  expect(stdout).toContain("1 computed, 1 unmapped");
  expect(stdout).toContain("--invite-heading-scale");
  expect(stdout).toContain("text-[1em]");
  await rm(dir, { recursive: true });
});

test("walks .tsx and .astro, and skips node_modules and dist", async () => {
  const dir = await fixture({
    "src/A.tsx": '<p class="text-[0.72rem]">',
    "src/B.astro": '<p class="text-[0.72rem]">',
    "src/C.ts": 'const x = "text-[0.72rem]";',
    "node_modules/pkg/D.tsx": '<p class="text-[0.72rem]">',
    "dist/E.tsx": '<p class="text-[0.72rem]">',
  });
  const { stdout } = await run(dir);
  expect(stdout).toContain("2 value(s) across 2 file(s)");
  // A `.ts` file can hold a class string, but rewriting one means deciding it
  // is markup rather than data; the two that are unambiguously markup are the
  // ones this touches.
  expect(await readFile(join(dir, "src/C.ts"), "utf8")).toContain("text-[0.72rem]");
  expect(await readFile(join(dir, "node_modules/pkg/D.tsx"), "utf8")).toContain("text-[0.72rem]");
  await rm(dir, { recursive: true });
});

test("is idempotent against a real tree", async () => {
  const dir = await fixture({ "src/A.tsx": '<p class="text-[0.72rem] leading-[1.4]">' });
  await run(dir);
  const once = await readFile(join(dir, "src/A.tsx"), "utf8");
  const { stdout } = await run(dir);
  expect(stdout).toContain("0 value(s) across 0 file(s)");
  expect(await readFile(join(dir, "src/A.tsx"), "utf8")).toBe(once);
  await rm(dir, { recursive: true });
});

test("refuses to run with no path rather than guessing one", async () => {
  const proc = Bun.spawn(["bun", "run", SCRIPT], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(2);
  expect(stderr).toContain("usage:");
});
