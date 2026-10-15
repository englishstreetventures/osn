// Runs scripts/lockfile-evidence.sh as a subprocess inside a throwaway git
// repository: a merge base, a `main` commit after it, and a branch head, each
// with its own bun.lock and workspace manifest, then a working-tree bun.lock
// standing in for the regenerated file.
//
// One case per decision the script makes:
//   a missing or unresolvable commit argument → 3, before reading anything
//   a regeneration that moves only the branch's package → 0, and each section
//     shows exactly that package
//   an entry for another platform dropped from the regenerated file → shown
//     as removed against main, so a reader sees it
//   the same name@version with a different source or integrity → 1, naming it

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../lockfile-evidence.sh", import.meta.url).pathname;

let repo: string;

function entry(name: string, version: string, integrity = `sha512-${name}${version}`): string {
  return `    "${name}": ["${name}@${version}", "", {}, "${integrity}"],`;
}

function lock(...entries: readonly string[]): string {
  return [
    "{",
    '  "lockfileVersion": 1,',
    '  "workspaces": {},',
    '  "packages": {',
    ...entries.flatMap((e) => [e, ""]),
    "  }",
    "}",
    "",
  ].join("\n");
}

function manifest(deps: Record<string, string>): string {
  return `${JSON.stringify({ name: "@x/pkg", dependencies: deps }, null, 2)}\n`;
}

async function git(...args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

async function commit(
  lockText: string,
  deps: Record<string, string>,
  message: string,
): Promise<string> {
  await writeFile(join(repo, "bun.lock"), lockText);
  await writeFile(join(repo, "pkg", "package.json"), manifest(deps));
  await git("add", "-A");
  await git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

async function run(...args: readonly string[]) {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

// Merge base: a@1, b@1 and a platform binary. Main then adds c@1. The branch,
// from the merge base, moves a to 2.
let mb: string;
let orig: string;
let main: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "lockfile-evidence-"));
  await mkdir(join(repo, "pkg"));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  mb = await commit(
    lock(entry("a", "1.0.0"), entry("b", "1.0.0"), entry("@x/linux-x64", "1.0.0")),
    { a: "1.0.0" },
    "base",
  );
  main = await commit(
    lock(
      entry("a", "1.0.0"),
      entry("b", "1.0.0"),
      entry("@x/linux-x64", "1.0.0"),
      entry("c", "1.0.0"),
    ),
    { a: "1.0.0", c: "^1.0.0" },
    "main moves on",
  );
  await git("checkout", "-q", "-b", "feat", mb);
  orig = await commit(
    lock(entry("a", "2.0.0"), entry("b", "1.0.0"), entry("@x/linux-x64", "1.0.0")),
    { a: "2.0.0" },
    "bump a",
  );
  await git("checkout", "-q", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function regenerated(...entries: readonly string[]) {
  await writeFile(join(repo, "bun.lock"), lock(...entries));
  await writeFile(join(repo, "pkg", "package.json"), manifest({ a: "2.0.0", c: "^1.0.0" }));
}

test("a missing or unresolvable commit argument is refused before anything is read", async () => {
  expect((await run()).exitCode).toBe(3);
  expect((await run(mb)).exitCode).toBe(3);
  const r = await run(mb, "0000000000000000000000000000000000000000", "main");
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain("not a commit");
});

test("a regeneration that moves only the branch's package exits 0 and shows only that package", async () => {
  await regenerated(
    entry("a", "2.0.0"),
    entry("b", "1.0.0"),
    entry("@x/linux-x64", "1.0.0"),
    entry("c", "1.0.0"),
  );
  const r = await run(mb, orig, "main");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("main changed bun.lock since the merge base: yes");
  expect(r.stdout).toContain("the branch changed bun.lock since the merge base: yes");
  expect(r.stdout).toMatch(
    /== resolved packages, main → working tree[^=]*- a@1\.0\.0\n\+ a@2\.0\.0/,
  );
  expect(r.stdout).toMatch(
    /== resolved packages, merge base → branch head[^=]*- a@1\.0\.0\n\+ a@2\.0\.0/,
  );
  expect(r.stdout).toContain('"a": "2.0.0"');
  expect(r.stdout).not.toContain("c@1.0.0");
  expect(r.stdout).toContain("same name@version, different entry: none");
});

test("a platform entry dropped by the regeneration is listed as removed against main", async () => {
  await regenerated(entry("a", "2.0.0"), entry("b", "1.0.0"), entry("c", "1.0.0"));
  const r = await run(mb, orig, "main");
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toMatch(/== resolved packages, main → working tree[^=]*- @x\/linux-x64@1\.0\.0/);
});

test("the same name@version with a different integrity exits 1 and names it", async () => {
  await regenerated(
    entry("a", "2.0.0"),
    entry("b", "1.0.0", "sha512-somethingelse"),
    entry("@x/linux-x64", "1.0.0"),
    entry("c", "1.0.0"),
  );
  const r = await run(mb, orig, "main");
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toMatch(/same name@version, different entry:\n\s*b@1\.0\.0/);
});

test("the main ref defaults to origin/main", async () => {
  await git("update-ref", "refs/remotes/origin/main", main);
  await regenerated(
    entry("a", "2.0.0"),
    entry("b", "1.0.0"),
    entry("@x/linux-x64", "1.0.0"),
    entry("c", "1.0.0"),
  );
  const r = await run(mb, orig);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("main ref: origin/main");
});
