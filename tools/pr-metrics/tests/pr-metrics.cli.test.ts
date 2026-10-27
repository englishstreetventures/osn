// The pure-function tests feed `aggregateSpend` and friends synthetic records
// and never touch the `import.meta.main` block, so they prove nothing about
// whether the real script finds a transcript on disk, reads a real `git diff`,
// or writes a file anyone can read. These tests run the actual script as a
// subprocess against a throwaway git repository and a throwaway sessions
// directory shaped like `~/.claude/projects`.
//
// The subagent case is the one worth spelling out: subagent transcripts live
// in `<project>/<session-id>/subagents/*.jsonl`, a sibling of the main
// `.jsonl` rather than part of it. A collector that globs only the top level
// silently under-reports every delegated task, and no unit test over
// pre-parsed records can catch that.

import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Card } from "../index";

const SCRIPT = new URL("../index.ts", import.meta.url).pathname;
const BRANCH = "feat/metrics-cli-fixture";

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({ gitBranch: BRANCH, sessionId: "sess-1", ...fields });
}

function assistantRecord(fields: {
  timestamp: string;
  output?: number;
  cacheRead?: number;
  content?: unknown[];
  isSidechain?: boolean;
}): string {
  return record({
    type: "assistant",
    timestamp: fields.timestamp,
    isSidechain: fields.isSidechain ?? false,
    effort: "high",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: fields.content ?? [],
      usage: {
        input_tokens: 0,
        output_tokens: fields.output ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: fields.cacheRead ?? 0,
      },
    },
  });
}

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  card: Card;
  /** The written file after each invocation, in order. */
  writes: { mtimeMs: number; text: string }[];
  /** Every file in the output directory after the last invocation, by name. */
  files: Record<string, string>;
  /** And each one's modification time then. */
  mtimes: Record<string, number>;
}

interface RunOptions {
  /** What a stubbed `gh pr view <n> --json state,mergedAt` prints, by pull
   * request number. Given, the runs see a stub `gh` and no credentials. */
  ghPrView?: Record<number, string>;
}

/**
 * `laterArgs` replaces `extraArgs` from the second invocation on, so a test can
 * prove what a *changed* re-run does. Without it every invocation is identical
 * and `sameApartFromGeneratedAt` alone would explain an untouched file.
 */
