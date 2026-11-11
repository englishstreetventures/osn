// scripts/queue-sim.sh, one test per way it can fail. It is the check run
// before the owner queues a stack: GitHub's mergeable badge compares each pull
// request with its own base branch, while the merge queue squashes each one's
// own diff onto `main` in order, so a stack can read clean on every pull
// request and still conflict in the queue. A simulation that says OK when the
// queue would refuse, or that moves a ref or leaves a worktree behind, is worse
// than none. Each case builds a throwaway repository with a bare `origin`, so
// the script's fetch runs offline.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case runs a dozen git commands and one script that adds a worktree.
setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, "..", "queue-sim.sh");

const scratch = mkdtempSync(join(tmpdir(), "queue-sim-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

let next = 0;

interface Repo {
  /** The clone the script runs in, standing in for a worktree. */
  readonly work: string;
  /** A TMPDIR of the case's own, so a scratch directory left behind shows. */
  readonly tmp: string;
  /** Write `content` to `file` on `branch` (checked out from `from` when new), commit and push it. */
  commit(branch: string, file: string, content: string, from?: string): void;
}

/** A bare `origin` and a clone of it, with `main` holding `table.md` and `notes.md`. */
function repo(): Repo {
  next += 1;
  const root = mkdtempSync(join(scratch, `case-${next}-`));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "table.md"), "| row | value |\n|---|---|\n| a | 1 |\n| b | 2 |\n");
  writeFileSync(join(work, "notes.md"), "first\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "main");

  return {
    work,
    tmp,
    commit(branch, file, content, from) {
      const exists =
        Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
          cwd: work,
        }).exitCode === 0;
      git(work, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, from ?? "main"]));
      writeFileSync(join(work, file), content);
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", `${branch}: ${file}`);
      git(work, "push", "-q", "origin", branch);
      git(work, "checkout", "-q", "main");
    },
  };
}

/** The usual stack: `a` adds a.txt, `b` on it adds b.txt, `c` on it edits `table.md` row b. */
function stack(r: Repo): void {
  r.commit("feat/a", "a.txt", "a\n");
  r.commit("feat/b", "b.txt", "b\n", "feat/a");
  r.commit("feat/c", "table.md", "| row | value |\n|---|---|\n| a | 1 |\n| b | 3 |\n", "feat/b");
}

/** Everything the script must leave as it found it. */
function snapshot(work: string): string {
  return [
    git(work, "rev-parse", "HEAD"),
    git(work, "symbolic-ref", "HEAD"),
    git(work, "for-each-ref", "refs/heads"),
    git(work, "status", "--porcelain"),
    git(work, "worktree", "list", "--porcelain"),
    git(work, "stash", "list"),
    readFileSync(join(work, ".git", "config"), "utf8"),
  ].join("\n--\n");
}

