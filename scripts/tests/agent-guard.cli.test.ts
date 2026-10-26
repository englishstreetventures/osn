// The PreToolUse hook in .claude/settings.json runs main's copy of
// scripts/agent-guard.ts. These run the hook's command exactly as
// settings.json holds it, under /bin/sh, against temporary git repositories:
// one whose `origin/main` carries the guard, with a linked worktree on a
// feature branch. Each test gets its own TMPDIR, so nothing a test plants or
// leaves behind reaches another.
//
// Tracker-shaped IDs use the severity letter Q, which no finding uses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GITHUB_WRITE } from "../agent-guard";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const GUARD = join(REPO_ROOT, "scripts/agent-guard.ts");

interface Group {
  readonly matcher: string;
  readonly hooks: readonly { readonly command: string }[];
}

async function groups(): Promise<readonly Group[]> {
  const settings = JSON.parse(await readFile(join(REPO_ROOT, ".claude/settings.json"), "utf8")) as {
    hooks: { PreToolUse?: readonly Group[] };
  };
  return settings.hooks.PreToolUse ?? [];
}

async function hookCommand(): Promise<string> {
  const commands = new Set((await groups()).flatMap((g) => g.hooks.map((h) => h.command)));
  if (commands.size !== 1)
    throw new Error(`expected one PreToolUse command, found ${commands.size}`);
  const [command] = commands;
  if (command === undefined || !command.includes("scripts/agent-guard.ts")) {
    throw new Error("no PreToolUse hook runs scripts/agent-guard.ts");
  }
  return command;
}

function sh(cwd: string, args: readonly string[]): string {
  const result = spawnSync(args[0] ?? "", args.slice(1), { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let base = "";
let repo = "";
let feature = "";
let firstCommit = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "agent-guard-"));
  repo = join(base, "osn");
  feature = join(base, "osn-feature");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, "pkg/src"), { recursive: true });
  const git = (...args: string[]) =>
    sh(repo, ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  firstCommit = git("rev-parse", "HEAD");
  await writeFile(join(repo, "scripts/agent-guard.ts"), await readFile(GUARD, "utf8"));
  await writeFile(join(repo, "bun.lock"), "{}\n");
  await writeFile(join(repo, "pkg/package.json"), "{}\n");
  await writeFile(join(repo, "pkg/src/index.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-q", "-m", "guard");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("worktree", "add", "-q", "-b", "feat/x", feature);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly tmp: string;
}

interface RunOptions {
  /** Extra environment; a value of `null` leaves that variable out. */
  readonly env?: Readonly<Record<string, string | null>>;
  readonly tmp?: string;
  /** The directory Claude Code starts the hook in. */
  readonly cwd?: string;
}

async function environment(options: RunOptions, tmp: string): Promise<Record<string, string>> {
  const env: Record<string, string | null> = {
    PATH: Bun.env.PATH ?? "",
    HOME: Bun.env.HOME ?? "",
    TMPDIR: tmp,
    CLAUDE_PROJECT_DIR: repo,
    ...options.env,
  };
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

async function run(input: unknown, options: RunOptions = {}): Promise<Run> {
  const tmp = options.tmp ?? (await mkdtemp(join(base, "tmp-")));
  const result = spawnSync("/bin/sh", ["-c", await hookCommand()], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    cwd: options.cwd ?? repo,
    env: await environment(options, tmp),
    maxBuffer: 1 << 24,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, tmp };
}

/**
 * Runs the hook with its input piped in by `cat`, as Claude Code writes it, and
 * reports whether the writer was cut off. A hook that exits without reading a
 * payload larger than the pipe buffer leaves `cat` to die of SIGPIPE (141):
 * Claude Code's writer meets the same EPIPE and shows a hook error.
 */
async function runPiped(
  input: unknown,
  options: RunOptions = {},
): Promise<{ readonly status: number | null; readonly stdout: string; readonly cutOff: boolean }> {
  const tmp = options.tmp ?? (await mkdtemp(join(base, "tmp-")));
  const payload = join(tmp, "payload.json");
  await writeFile(payload, JSON.stringify(input));
  const env = await environment(options, tmp);
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'cat "$1" | /bin/sh -c "$2"; s=("${PIPESTATUS[@]}"); echo; echo "${s[0]} ${s[1]}"',
      "piped",
      payload,
      await hookCommand(),
    ],
    {
      encoding: "utf8",
      cwd: options.cwd ?? repo,
      env: { ...env, PATH: `${env.PATH}:/usr/bin:/bin` },
      maxBuffer: 1 << 24,
    },
  );
  const lines = result.stdout.trimEnd().split("\n");
  const [writer, hook] = (lines.pop() ?? "").split(" ").map(Number);
  return { status: hook ?? null, stdout: lines.join("\n").trim(), cutOff: writer !== 0 };
}