async function run(
  extraArgs: string[] = [],
  invocations = 1,
  laterArgs?: string[],
  betweenRuns?: (paths: { outPath: string; sessionsDir: string }) => void | Promise<void>,
  options: RunOptions = {},
): Promise<CliRun> {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-cli-"));

  try {
    // A real repository, because the script shells out to `git diff --numstat`
    // and `git rev-list` rather than being handed a diff.
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");

    await git("checkout", "-qb", BRANCH);
    await mkdir(join(dir, "osn", "api", "src"), { recursive: true });
    await mkdir(join(dir, "wiki"), { recursive: true });
    await writeFile(join(dir, "osn", "api", "src", "auth.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "wiki", "notes.md"), "# notes\n\nbody\n");
    await writeFile(join(dir, "bun.lock"), "lock\n");
    await git("add", ".");
    await git("commit", "-qm", "work");

    // `~/.claude/projects/<encoded-cwd>/` layout, including the subagents
    // subdirectory that holds delegated spend.
    const project = join(dir, "sessions", "-some-encoded-worktree");
    const subagents = join(project, "sess-1", "subagents");
    await mkdir(subagents, { recursive: true });

    await writeFile(
      join(project, "sess-1.jsonl"),
      [
        record({ type: "user", timestamp: "2026-09-07T10:00:00.000Z", message: { content: "go" } }),
        assistantRecord({
          timestamp: "2026-09-07T10:00:30.000Z",
          output: 100,
          cacheRead: 1_000_000,
          content: [{ type: "tool_use", name: "Grep", input: {} }],
        }),
        assistantRecord({
          timestamp: "2026-09-07T10:01:00.000Z",
          output: 50,
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "osn/api/src/auth.ts" } },
          ],
        }),
        // Typed while the agent was working: the harness queues it.
        record({
          type: "attachment",
          timestamp: "2026-09-07T10:01:15.000Z",
          attachment: {
            type: "queued_command",
            prompt: "not like that",
            commandMode: "prompt",
            origin: { kind: "human" },
          },
        }),
        // Queued by a sender the collector does not know: no turn, and a warning.
        record({
          type: "attachment",
          timestamp: "2026-09-07T10:01:20.000Z",
          attachment: {
            type: "queued_command",
            prompt: "sent from somewhere new",
            origin: { kind: "remote-human" },
          },
        }),
        // Typed once the agent had stopped: a new instruction, not an interruption.
        record({
          type: "user",
          timestamp: "2026-09-07T10:02:00.000Z",
          message: { content: "now the docs" },
        }),
        // Machinery that also arrives as role user; must not count as a turn.
        record({
          type: "user",
          timestamp: "2026-09-07T10:02:01.000Z",
          message: { content: "<system-reminder>noise</system-reminder>" },
        }),
        // Another branch's line in the same file — must be ignored.
        JSON.stringify({
          type: "assistant",
          gitBranch: "feat/some-other-branch",
          timestamp: "2026-09-07T10:03:00.000Z",
          message: { model: "claude-opus-5", usage: { output_tokens: 999_999 } },
        }),
        "{ not json at all",
      ].join("\n"),
    );

    await writeFile(
      join(subagents, "agent-abc.jsonl"),
      assistantRecord({
        timestamp: "2026-09-07T10:01:30.000Z",
        output: 400,
        isSidechain: true,
      }),
    );

    // The stub answers `pr view` from `options.ghPrView` and fails every other
    // call. Executable with a shebang, or Bun skips it and resolves the real
    // `gh`; the blanked tokens are the second line of defence, as in
    // `runResolving` below.
    let env: Record<string, string | undefined> | undefined;
    if (options.ghPrView !== undefined) {
      const binDir = join(dir, "bin");
      await mkdir(binDir, { recursive: true });
      const cases = Object.entries(options.ghPrView)
        .map(([n, json]) => `  "pr view ${n} "*) printf '%s' '${json}' ;;`)
        .join("\n");
      await writeFile(
        join(binDir, "gh"),
        `#!/bin/sh\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
      );
      await chmod(join(binDir, "gh"), 0o755);
      expect((await stat(join(binDir, "gh"))).mode & 0o111).toBeGreaterThan(0);
      env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GH_CONFIG_DIR: join(dir, "gh-config"),
        GH_NO_UPDATE_NOTIFIER: "1",
      };
    }

    const outPath = join(dir, "out", "feat-metrics-cli-fixture.json");
    const writes: CliRun["writes"] = [];
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (let attempt = 0; attempt < invocations; attempt += 1) {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          SCRIPT,
          // First, so a test can override a default below: `flag()` reads the
          // first occurrence of a flag.
          ...(attempt === 0 ? extraArgs : (laterArgs ?? extraArgs)),
          "--branch",
          BRANCH,
          "--base",
          "main",
          "--sessions-dir",
          join(dir, "sessions"),
          "--pr",
          "908",
          "--issue",
          "895",
          "--out-dir",
          join(dir, "out"),
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe", env },
      );

      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      writes.push({
        mtimeMs: (await stat(outPath)).mtimeMs,
        text: await Bun.file(outPath).text(),
      });

      if (betweenRuns !== undefined && attempt + 1 < invocations) {
        await betweenRuns({ outPath, sessionsDir: join(dir, "sessions") });
      }
    }

    const card = JSON.parse(writes[writes.length - 1]!.text) as Card;

    const files: Record<string, string> = {};
    const mtimes: Record<string, number> = {};
    for (const name of await readdir(join(dir, "out"))) {
      files[name] = await Bun.file(join(dir, "out", name)).text();
      mtimes[name] = (await stat(join(dir, "out", name))).mtimeMs;
    }

    return { exitCode, stdout, stderr, card, writes, files, mtimes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the CLI writes a card from a real repo and a real transcript", async () => {
  const { exitCode, card } = await run();

  expect(exitCode).toBe(0);
  expect(card.schema_version).toBe(4);
  expect(card.pr.number).toBe(908);
  expect(card.pr.branch).toBe(BRANCH);
  expect(card.pr.phase).toBe("at-open");
  expect(card.issue.number).toBe(895);
  expect(card.complexity).toEqual({ declared: null, method: "none", issues: 0 });
});

test("the CLI counts subagent spend from the sibling directory", async () => {
  const { card } = await run();

  expect(card.spend.by_actor.main.tokens.output).toBe(150);
  expect(card.spend.by_actor.subagent.tokens.output).toBe(400);
  expect(card.spend.tokens.output).toBe(550);
});

test("the CLI ignores records belonging to another branch", async () => {
  const { card } = await run();

  expect(card.spend.tokens.output).toBeLessThan(999_999);
});

test("the CLI buckets the diff by path", async () => {
  const { card } = await run();

  expect(card.diff.loc.source.added).toBe(1);
  expect(card.diff.loc.docs.added).toBe(3);
  expect(card.diff.loc.generated.added).toBe(1);
  expect(card.diff.packages).toEqual(["osn/api"]);
  expect(card.diff.commits).toBe(1);
});

test("the CLI counts only the prompt sent mid-turn as corrective", async () => {
  const { card } = await run();

  expect(card.interaction.user_turns).toBe(3);
  expect(card.interaction.corrective_turns).toBe(1);
});

// A sender the allow-list does not know counts as no turn, which on its own
// would read as "no interruptions". The warning is what makes it visible.
test("the CLI names a queued record's unknown sender", async () => {
  const { stderr } = await run();

  expect(stderr).toContain("unknown sender (remote-human)");
});

test("the CLI charges pre-edit exploration to tokens_before_first_edit", async () => {
  const { card } = await run();

  // The Grep message (100 out + 1M cache read) plus the message that made the
  // first edit (50 out). The subagent's 400 is excluded — a delegated task is
  // not the main thread hunting for the file.
  expect(card.interaction.tokens_before_first_edit).toBe(1_000_150);
});

// `retro` passes whatever the issue carries, so the rating rides along with
// the labels and nobody retypes a number the issue already holds.
test("the CLI reads the declared rating out of the issue labels", async () => {
  const { card } = await run(["--issue-labels", "product:osn-core,complexity:3"]);

  expect(card.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
  expect(card.issue.labels).toEqual(["product:osn-core", "complexity:3"]);
});

test("the CLI keeps an unconfirmed rating marked", async () => {
  const { card } = await run(["--issue-labels", "complexity:5,complexity:unconfirmed"]);

  expect(card.complexity).toEqual({ declared: 5, method: "unconfirmed", issues: 1 });
});

test("the CLI records a hand-passed rating as manual", async () => {
  const { card } = await run(["--complexity", "8"]);

  expect(card.complexity).toEqual({ declared: 8, method: "manual", issues: 0 });
});

test("the CLI refuses to card main", async () => {
  const proc = Bun.spawn(["bun", "run", SCRIPT, "--branch", "main"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("refusing to card `main`");
});

test("the CLI still writes a card when no transcript matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-empty-"));

  try {
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");
    await git("checkout", "-qb", "feat/no-transcript");

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        SCRIPT,
        "--branch",
        "feat/no-transcript",
        "--base",
        "main",
        "--sessions-dir",
        join(dir, "nothing-here"),
        "--out-dir",
        join(dir, "out"),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("no session records matched");

    const card = JSON.parse(await Bun.file(join(dir, "out", "feat-no-transcript.json")).text());
    expect(card.spend.tokens.output).toBe(0);
    expect(card.window.sessions).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- default paths resolve against the repository ---------------------------

// The documented invocation is `bun run --cwd tools/pr-metrics <cmd>`, and
// `--cwd` sets the process working directory. A default of `.claude/metrics`
// resolved against the cwd therefore pointed at `tools/pr-metrics/.claude/
// metrics`: `report` exited 1 on the command printed in its own README, and
// `card` silently created that directory inside the package. The SessionEnd
// hook ends in `|| true`, so every card it wrote went there unnoticed.
test("card writes to the repository root even when run with --cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-cwd-"));

  try {
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };

    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");
    await git("checkout", "-qb", "feat/cwd-fixture");

    // A package subdirectory, standing in for `tools/pr-metrics`.
    await mkdir(join(dir, "tools", "pr-metrics"), { recursive: true });

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        SCRIPT,
        "--branch",
        "feat/cwd-fixture",
        "--base",
        "main",
        "--sessions-dir",
        join(dir, "no-sessions"),
      ],
      // The point of the test: run from inside the package, as `--cwd` does.
      { cwd: join(dir, "tools", "pr-metrics"), stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // At the repository root, not under the package.
    expect(await Bun.file(join(dir, ".claude/metrics/feat-cwd-fixture.json")).exists()).toBe(true);
    expect(
      await Bun.file(join(dir, "tools/pr-metrics/.claude/metrics/feat-cwd-fixture.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Claude Code names a project directory after the session's cwd, with `/` and
 * `.` flattened to `-`. The collector only trusts a `TASK-BRANCH:` marker from a
 * project directory this repository owns, so a fixture has to be named the way
 * a real one would be. `git` resolves symlinks (`/var` → `/private/var` on
 * macOS), so the name comes from git rather than from `mkdtemp`. */
async function projectDirFor(repo: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: repo, stdout: "pipe" });
  const top = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  return top.replaceAll(/[/.]/g, "-");
}

// The unit tests feed `resolveDispatchBranch` a hand-built tree. This one runs
// the real script end to end over a subagent transcript stamped with a
// DIFFERENT branch from the card's — which is the actual shape on disk, and the
// shape the old `gitBranch` match dropped entirely.
test("card attributes a subagent stamped `main` to the branch its dispatch marked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-marker-"));
  const branch = "feat/marker-fixture";

  try {
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");
    await git("checkout", "-qb", branch);
    await mkdir(join(dir, "osn", "api", "src"), { recursive: true });
    await writeFile(join(dir, "osn", "api", "src", "svc.ts"), "export const a = 1;\n");
    await git("add", ".");
    await git("commit", "-qm", "work");

    const project = join(dir, "sessions", await projectDirFor(dir));
    const subagents = join(project, "sess-1", "subagents");
    await mkdir(subagents, { recursive: true });

    // The orchestrator session runs on `main` and dispatches with the marker.
    await writeFile(
      join(project, "sess-1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        gitBranch: "main",
        timestamp: "2026-09-07T10:00:00.000Z",
        requestId: "req-parent",
        message: {
          model: "claude-opus-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_dispatch",
              name: "Agent",
              input: { prompt: `TASK-BRANCH: ${branch}\n\nImplement it.` },
            },
          ],
        },
      })}\n`,
    );

    await writeFile(
      join(subagents, "agent-worker.meta.json"),
      JSON.stringify({ agentType: "implementer", toolUseId: "toolu_dispatch", spawnDepth: 1 }),
    );
    // Stamped `main` — inherited from the parent session, wrong by construction.
    await writeFile(
      join(subagents, "agent-worker.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-1",
          gitBranch: "main",
          isSidechain: true,
          effort: "high",
          requestId: "req-w1",
          timestamp: "2026-09-07T10:01:00.000Z",
          message: { model: "claude-opus-5", usage: { output_tokens: 700 } },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-1",
          gitBranch: "main",
          isSidechain: true,
          effort: "high",
          requestId: "req-w2",
          timestamp: "2026-09-07T10:01:30.000Z",
          message: { model: "claude-opus-5", usage: { output_tokens: 300 } },
        }),
      ].join("\n"),
    );

    const proc = Bun.spawn(
      [
        "bun",
        SCRIPT,
        "--branch",
        branch,
        "--base",
        "main",
        "--sessions-dir",
        join(dir, "sessions"),
        "--out-dir",
        join(dir, "cards"),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    const card = JSON.parse(
      await Bun.file(join(dir, "cards", "feat-marker-fixture.json")).text(),
    ) as Card;

    // The exact sum, not merely non-zero: a non-zero assertion cannot tell a
    // resolved file from a stray record that matched some other way.
    expect(card.spend.tokens.output).toBe(1000);
    expect(card.spend.by_actor.subagent.tokens.output).toBe(1000);
    expect(card.spend.by_actor.main.tokens.output).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The marker is a line a skill asks an agent to write, so nothing enforces it.
// This warning is the whole enforcement story, and it fires on exactly the run
// where the operator has no other signal — the card that came back empty. The
// existing empty-card test points at a directory with no transcripts at all, so
// the count is always 0 and this block never ran.
test("the CLI names unmarked subagent transcripts when a card comes back empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-warn-"));
  const branch = "feat/nothing-matched";

  try {
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    };
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");
    await git("checkout", "-qb", branch);

    // One unmarked subagent under a `main` session: its spend belongs to no card.
    const project = join(dir, "sessions", await projectDirFor(dir));
    const subagents = join(project, "sess-1", "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(
      join(project, "sess-1.jsonl"),
      `${JSON.stringify({ type: "assistant", gitBranch: "main", timestamp: "2026-09-08T10:00:00.000Z" })}\n`,
    );
    await writeFile(
      join(subagents, "agent-orphan.jsonl"),
      `${JSON.stringify({ type: "assistant", gitBranch: "main", isSidechain: true })}\n`,
    );

    const proc = Bun.spawn(
      [
        "bun",
        SCRIPT,
        "--branch",
        branch,
        "--base",
        "main",
        "--sessions-dir",
        join(dir, "sessions"),
        "--out-dir",
        join(dir, "cards"),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    expect(stderr).toContain("no session records matched");
    expect(stderr).toContain("1 subagent transcript(s) carry no TASK-BRANCH marker");
    // The pointer the operator is sent to must exist; a rename would otherwise
    // break it silently.
    expect(stderr).toContain("wiki/conventions/session-metrics.md");
    expect(
      await Bun.file(
        new URL("../../../wiki/conventions/session-metrics.md", import.meta.url).pathname,
      ).text(),
    ).toContain("## Attributing subagent spend");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `retro` writes the card, the review adds a commit, and the card is written
// again — so a second run over unchanged inputs is the common case, not the odd
// one. Stamping `generated_at` every time turned each of those into a one-line
// diff with no data behind it.
test("a second run over unchanged inputs leaves the card file alone", async () => {
  const { writes } = await run([], 2);

  expect(writes).toHaveLength(2);
  expect(writes[1]!.text).toBe(writes[0]!.text);
  expect(writes[1]!.mtimeMs).toBe(writes[0]!.mtimeMs);
});

// The `SessionEnd` hook in `.claude/settings.json` runs the collector with no
// `--pr`, `--issue` or `--issue-labels` — it has no way to know them. Left
// unguarded it therefore overwrites the identity-bearing card `retro` wrote and
// committed with one whose pull request, issue and declared complexity are all
// null, into a working tree nobody looks at while the session is closing.
// `--complexity 8` stands in for that difference here: it genuinely changes the
// card, so an untouched file cannot be explained by the unchanged-inputs rule
// the test above covers.
test("--if-absent leaves an existing card alone even when the new one would differ", async () => {
  const { exitCode, stdout, writes } = await run([], 2, ["--if-absent", "--complexity", "8"]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("--if-absent");
  expect(writes[1]!.text).toBe(writes[0]!.text);
  expect(JSON.parse(writes[1]!.text).complexity.declared).toBeNull();
});

test("without --if-absent the same re-run does rewrite the card", async () => {
  const { writes } = await run([], 2, ["--complexity", "8"]);

  expect(JSON.parse(writes[0]!.text).complexity.declared).toBeNull();
  expect(JSON.parse(writes[1]!.text).complexity.declared).toBe(8);
  expect(JSON.parse(writes[1]!.text).complexity.method).toBe("manual");
});

test("--if-absent writes the card when the branch has none", async () => {
  const { exitCode, card } = await run(["--if-absent"]);

  expect(exitCode).toBe(0);
  expect(card.pr.number).toBe(908);
});

// `--format markdown` writes nothing, so it must never be what `--if-absent`
// skips: `retro` renders the pull-request block with both reachable, on a
// branch whose card it has just written. Drop the `flag("format") !==
// "markdown"` conjunct from the guard and every other test here still passes
// while that block comes out empty on every branch that already has a card.
test("--if-absent never suppresses the markdown render", async () => {
  const { stdout, writes } = await run([], 2, ["--if-absent", "--format", "markdown"]);

  expect(stdout).toContain("<details>");
  expect(stdout).not.toContain("already exists");
  expect(writes[1]!.text).toBe(writes[0]!.text);
});