async function run(
  r: Repo,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: r.work,
    env: { ...GIT_ENV, TMPDIR: r.tmp, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

/** The verdict lines, `<WORD> <branch>`, in order. */
const verdicts = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => line.match(/^(OK|CONFLICT|SKIPPED)\s+(\S+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => `${m[1]} ${m[2]}`);

describe("queue-sim.sh", () => {
  test("a stack that merges cleanly in order is OK at every layer, exit 0", async () => {
    const r = repo();
    stack(r);

    const { exitCode, output } = await run(r, ["feat/a", "feat/b", "feat/c"]);

    expect(verdicts(output)).toEqual(["OK feat/a", "OK feat/b", "OK feat/c"]);
    expect(exitCode).toBe(0);
  });

  test("a layer that is clean against its parent but conflicts with main is CONFLICT, naming the file", async () => {
    const r = repo();
    stack(r);
    // main changes the row feat/c changes, after the stack was cut. Each pull
    // request is still clean against its own base branch.
    r.commit("main", "table.md", "| row | value |\n|---|---|\n| a | 1 |\n| b | 9 |\n");

    const { exitCode, output } = await run(r, ["feat/a", "feat/b", "feat/c"]);

    expect(verdicts(output)).toEqual(["OK feat/a", "OK feat/b", "CONFLICT feat/c"]);
    expect(output).toMatch(/^\s+table\.md$/m);
    expect(exitCode).toBe(1);
  });

  test("the layers above a conflict are SKIPPED, never OK", async () => {
    const r = repo();
    r.commit("feat/a", "notes.md", "first, from a\n");
    r.commit("feat/b", "b.txt", "b\n", "feat/a");
    r.commit("feat/c", "c.txt", "c\n", "feat/b");
    r.commit("main", "notes.md", "first, from main\n");

    const { exitCode, output } = await run(r, ["feat/a", "feat/b", "feat/c"]);

    expect(verdicts(output)).toEqual(["CONFLICT feat/a", "SKIPPED feat/b", "SKIPPED feat/c"]);
    expect(output).toMatch(/^\s+notes\.md$/m);
    expect(exitCode).toBe(1);
  });

  test("it moves no ref, changes no file and leaves no worktree, after a pass and after a conflict", async () => {
    const r = repo();
    stack(r);
    git(r.work, "checkout", "-q", "feat/b");
    writeFileSync(join(r.work, "uncommitted.txt"), "someone's work\n");
    const before = snapshot(r.work);

    const pass = await run(r, ["feat/a", "feat/b", "feat/c"]);
    expect(pass.exitCode).toBe(0);
    expect(snapshot(r.work)).toBe(before);
    expect(readdirSync(r.tmp)).toEqual([]);

    r.commit("main", "table.md", "| row | value |\n|---|---|\n| a | 1 |\n| b | 9 |\n");
    git(r.work, "checkout", "-q", "feat/b");
    const beforeConflict = snapshot(r.work);

    const conflict = await run(r, ["feat/a", "feat/b", "feat/c"]);
    expect(conflict.exitCode).toBe(1);
    expect(snapshot(r.work)).toBe(beforeConflict);
    expect(readdirSync(r.tmp)).toEqual([]);
  });

  test("a layer with no changes of its own is OK, not an error", async () => {
    const r = repo();
    r.commit("feat/a", "a.txt", "a\n");
    git(r.work, "branch", "feat/empty", "feat/a");
    git(r.work, "push", "-q", "origin", "feat/empty");

    const { exitCode, output } = await run(r, ["feat/a", "feat/empty"]);

    expect(verdicts(output)).toEqual(["OK feat/a", "OK feat/empty"]);
    expect(exitCode).toBe(0);
  });

  test("a branch the remote does not have is refused with exit 2, naming it, and nothing is left behind", async () => {
    const r = repo();
    r.commit("feat/a", "a.txt", "a\n");
    const before = snapshot(r.work);

    const { exitCode, output } = await run(r, ["feat/a", "feat/missing"]);

    expect(exitCode).toBe(2);
    expect(output).toContain("feat/missing");
    expect(verdicts(output)).toEqual([]);
    expect(snapshot(r.work)).toBe(before);
    expect(readdirSync(r.tmp)).toEqual([]);
  });

  test("no arguments prints the usage and exits 2", async () => {
    const r = repo();
    const before = snapshot(r.work);

    const { exitCode, output } = await run(r, []);

    expect(exitCode).toBe(2);
    expect(output).toMatch(/usage/i);
    expect(snapshot(r.work)).toBe(before);
  });

  test("a child that still holds its squash-merged parent's commits conflicts once main moves past them", async () => {
    const r = repo();
    const parentTable = "| row | value |\n|---|---|\n| a | 1 |\n| b | 2 |\n| c | 3 |\n";
    r.commit("feat/parent", "table.md", parentTable);
    r.commit("feat/child", "child.txt", "child\n", "feat/parent");
    // The queue squashes the parent onto main; then another pull request
    // edits the row the parent added.
    r.commit("main", "table.md", parentTable);
    r.commit("main", "table.md", "| row | value |\n|---|---|\n| a | 1 |\n| b | 2 |\n| c | 4 |\n");

    const { exitCode, output } = await run(r, ["feat/child"]);

    expect(verdicts(output)).toEqual(["CONFLICT feat/child"]);
    expect(output).toMatch(/^\s+table\.md$/m);
    expect(exitCode).toBe(1);
  });

  describe("pull request numbers, read through gh", () => {
    /**
     * A stand-in for `gh api <path> [--jq <filter>]`: answers from
     * `<dir>/<path with / ? & = : turned into _>.json`, through `jq -r`.
     */
    function fakeGh(r: Repo, answers: Record<string, unknown>): Record<string, string> {
      const dir = join(r.tmp, "..", "gh");
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      for (const [path, body] of Object.entries(answers)) {
        writeFileSync(join(dir, `${path.replace(/[/?&=:]/g, "_")}.json`), JSON.stringify(body));
      }
      writeFileSync(
        join(bin, "gh"),
        `#!/usr/bin/env bash
[ "$1" = api ] || exit 9
path=$2; shift 2
file="${dir}/$(printf '%s' "$path" | tr '/?&=:' '_____').json"
[ -f "$file" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ "\${1:-}" = --jq ]; then jq -r "$2" "$file"; else cat "$file"; fi
`,
      );
      chmodSync(join(bin, "gh"), 0o755);
      return { PATH: `${bin}:${process.env.PATH}`, QUEUE_SIM_REPO: "acme/app" };
    }

    const pull = (number: number, head: string, base: string, stackNumber: number | null) => ({
      number,
      head: { ref: head },
      base: { ref: base },
      stack: stackNumber === null ? null : { number: stackNumber, position: 0, size: 0 },
    });

    test("each pull request is diffed against its own base branch, whatever comes before it", async () => {
      const r = repo();
      // feat/two is based on feat/one and edits the row feat/one changed.
      r.commit("feat/one", "table.md", "| row | value |\n|---|---|\n| a | 5 |\n| b | 2 |\n");
      r.commit(
        "feat/two",
        "table.md",
        "| row | value |\n|---|---|\n| a | 6 |\n| b | 2 |\n",
        "feat/one",
      );
      const env = fakeGh(r, {
        "repos/acme/app/pulls/11": pull(11, "feat/one", "main", null),
        "repos/acme/app/pulls/12": pull(12, "feat/two", "feat/one", null),
      });

      // Alone, its own diff (5 -> 6) meets main's 1: the queue would refuse it.
      const alone = await run(r, ["12"], env);
      expect(verdicts(alone.output)).toEqual(["CONFLICT feat/two"]);
      expect(alone.exitCode).toBe(1);

      const both = await run(r, ["11", "12"], env);
      expect(verdicts(both.output)).toEqual(["OK feat/one", "OK feat/two"]);
      expect(both.output).toMatch(/feat\/one\s+\(#11\)/);
      expect(both.output).toMatch(/feat\/two\s+\(#12\)/);
      expect(both.exitCode).toBe(0);
    });

    test("--stack lists the registered stack bottom to top from any pull request in it", async () => {
      const r = repo();
      stack(r);
      r.commit("main", "table.md", "| row | value |\n|---|---|\n| a | 1 |\n| b | 9 |\n");
      const env = fakeGh(r, {
        "repos/acme/app/pulls/22": pull(22, "feat/b", "feat/a", 7),
        "repos/acme/app/pulls?state=open&head=acme:feat/a": [pull(21, "feat/a", "main", 7)],
        "repos/acme/app/pulls?state=open&base=feat/b": [
          pull(30, "feat/unrelated", "feat/b", null),
          pull(23, "feat/c", "feat/b", 7),
        ],
        "repos/acme/app/pulls?state=open&base=feat/c": [],
      });

      const { exitCode, output } = await run(r, ["--stack", "22"], env);

      expect(verdicts(output)).toEqual(["OK feat/a", "OK feat/b", "CONFLICT feat/c"]);
      expect(output).toMatch(/feat\/a\s+\(#21\)/);
      expect(output).toMatch(/feat\/c\s+\(#23\)/);
      expect(exitCode).toBe(1);
    });

    test("--stack on a pull request in no registered stack exits 2", async () => {
      const r = repo();
      r.commit("feat/a", "a.txt", "a\n");
      const env = fakeGh(r, { "repos/acme/app/pulls/5": pull(5, "feat/a", "main", null) });

      const { exitCode, output } = await run(r, ["--stack", "5"], env);

      expect(exitCode).toBe(2);
      expect(output).toMatch(/not in a registered stack/);
      expect(verdicts(output)).toEqual([]);
      expect(readdirSync(r.tmp)).toEqual([]);
    });
  });
});