const bash = (command: string, cwd = feature) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  cwd,
});

function denial(result: Run): string | null {
  expect(result.status).toBe(0);
  if (result.stdout === "") return null;
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
  return output.hookSpecificOutput.permissionDecisionReason;
}

describe("the hook command", () => {
  test("a refusal prints deny JSON naming the fix", async () => {
    const reason = denial(await run(bash("bun install")));
    expect(reason).toStartWith("agent-guard: ");
    expect(reason).toContain("--frozen-lockfile");
  });

  test("an allowed call prints nothing", async () => {
    expect(denial(await run(bash("ls")))).toBeNull();
    expect(denial(await run(bash("bun install --frozen-lockfile")))).toBeNull();
  });

  test("4. a commit is judged on the branch of the directory it runs in", async () => {
    expect(denial(await run(bash(`cd ${repo} && git commit -m x`)))).toContain("main");
    expect(denial(await run(bash(`git -C ${repo} commit -m x`)))).toContain("main");
    expect(denial(await run(bash("git commit -m x", repo)))).toContain("main");
    expect(denial(await run(bash(`cd ${feature} && git commit -m x`, repo)))).toBeNull();
    expect(denial(await run(bash("git switch -c chore/y && git commit -m x", repo)))).toBeNull();
    expect(denial(await run(bash("git push", repo)))).toContain("main");
    expect(denial(await run(bash("git -c user.name=x commit -m x", repo)))).toContain("main");
    expect(denial(await run(bash("git checkout main && git push")))).toContain("main");
  });

  test("6. a body file is read from the directory the command runs in", async () => {
    await mkdir(join(feature, "sub"), { recursive: true });
    await writeFile(join(feature, "sub/body.md"), "Fixes S-Q9\n");
    expect(denial(await run(bash("cd sub && gh pr edit 1 --body-file body.md")))).toContain(
      "tracker",
    );
    expect(denial(await run(bash("gh pr edit 1 --body-file sub/body.md")))).toContain("tracker");
    expect(
      denial(
        await run(
          bash("gh issue create -R englishstreetventures/osn-tracker --body-file sub/body.md"),
        ),
      ),
    ).toBeNull();
  });

  test("8. a test under a workspace src/ in this repository is refused", async () => {
    const write = (file_path: string) => ({
      tool_name: "Write",
      tool_input: { file_path, content: "x" },
      cwd: feature,
    });
    expect(denial(await run(write(join(feature, "pkg/src/a.test.ts"))))).toContain("tests/");
    expect(denial(await run(write(join(feature, "pkg/tests/a.test.ts"))))).toBeNull();
    const other = await mkdtemp(join(base, "other-"));
    sh(other, ["git", "init", "-q"]);
    await mkdir(join(other, "pkg/src"), { recursive: true });
    await writeFile(join(other, "pkg/package.json"), "{}\n");
    expect(denial(await run(write(join(other, "pkg/src/a.test.ts"))))).toBeNull();
  });

  test("the project is CLAUDE_PROJECT_DIR, not the call's cwd", async () => {
    const elsewhere = await mkdtemp(join(base, "elsewhere-"));
    sh(elsewhere, ["git", "init", "-q"]);
    const write = {
      tool_name: "Write",
      tool_input: { file_path: join(feature, "pkg/src/b.test.ts"), content: "x" },
      cwd: elsewhere,
    };
    expect(denial(await run(write))).toContain("tests/");
  });

  test("17. bad input and unreadable files fail open", async () => {
    expect(denial(await run("not json"))).toBeNull();
    expect(denial(await run({ tool_name: "Bash", cwd: feature }))).toBeNull();
    expect(denial(await run(bash("git commit -F missing.txt")))).toBeNull();
    expect(denial(await run(bash("git commit -m x", base)))).toBeNull();
  });

  const big = () => ({
    tool_name: "Write",
    tool_input: {
      file_path: join(feature, "pkg/src/a.test.ts"),
      content: "x".repeat(200 * 1024),
    },
    cwd: feature,
  });

  test("17. before main carries the guard it lets everything through, and reads a large payload", async () => {
    const result = await runPiped(big(), { env: { AGENT_GUARD_REF: firstCommit } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.cutOff).toBe(false);
  });

  test("17. with no Bun on PATH it lets everything through, and reads a large payload", async () => {
    const bin = await mkdtemp(join(base, "bin-"));
    for (const tool of ["git", "mktemp", "cat", "rm"]) {
      symlinkSync(sh(base, ["sh", "-c", `command -v ${tool}`]), join(bin, tool));
    }
    const result = await runPiped(big(), { env: { PATH: bin } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.cutOff).toBe(false);
  });

  test("the temp directory is removed after each call", async () => {
    const tmp = await mkdtemp(join(base, "clean-"));
    expect(denial(await run(bash("bun install"), { tmp }))).toContain("--frozen-lockfile");
    expect(denial(await run(bash("ls"), { tmp }))).toBeNull();
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("18. main's copy runs, never the checkout's", async () => {
    const marker = join(base, "checkout-copy-ran");
    await writeFile(
      join(repo, "scripts/agent-guard.ts"),
      `await Bun.write(${JSON.stringify(marker)}, "ran");\n`,
    );
    try {
      expect(denial(await run(bash("bun install")))).toContain("--frozen-lockfile");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await writeFile(join(repo, "scripts/agent-guard.ts"), await readFile(GUARD, "utf8"));
    }
  });

  test("19. files planted where the hook starts, or in TMPDIR, never run", async () => {
    const planted = await mkdtemp(join(feature, ".planted-"));
    const tmp = await mkdtemp(join(base, "planted-"));
    const marker = join(base, "planted-ran");
    const writer = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`;
    const blob = sh(repo, ["git", "rev-parse", "origin/main:scripts/agent-guard.ts"]);
    for (const dir of [planted, tmp]) {
      await writeFile(join(dir, "evil.ts"), writer);
      await writeFile(join(dir, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
      // Read by Bun when it loads `.env`: the guard would then judge against
      // a project that does not exist and let the test file through.
      await writeFile(join(dir, ".env"), "CLAUDE_PROJECT_DIR=/nonexistent\n");
    }
    await writeFile(join(tmp, `agent-guard-${blob}.ts`), writer);
    const write = {
      tool_name: "Write",
      tool_input: { file_path: join(feature, "pkg/src/c.test.ts"), content: "x" },
      cwd: planted,
    };
    const result = await run(write, {
      tmp,
      cwd: planted,
      env: { CLAUDE_PROJECT_DIR: null },
    });
    expect(denial(result)).toContain("tests/");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the matchers", () => {
  // Claude Code reads a matcher made only of letters, digits, `_`, `|`, `,`,
  // space and `-` as a list of exact tool names; anything else is a regex.
  const matches = (matcher: string, tool: string) =>
    /^[a-zA-Z0-9_|, -]+$/.test(matcher)
      ? matcher
          .split(/[|,]/)
          .map((name) => name.trim())
          .includes(tool)
      : new RegExp(matcher).test(tool);

  test("settings.json matches GitHub writes with the guard's own pattern", async () => {
    expect((await groups()).map((g) => g.matcher)).toContain(GITHUB_WRITE.source);
  });

  test("each tool the guard reads is matched, and nothing else is", async () => {
    const all = (await groups()).map((g) => g.matcher);
    const matched = (tool: string) => all.some((matcher) => matches(matcher, tool));
    for (const tool of [
      "Bash",
      "Write",
      "Edit",
      "Agent",
      "mcp__github__create_pull_request",
      "mcp__github__update_pull_request",
      "mcp__github__add_issue_comment",
      "mcp__github__issue_write",
      "mcp__github__push_files",
      "mcp__github__merge_pull_request",
    ]) {
      expect(`${tool}: ${matched(tool)}`).toBe(`${tool}: true`);
    }
    for (const tool of [
      "TodoWrite",
      "NotebookEdit",
      "ListAgents",
      "Read",
      "mcp__github__get_me",
      "mcp__github__search_issues",
      "mcp__github__issue_read",
    ]) {
      expect(`${tool}: ${matched(tool)}`).toBe(`${tool}: false`);
    }
  });
});