// The guard asks whether a card is there, and an unreadable file is not one.
// A `SessionEnd` hook killed at its 60s timeout mid-write leaves a truncated
// file; keyed on existence alone the fallback would protect that forever, and
// nothing short of a person running `retro` would repair it. The un-flagged
// path already replaces an unparseable card, and this agrees with it.
test("--if-absent replaces a card that does not parse", async () => {
  const { card, writes } = await run([], 2, ["--if-absent"], ({ outPath }) => {
    require("node:fs").writeFileSync(outPath, '{"schema_version":1,"pr":{"bran');
  });

  expect(writes[1]!.text).not.toBe(writes[0]!.text);
  expect(card.pr.number).toBe(908);
  expect(card.spend).toBeDefined();
});

// A file whose JSON parses but which is not a card is the same case — the
// fallback has no reason to defend it.
test("--if-absent replaces a file that parses but is not a card", async () => {
  const { card } = await run([], 2, ["--if-absent"], ({ outPath }) => {
    require("node:fs").writeFileSync(outPath, '{"schema_version":1}');
  });

  expect(card.pr.number).toBe(908);
  expect(card.interaction).toBeDefined();
});

// `branchSlug` maps `feat/x` and `feat-x` to one filename, and
// `.claude/metrics/` is tracked, so every worktree already holds every merged
// branch's card. Without a branch check `--if-absent` would read a colliding
// neighbour as this branch's card and leave that other branch's spend and tool
// calls standing as this branch's public record — and the hook discards its own
// output, so nothing would say so. The neighbour here names this run's pull
// request, so the write is allowed; the next test covers one that does not.
test("--if-absent replaces a card whose pr.branch is another branch", async () => {
  const { card } = await run([], 2, ["--if-absent"], async ({ outPath }) => {
    const other = JSON.parse(await Bun.file(outPath).text()) as Card;
    other.pr.branch = "feat-metrics-cli-fixture";
    other.spend.usd_equivalent = 999;
    require("node:fs").writeFileSync(outPath, JSON.stringify(other, null, 2));
  });

  expect(card.pr.branch).toBe(BRANCH);
  expect(card.spend.usd_equivalent).not.toBe(999);
});

