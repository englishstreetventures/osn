// The tests next door drive `bareRootFrom` with fixture strings and
// `bootstrap` with a plain directory, so none of them runs the part that reads
// git — which is the part that decides whether this script does anything at
// all. A wrong answer there is silent both ways: it would either guard a
// directory nobody starts a session in, or skip the one everybody does.
//
// So these build real repositories with real git and run the real script in
// them: the worktree-holding layout this repository uses locally, and an
// ordinary clone, which must come away untouched.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../bootstrap-bare-root.ts", import.meta.url).pathname;

async function run(
  command: string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  const { exitCode, stderr } = await run(["git", ...args], cwd);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/** A clone with one commit, at `<dir>/origin`. */
async function seedOrigin(dir: string): Promise<string> {
  const origin = join(dir, "origin");
  await mkdir(origin, { recursive: true });
  await git(origin, "init", "--initial-branch=main", ".");
  await writeFile(join(origin, "README.md"), "seed\n");
  await git(origin, "add", "README.md");
  await git(origin, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "seed");
  return origin;
}

/**
 * The local layout: a bare clone at `<dir>/osn.git` whose worktrees are its own
 * subdirectories, `main/` among them.
 */
async function withBareLayout(body: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bootstrap-bare-root-cli-"));
  try {
    const origin = await seedOrigin(dir);
    const root = join(dir, "osn.git");
    await git(dir, "clone", "--bare", origin, root);
    await git(root, "worktree", "add", join(root, "main"), "main");
    await mkdir(join(root, "main", ".claude", "skills", "new-feat"), { recursive: true });
    await writeFile(join(root, "main", ".claude", "skills", "new-feat", "SKILL.md"), "real skill");
    await body(root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("run from the main worktree, it guards the directory above it", async () => {
  await withBareLayout(async (root) => {
    const { exitCode, stdout } = await run(["bun", "run", SCRIPT], join(root, "main"));

    expect(exitCode).toBe(0);
    expect(stdout).toContain("settings: created");
    expect(stdout).toContain("skills: linked");

    const settings = await readFile(join(root, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("bare-root-guard");
    expect(settings).toContain("STOP");
    expect(await readlink(join(root, ".claude", "skills"))).toBe("../main/.claude/skills");
    expect(await readFile(join(root, ".claude", "skills", "new-feat", "SKILL.md"), "utf8")).toBe(
      "real skill",
    );
  });
});

test("a second run reports both as unchanged", async () => {
  await withBareLayout(async (root) => {
    await run(["bun", "run", SCRIPT], join(root, "main"));
    const { exitCode, stdout } = await run(["bun", "run", SCRIPT], join(root, "main"));

    expect(exitCode).toBe(0);
    expect(stdout).toContain("settings: unchanged");
    expect(stdout).toContain("skills: unchanged");
  });
});

// The gate a guard is only worth having once it has been seen to refuse: a
// settings.json that is already there must survive, whatever it holds.
test("it refuses an unreadable settings.json and says the guard is not installed", async () => {
  await withBareLayout(async (root) => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), "{ broken");

    const { exitCode, stdout, stderr } = await run(["bun", "run", SCRIPT], join(root, "main"));

    expect(exitCode).toBe(0);
    expect(stdout).toContain("settings: refused");
    expect(stderr).toContain("NOT installed");
    expect(await readFile(join(root, ".claude", "settings.json"), "utf8")).toBe("{ broken");
  });
});

test("in an ordinary clone it writes nothing and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bootstrap-bare-root-cli-plain-"));
  try {
    const origin = await seedOrigin(dir);
    const clone = join(dir, "osn");
    await git(dir, "clone", origin, clone);

    const { exitCode, stdout } = await run(["bun", "run", SCRIPT], clone);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("nothing to do");
    expect(await Bun.file(join(dir, ".claude", "settings.json")).exists()).toBe(false);
    expect(await Bun.file(join(clone, ".claude", "settings.json")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