// The `SessionEnd` fallback runs with `--if-absent`, and a neighbour's card is
// not this branch's, so the early exit does not fire. The card still belongs to
// another pull request, and the fallback must not write over it.
test("--if-absent leaves a slug neighbour's card alone when it names another pull request", async () => {
  let planted = "";
  const { exitCode, stderr, writes } = await run([], 2, ["--if-absent"], async ({ outPath }) => {
    const other = JSON.parse(await Bun.file(outPath).text()) as Card;
    other.pr.branch = "feat-metrics-cli-fixture";
    other.pr.number = 984;
    planted = JSON.stringify(other, null, 2);
    require("node:fs").writeFileSync(outPath, planted);
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("#984");
  expect(writes[1]!.text).toBe(planted);
});

// One branch name, two pull requests: the first one's card is committed, and the
// collector then runs for the second. Transcripts are joined by branch name
// alone, so the first merge is the only thing that separates the two: the
// fixture's records run 10:00:00–10:02:01, and #1 merged at 10:00:45.
const SLUG_FILE = "feat-metrics-cli-fixture.json";
const SECOND_FILE = "feat-metrics-cli-fixture-2.json";
const FIRST_MERGE = "2026-09-07T10:00:45Z";

test("a second pull request on a reused branch name gets its own card, from its own records", async () => {
  const { exitCode, writes, files } = await run(["--pr", "1", "--merged-at", FIRST_MERGE], 2, [
    "--pr",
    "2",
  ]);

  expect(exitCode).toBe(0);
  // The first card keeps its path and its bytes.
  expect(writes[1]!.text).toBe(writes[0]!.text);
  const first = JSON.parse(files[SLUG_FILE]!) as Card;
  expect(first.pr.number).toBe(1);
  expect(first.spend.tokens.output).toBe(550);

  const second = JSON.parse(files[SECOND_FILE]!) as Card;
  expect(second.pr.number).toBe(2);
  // 50 + 400: the edit and the subagent after the merge; the 100 before it is #1's.
  expect(second.spend.tokens.output).toBe(450);
  expect(second.window.first_ts).toBe("2026-09-07T10:01:00.000Z");
});

test("with --resolve-issue the earlier merge time comes from gh", async () => {
  const { exitCode, files } = await run(
    ["--pr", "1"],
    2,
    ["--pr", "2", "--resolve-issue"],
    undefined,
    { ghPrView: { 1: `{"state":"MERGED","mergedAt":"${FIRST_MERGE}"}` } },
  );

  expect(exitCode).toBe(0);
  expect((JSON.parse(files[SECOND_FILE]!) as Card).spend.tokens.output).toBe(450);
});

// `retro` appends this block to the second pull request's body, so it has to
// name the file the card is in.
test("the markdown block on a reused branch name names the second card's file", async () => {
  const { exitCode, stdout, files } = await run(["--pr", "1", "--merged-at", FIRST_MERGE], 2, [
    "--pr",
    "2",
    "--format",
    "markdown",
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain(`.claude/metrics/${SECOND_FILE}`);
  expect(Object.keys(files)).toEqual([SLUG_FILE]);
});

// Refreshing the first card while the second pull request is still open: an
// open pull request comes after every merge, so it bounds the first one's
// records at its merge rather than leaving their order unknown.
test("an earlier card is bounded at its own merge when a later pull request is open", async () => {
  const { exitCode, card } = await run(
    ["--pr", "1"],
    2,
    ["--pr", "1", "--merged-at", FIRST_MERGE, "--resolve-issue"],
    async ({ outPath }) => {
      const later = JSON.parse(await Bun.file(outPath).text()) as Card;
      later.pr.number = 2;
      require("node:fs").writeFileSync(
        outPath.replace(SLUG_FILE, SECOND_FILE),
        JSON.stringify(later),
      );
    },
    { ghPrView: { 2: '{"state":"OPEN","mergedAt":null}' } },
  );

  expect(exitCode).toBe(0);
  expect(card.pr.number).toBe(1);
  expect(card.spend.tokens.output).toBe(100);
  expect(card.window.last_ts).toBe("2026-09-07T10:00:30.000Z");
});

/** Plants a card for pull request #2 at `<slug>-2.json`, merged at
 * 10:01:30, built from the card the first run wrote. */
function plantSecond(fields: { branch?: string; number?: number; mergedAt?: string | null } = {}) {
  return async ({ outPath }: { outPath: string }) => {
    const second = JSON.parse(await Bun.file(outPath).text()) as Card;
    second.pr.number = fields.number ?? 2;
    second.pr.branch = fields.branch ?? BRANCH;
    second.pr.merged_at = fields.mergedAt === undefined ? "2026-09-07T10:01:30Z" : fields.mergedAt;
    require("node:fs").writeFileSync(
      outPath.replace(SLUG_FILE, SECOND_FILE),
      JSON.stringify(second),
    );
  };
}

// The first card refreshed with no `--merged-at`, after the second exists. Its
// own card holds the merge time; dropping it would bound nothing and leave the
// second card's next run with no merge to split at.
test("refreshing the earlier card keeps its merge time and its window", async () => {
  const { exitCode, card } = await run(
    ["--pr", "1", "--merged-at", FIRST_MERGE],
    2,
    ["--pr", "1"],
    plantSecond(),
  );

  expect(exitCode).toBe(0);
  expect(card.pr.merged_at).toBe(FIRST_MERGE);
  expect(card.spend.tokens.output).toBe(100);
  expect(card.window.last_ts).toBe("2026-09-07T10:00:30.000Z");
});

test("an earlier card with no merge time of its own takes it from gh", async () => {
  const { exitCode, card } = await run(
    ["--pr", "1"],
    2,
    ["--pr", "1", "--resolve-issue"],
    plantSecond(),
    { ghPrView: { 1: `{"state":"MERGED","mergedAt":"${FIRST_MERGE}"}` } },
  );

  expect(exitCode).toBe(0);
  expect(card.pr.merged_at).toBe(FIRST_MERGE);
  expect(card.spend.tokens.output).toBe(100);
});

// `feat/metrics-cli-fixture-2` flattens to the file a second pull request on
// `feat/metrics-cli-fixture` takes. That file is another branch's record.
test("the CLI refuses when another branch's card holds the second card's file", async () => {
  let planted = "";
  const { exitCode, stderr, files } = await run(
    ["--pr", "1", "--merged-at", FIRST_MERGE],
    2,
    ["--pr", "2"],
    async (paths) => {
      await plantSecond({ branch: "feat/metrics-cli-fixture-2", number: 984 })(paths);
      planted = await Bun.file(paths.outPath.replace(SLUG_FILE, SECOND_FILE)).text();
    },
  );

  expect(exitCode).toBe(1);
  expect(stderr).toContain("#984");
  expect(stderr).toContain("Another branch name flattens to the same file");
  expect(files[SECOND_FILE]).toBe(planted);
});

test("the CLI refuses a merge time that is not a date on a reused branch name", async () => {
  const { exitCode, stderr, files } = await run(["--pr", "1", "--merged-at", FIRST_MERGE], 2, [
    "--pr",
    "2",
    "--merged-at",
    "yesterday",
  ]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("is not a date");
  expect(Object.keys(files)).toEqual([SLUG_FILE]);
});

// `retro` writes the card, then a review adds a commit and it runs again.
test("a re-run over unchanged inputs leaves the second card's file alone", async () => {
  let afterSecondRun = 0;
  const { exitCode, mtimes } = await run(
    ["--pr", "1", "--merged-at", FIRST_MERGE],
    3,
    ["--pr", "2"],
    async ({ outPath }) => {
      const second = outPath.replace(SLUG_FILE, SECOND_FILE);
      if (await Bun.file(second).exists()) afterSecondRun = (await stat(second)).mtimeMs;
    },
  );

  expect(exitCode).toBe(0);
  expect(afterSecondRun).toBeGreaterThan(0);
  expect(mtimes[SECOND_FILE]).toBe(afterSecondRun);
});

// With no merge time for the earlier pull request, nothing separates the two
// pull requests' sessions. Nothing is written, and the advice is the flag that
// can supply it.
test("the CLI refuses a reused branch name when the earlier merge time is unknown", async () => {
  const { exitCode, stderr, writes, files } = await run(["--pr", "1"], 2, ["--pr", "2"]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("#1's merge time is unknown");
  expect(stderr).toContain("--resolve-issue");
  expect(writes[1]!.text).toBe(writes[0]!.text);
  expect(Object.keys(files)).toEqual([SLUG_FILE]);
});

// `retro` renders the pull-request block from the same run. A refused run must
// not reach the second pull request's body either.
test("the CLI refuses to render the markdown block when the earlier merge time is unknown", async () => {
  const { exitCode, stdout, stderr } = await run(["--pr", "1"], 2, [
    "--pr",
    "2",
    "--format",
    "markdown",
  ]);

  expect(exitCode).toBe(1);
  expect(stdout).not.toContain("<details>");
  // A crash also exits 1 with nothing on stdout; the message is what tells
  // `retro` it was refused, and why.
  expect(stderr).toContain("merge time is unknown");
});

test("the CLI refuses when gh cannot answer for the earlier pull request", async () => {
  const { exitCode, stderr, files } = await run(
    ["--pr", "1"],
    2,
    ["--pr", "2", "--resolve-issue"],
    undefined,
    { ghPrView: {} },
  );

  expect(exitCode).toBe(1);
  expect(stderr).toContain("`gh` did not answer");
  expect(Object.keys(files)).toEqual([SLUG_FILE]);
});

// A pull request closed without merging leaves no merge to split at, so no flag
// can help; the remedy is to treat the two as one piece of work.
test("the CLI refuses when the earlier pull request closed without merging", async () => {
  const { exitCode, stderr, files } = await run(
    ["--pr", "1"],
    2,
    ["--pr", "2", "--resolve-issue"],
    undefined,
    { ghPrView: { 1: '{"state":"CLOSED","mergedAt":null}' } },
  );

  expect(exitCode).toBe(1);
  expect(stderr).toContain("#1 closed without merging");
  expect(stderr).toContain(`delete `);
  expect(Object.keys(files)).toEqual([SLUG_FILE]);
});

// A failed `gh` lookup, or the `SessionEnd` fallback before a pull request
// exists, gives a run with no pull request of its own. It cannot show the card
// on disk is its own, and the fallback's `|| true` would hide the overwrite.
// An empty `--pr` reads as absent, the same as no flag.
test("the CLI refuses a run that names no pull request over a card that names one", async () => {
  const { exitCode, stderr, writes } = await run([], 2, ["--pr", ""]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("names no pull request");
  expect(writes[1]!.text).toBe(writes[0]!.text);
});

// JSON that parses with a `pr` that is not an object is no card a reader could
// use, the same as a truncated file, and is replaced rather than crashed on.
test("the CLI replaces a file whose pr is not an object", async () => {
  const { exitCode, card } = await run([], 2, [], ({ outPath }) => {
    require("node:fs").writeFileSync(
      outPath,
      '{"schema_version":1,"pr":null,"spend":{},"interaction":{}}',
    );
  });

  expect(exitCode).toBe(0);
  expect(card.pr.number).toBe(908);
});

// The fallback's identity-less card names no pull request, and is there to be
// replaced by the one `retro` writes.
test("the CLI replaces a card that names no pull request", async () => {
  const { exitCode, card } = await run([], 2, [], async ({ outPath }) => {
    const fallback = JSON.parse(await Bun.file(outPath).text()) as Card;
    fallback.pr.number = null;
    require("node:fs").writeFileSync(outPath, JSON.stringify(fallback, null, 2));
  });

  expect(exitCode).toBe(0);
  expect(card.pr.number).toBe(908);
});

// The whole point of this branch is a string in `.claude/settings.json`. Drop a
// flag from it in a merge and every test above still passes while the unattended
// fallback resumes clobbering the identity-bearing card — and `>/dev/null 2>&1
// || true` swallows every sign of it.
test("the SessionEnd hook still passes the flags this CLI relies on", async () => {
  const settings = (await Bun.file(
    new URL("../../../.claude/settings.json", import.meta.url).pathname,
  ).json()) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };

  const commands = (settings.hooks.SessionEnd ?? [])
    .flatMap((matcher) => matcher.hooks)
    .map((hook) => hook.command)
    .filter((command) => command.includes("tools/pr-metrics") && command.includes("card"));

  expect(commands).toHaveLength(1);
  // Never overwrite the card `retro` committed with this run's identity-less one.
  expect(commands[0]).toContain("--if-absent");
  // And recover the identity this run was never given, so the card it does
  // write for a fresh branch is not null for ever.
  expect(commands[0]).toContain("--resolve-issue");
});

/**
 * `--resolve-issue` against a stubbed `gh`.
 *
 * Its own fixture, because `run()` always passes `--pr` and `--issue`. Executable
 * with a shebang, or Bun skips the stub and resolves the REAL `gh` further down
 * `PATH` — which would send the test to the network with the developer's
 * credentials. The blanked tokens are the second line of defence for the same
 * reason `backfill.test.ts` blanks them: shadowing fails on a `noexec` TMPDIR,
 * and the fall-through then exits non-zero and fails loudly instead of quietly
 * going online.
 *
 * `labels` maps an issue number in this repository to what `gh issue view <n>
 * --repo <this repository> --json labels` prints; a number missing from it makes
 * that call fail. `trackerLabels` is the same for the private tracker, answered
 * the way the one `gh api graphql` call against it is: every listed issue under
 * its `i<n>` alias, `trackerUnreadable` ones as `null` with a non-zero exit, and
 * `trackerRepository: null` as a repository the token cannot see. The stub
 * writes every call it receives to a log, returned as `calls`.
 */
interface ResolvingOptions {
  /** The pull request `gh pr list` returns; `null` lists none. */
  pull?: { body?: string; refs: { number: number; repo: string }[] } | null;
  labels?: Record<number, string[]>;
  /** Written to `NEW-FEAT.md` at the fixture's root. */
  newFeat?: string;
  extraArgs?: string[];
  /** What `gh repo view` prints; `null` makes the call fail. */
  repoView?: string | null;
  /** A branch the fixture checkout is switched to before the run. */
  checkout?: string;
  trackerLabels?: Record<number, string[]>;
  trackerUnreadable?: number[];
  /** `null`: the tracker answers as a repository this token cannot see. */
  trackerRepository?: null;
}

async function runResolving(
  options: ResolvingOptions,
): Promise<{ card: Card; cardText: string; stdout: string; stderr: string; calls: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-resolve-"));

  try {
    const git = async (...args: string[]) => {
      await Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
    };
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");
    await git("checkout", "-qb", BRANCH);
    await writeFile(join(dir, "work.ts"), "export const a = 1;\n");
    await git("add", ".");
    await git("commit", "-qm", "work");
    if (options.newFeat !== undefined) await writeFile(join(dir, "NEW-FEAT.md"), options.newFeat);
    if (options.checkout !== undefined) await git("checkout", "-qb", options.checkout);

    const pull =
      options.pull === undefined
        ? { body: "", refs: [{ number: 1041, repo: "englishstreetventures/osn" }] }
        : options.pull;
    const listing = JSON.stringify(
      pull === null
        ? []
        : [
            {
              number: 1046,
              body: pull.body ?? "",
              closingIssuesReferences: pull.refs.map(({ number, repo }) => {
                const [login, name] = repo.split("/");

                return { number, repository: { name, owner: { login } } };
              }),
            },
          ],
    );
    const repo = options.repoView ?? "englishstreetventures/osn";
    const issueCases = Object.entries(options.labels ?? {})
      .map(
        ([n, names]) =>
          `  *"issue view ${n} --repo ${repo} "*) printf '%s' '${JSON.stringify({ labels: names.map((name) => ({ name })) })}' ;;`,
      )
      .join("\n");
    const trackerIssues = Object.fromEntries([
      ...Object.entries(options.trackerLabels ?? {}).map(([n, names]) => [
        `i${n}`,
        { labels: { nodes: names.map((name) => ({ name })) } },
      ]),
      ...(options.trackerUnreadable ?? []).map((n) => [`i${n}`, null]),
    ]);
    const trackerAnswer =
      options.trackerRepository === null
        ? `printf '%s' '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND"}]}' ; exit 1`
        : `printf '%s' '${JSON.stringify({ data: { repository: trackerIssues } })}' ; ${
            (options.trackerUnreadable ?? []).length > 0 ? "exit 1" : "exit 0"
          }`;

    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"repo view"*) ${
    options.repoView === null
      ? "exit 1"
      : `printf '%s' '${options.repoView ?? "englishstreetventures/osn"}'`
  } ;;
  *"pr list"*) printf '%s' '${listing}' ;;
  *"api graphql"*"osn-tracker"*) ${trackerAnswer} ;;
${issueCases}
  *) exit 1 ;;
esac
`,
    );
    await chmod(join(binDir, "gh"), 0o755);
    expect((await stat(join(binDir, "gh"))).mode & 0o111).toBeGreaterThan(0);

    const log = join(dir, "gh-calls.log");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        SCRIPT,
        ...(options.extraArgs ?? []),
        "--branch",
        BRANCH,
        "--base",
        "main",
        "--sessions-dir",
        join(dir, "sessions"),
        "--out-dir",
        join(dir, "out"),
        "--resolve-issue",
      ],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GH_CONFIG_DIR: join(dir, "gh-config"),
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_CALL_LOG: log,
        },
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    const cardText = await Bun.file(join(dir, "out", "feat-metrics-cli-fixture.json")).text();
    const card = JSON.parse(cardText) as Card;
    const calls = (await Bun.file(log).text()).split("\n").filter(Boolean);

    return { card, cardText, stdout, stderr, calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The `SessionEnd` fallback fires as a session closes and is given no `--pr`,
// `--issue` or `--issue-labels` — it has no way to know them. Unresolved, the
// card it writes carries a null `complexity.declared` for ever, because nothing
// re-runs the collector once the transcripts go with the container.
test("--resolve-issue recovers the pull request, issue and rating", async () => {
  const { card } = await runResolving({
    labels: { 1041: ["product:shared", "area:ops", "complexity:3"] },
  });

  expect(card.pr.number).toBe(1046);
  expect(card.issue.number).toBe(1041);
  expect(card.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
});

// The one that must not regress. Many of this repository's pull requests close
// a finding in the private `englishstreetventures/osn-tracker`, whose `severity:`/`area:`
// labels must never reach a card committed to a public repository. A pull request
// that links no issue here takes its rating from the tracker issues it closes —
// the `complexity:` pair and nothing else — and names no issue.
const TRACKER = "englishstreetventures/osn-tracker";
const FINDING_LABELS = ["severity:high", "area:security", "product:osn", "needs:decision"];
const leaks = /severity:|area:|needs:|product:osn"/;

test("--resolve-issue rates a tracker-only pull request and carries none of the tracker's other labels", async () => {
  const { card, cardText, stdout, stderr, calls } = await runResolving({
    pull: { body: `Closes ${TRACKER}#1041`, refs: [{ number: 1041, repo: TRACKER }] },
    trackerLabels: { 1041: [...FINDING_LABELS, "complexity:5"] },
  });

  expect(card.issue.number).toBeNull();
  expect(card.issue.labels).toEqual([]);
  expect(card.complexity).toEqual({ declared: 5, method: "confirmed", issues: 1 });
  expect(cardText).not.toMatch(leaks);
  expect(stdout).not.toMatch(leaks);
  expect(stderr).not.toMatch(leaks);
  expect(calls.filter((call) => call.includes("api graphql"))).toHaveLength(1);
  expect(calls.filter((call) => call.includes("issue view"))).toEqual([]);
});

test("--resolve-issue sums the ratings of every tracker issue a tracker-only pull request closes", async () => {
  const { card } = await runResolving({
    pull: {
      body: "",
      refs: [
        { number: 1041, repo: TRACKER },
        { number: 1042, repo: TRACKER },
      ],
    },
    trackerLabels: {
      1041: ["severity:low", "complexity:3"],
      1042: ["area:performance", "complexity:2", "complexity:unconfirmed"],
    },
  });

  expect(card.complexity).toEqual({ declared: 5, method: "unconfirmed", issues: 2 });
  expect(card.issue.labels).toEqual([]);
});

test.each([
  ["a repository it cannot see", { trackerRepository: null }],
  [
    "an issue it cannot resolve",
    { trackerUnreadable: [1042], trackerLabels: { 1041: ["complexity:3"] } },
  ],
] as [string, Partial<ResolvingOptions>][])(
  "--resolve-issue records not-fetched when the token meets %s in the tracker",
  async (_, tracker) => {
    const { card, stderr } = await runResolving({
      pull: {
        body: "",
        refs: [
          { number: 1041, repo: TRACKER },
          { number: 1042, repo: TRACKER },
        ],
      },
      ...tracker,
    });

    expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
    expect(stderr).toContain(`${TRACKER}#1042`);
  },
);

// A stacked pull request has no closing references until it is retargeted to
// `main`, so its body's tracker line is all there is to read.
test("--resolve-issue rates an open pull request from a tracker line in its body alone", async () => {
  const { card } = await runResolving({
    pull: { body: `Closes ${TRACKER}#1041`, refs: [] },
    trackerLabels: { 1041: ["complexity:2", "complexity:unconfirmed"] },
  });

  expect(card.complexity).toEqual({ declared: 2, method: "unconfirmed", issues: 1 });
});

// Beside an issue here the tracker issues are the branch's own review findings,
// filed and fixed on it. They add nothing, so nothing is asked about them.
test("--resolve-issue never asks the tracker about a pull request that closes an issue here", async () => {
  const { card, cardText, calls } = await runResolving({
    pull: {
      body: `Closes #1041\nCloses ${TRACKER}#619`,
      refs: [
        { number: 1041, repo: "englishstreetventures/osn" },
        { number: 619, repo: TRACKER },
      ],
    },
    labels: { 1041: ["product:shared", "complexity:2"] },
    trackerLabels: { 619: [...FINDING_LABELS, "complexity:3"] },
  });

  expect(card.issue.number).toBe(1041);
  expect(card.issue.labels).toEqual(["product:shared", "complexity:2"]);
  expect(card.complexity).toEqual({ declared: 2, method: "confirmed", issues: 1 });
  expect(cardText).not.toMatch(/severity:|area:/);
  expect(calls.filter((call) => call.includes("api graphql"))).toEqual([]);
});

test("--resolve-issue never asks a third repository, and records not-fetched", async () => {
  const { card, calls } = await runResolving({
    pull: { body: "Closes someone/else#5", refs: [] },
  });

  expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
  expect(calls.filter((call) => call.includes("someone") || call.includes("graphql"))).toEqual([]);
});

// A body anyone with write access can edit decides how many tracker issues are
// asked about, and the `SessionEnd` hook that runs this has 60 seconds. A number
// GraphQL cannot take as an `Int` would fail the whole call.
test.each([
  ["more than 50 tracker issues", Array.from({ length: 51 }, (_, i) => 2000 + i)],
  ["a number GraphQL cannot take", [5, 99_999_999_999]],
])("--resolve-issue asks nothing for %s and records not-fetched", async (_, numbers) => {
  const { card, calls } = await runResolving({
    pull: { body: numbers.map((n) => `Closes ${TRACKER}#${n}`).join("\n"), refs: [] },
    trackerLabels: Object.fromEntries(numbers.map((n) => [n, ["complexity:1"]])),
  });

  expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
  expect(calls.filter((call) => call.includes("api graphql"))).toEqual([]);
});

// GitHub lists the issues a pull request closes by number, not by what the
// branch was cut for. Taking the first of that list put a $49.77 session
// against a complexity-1 follow-up it also closed.
test("--resolve-issue names the first Closes line and divides by every closed issue", async () => {
  const { card } = await runResolving({
    pull: {
      body: "## Issues\n\nCloses #1550\nCloses #1031",
      refs: [
        { number: 1031, repo: "englishstreetventures/osn" },
        { number: 1550, repo: "englishstreetventures/osn" },
      ],
    },
    labels: { 1031: ["complexity:1"], 1550: ["product:musubi", "complexity:3"] },
  });

  expect(card.issue.number).toBe(1550);
  expect(card.issue.labels).toEqual(["product:musubi", "complexity:3"]);
  expect(card.complexity).toEqual({ declared: 4, method: "confirmed", issues: 2 });
});

test("--resolve-issue warns and names no issue when nothing says which one is the branch's", async () => {
  const { card, stderr } = await runResolving({
    pull: {
      body: "",
      refs: [
        { number: 1512, repo: "englishstreetventures/osn" },
        { number: 1533, repo: "englishstreetventures/osn" },
      ],
    },
    labels: { 1512: ["complexity:2"], 1533: ["complexity:5"] },
  });

  expect(card.issue.number).toBeNull();
  expect(stderr).toContain("#1512, #1533");
  expect(card.complexity).toEqual({ declared: 7, method: "confirmed", issues: 2 });
});

test("--resolve-issue takes the branch's issue from NEW-FEAT.md when the pull request links it", async () => {
  const { card } = await runResolving({
    pull: {
      body: "Closes #1512\nCloses #1533",
      refs: [
        { number: 1512, repo: "englishstreetventures/osn" },
        { number: 1533, repo: "englishstreetventures/osn" },
      ],
    },
    labels: { 1512: ["complexity:2"], 1533: ["complexity:5"] },
    newFeat: "# NEW-FEAT — feat/metrics-cli-fixture\n\nIssue: #1533\n",
  });

  expect(card.issue.number).toBe(1533);
  expect(card.complexity.declared).toBe(7);
});

test("--resolve-issue reads a Part of line as the issue and declares no rating", async () => {
  const { card } = await runResolving({
    pull: { body: "This branch started from no issue.\n\nPart of #1673", refs: [] },
    labels: { 1673: ["product:shared", "complexity:8"] },
  });

  expect(card.issue.number).toBe(1673);
  expect(card.complexity).toEqual({ declared: null, method: "part-of", issues: 0 });
});

// The shape every orchestrated child pull request has: it closes its own issue
// and advances the epic. The card names and rates the child, and never reads
// the epic's labels — its rating describes the whole series.
test("--resolve-issue names and rates the issue a child closes, not the epic it is Part of", async () => {
  const { card, calls } = await runResolving({
    pull: {
      body: "Part of #1000\n\nCloses #1041",
      refs: [{ number: 1041, repo: "englishstreetventures/osn" }],
    },
    labels: { 1041: ["complexity:2"], 1000: ["epic", "complexity:8"] },
  });

  expect(card.issue.number).toBe(1041);
  expect(card.issue.labels).toEqual(["complexity:2"]);
  expect(card.complexity).toEqual({ declared: 2, method: "confirmed", issues: 1 });
  expect(calls.filter((call) => call.includes("issue view 1000"))).toEqual([]);
});

// `issue view --json labels` answers an issue with no labels with an empty
// list and a failed call with nothing. The two must stay apart: the first is
// a checked issue with no rating, the second a rating nobody could read.
test("--resolve-issue records none for a closed issue with no labels, and names it", async () => {
  const { card, stderr } = await runResolving({
    pull: { body: "Closes #1041", refs: [{ number: 1041, repo: "englishstreetventures/osn" }] },
    labels: { 1041: [] },
  });

  expect(card.complexity).toEqual({ declared: null, method: "none", issues: 0 });
  expect(stderr).toContain("#1041 carries no complexity");
});

test("--resolve-issue records lookup-failed when one closed issue's labels cannot be read", async () => {
  const { card } = await runResolving({
    pull: {
      body: "Closes #1041\nCloses #1042",
      refs: [
        { number: 1041, repo: "englishstreetventures/osn" },
        { number: 1042, repo: "englishstreetventures/osn" },
      ],
    },
    labels: { 1041: ["complexity:2"] },
  });

  expect(card.complexity).toEqual({ declared: null, method: "lookup-failed", issues: 0 });
});

// Without a known repository nothing tells a public issue from a tracker one,
// so no label is read for any of them.
test.each([
  ["fails", null],
  ["answers something that is not owner/name", "3"],
])("--resolve-issue reads no labels when gh repo view %s", async (_, repoView) => {
  const { card, calls } = await runResolving({
    pull: { body: "Closes #1041", refs: [{ number: 1041, repo: "englishstreetventures/osn" }] },
    labels: { 1041: ["complexity:3"] },
    repoView,
  });

  expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
  expect(card.issue.labels).toEqual([]);
  expect(calls.filter((call) => call.includes("issue view"))).toEqual([]);
});

// `--issue` names the issue; labels come only from what the pull request
// closes here. A number named by mistake has nothing read for it.
test("--issue naming an issue the pull request does not close reads none of its labels", async () => {
  const { card, calls } = await runResolving({
    pull: { refs: [{ number: 754, repo: TRACKER }] },
    labels: { 1999: ["complexity:8"] },
    trackerUnreadable: [754],
    extraArgs: ["--issue", "1999"],
  });

  expect(card.issue.number).toBe(1999);
  expect(card.issue.labels).toEqual([]);
  expect(card.complexity.method).toBe("not-fetched");
  expect(calls.filter((call) => call.includes("issue view 1999"))).toEqual([]);
});

// A card is public. `--issue` with the number of another repository's issue
// the pull request links is refused: the card names no issue.
test("--issue naming the tracker issue the pull request closes records no issue", async () => {
  const { card, cardText, calls, stderr } = await runResolving({
    pull: {
      body: `Closes ${TRACKER}#754`,
      refs: [{ number: 754, repo: TRACKER }],
    },
    labels: { 754: ["product:osn-core", "complexity:8"] },
    trackerLabels: { 754: ["severity:high", "complexity:3"] },
    extraArgs: ["--issue", "754"],
  });

  expect(card.issue.number).toBeNull();
  expect(card.issue.labels).toEqual([]);
  expect(card.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
  expect(cardText).not.toMatch(/severity:/);
  expect(calls.filter((call) => call.includes("issue view"))).toEqual([]);
  expect(stderr).toContain("--issue");
});

// NEW-FEAT.md is untracked and survives a branch switch, so it speaks for the
// carded branch only while that branch is checked out.
test("--resolve-issue ignores NEW-FEAT.md when another branch is checked out", async () => {
  const { card } = await runResolving({
    pull: {
      body: "Closes #1512\nCloses #1533",
      refs: [
        { number: 1512, repo: "englishstreetventures/osn" },
        { number: 1533, repo: "englishstreetventures/osn" },
      ],
    },
    labels: { 1512: ["complexity:2"], 1533: ["complexity:5"] },
    newFeat: "# NEW-FEAT — feat/metrics-cli-fixture\n\nIssue: #1533\n",
    checkout: "feat/other",
  });

  expect(card.issue.number).toBe(1512);
});

test("--resolve-issue with no pull request yet records no issue, whatever NEW-FEAT.md says", async () => {
  const { card } = await runResolving({
    pull: null,
    labels: { 1533: ["complexity:5"] },
    newFeat: "# NEW-FEAT — feat/metrics-cli-fixture\n\nIssue: #1533\n",
  });

  expect(card.pr.number).toBeNull();
  expect(card.issue.number).toBeNull();
  expect(card.complexity).toEqual({ declared: null, method: "none", issues: 0 });
});

test("--issue with --resolve-issue fixes the identity and still sums what the pull request closes", async () => {
  const { card } = await runResolving({
    pull: {
      body: "Closes #1512\nCloses #1533",
      refs: [
        { number: 1512, repo: "englishstreetventures/osn" },
        { number: 1533, repo: "englishstreetventures/osn" },
      ],
    },
    labels: { 1512: ["complexity:2"], 1533: ["complexity:5"] },
    extraArgs: ["--issue", "1533"],
  });

  expect(card.pr.number).toBe(1046);
  expect(card.issue.number).toBe(1533);
  expect(card.complexity).toEqual({ declared: 7, method: "confirmed", issues: 2 });
});
