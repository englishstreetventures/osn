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
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
}

async function run(extraArgs: string[] = [], invocations = 1): Promise<CliRun> {
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
        record({
          type: "user",
          timestamp: "2026-09-07T10:02:00.000Z",
          message: { content: "not like that" },
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
          ...extraArgs,
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
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
    }

    const card = JSON.parse(writes[writes.length - 1]!.text) as Card;

    return { exitCode, stdout, stderr, card, writes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the CLI writes a card from a real repo and a real transcript", async () => {
  const { exitCode, card } = await run();

  expect(exitCode).toBe(0);
  expect(card.schema_version).toBe(1);
  expect(card.pr.number).toBe(908);
  expect(card.pr.branch).toBe(BRANCH);
  expect(card.pr.phase).toBe("at-open");
  expect(card.issue.number).toBe(895);
  expect(card.complexity).toEqual({ declared: null, method: "none" });
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

test("the CLI separates the opening brief from a mid-flight correction", async () => {
  const { card } = await run();

  expect(card.interaction.user_turns).toBe(2);
  expect(card.interaction.corrective_turns).toBe(1);
});

test("the CLI charges pre-edit exploration to tokens_before_first_edit", async () => {
  const { card } = await run();

  // The Grep message (100 out + 1M cache read) plus the message that made the
  // first edit (50 out). The subagent's 400 is excluded — a delegated task is
  // not the main thread hunting for the file.
  expect(card.interaction.tokens_before_first_edit).toBe(1_000_150);
});

// `prep-pr` passes whatever the issue carries, so the rating rides along with
// the labels and nobody retypes a number the issue already holds.
test("the CLI reads the declared rating out of the issue labels", async () => {
  const { card } = await run(["--issue-labels", "product:osn-core,complexity:3"]);

  expect(card.complexity).toEqual({ declared: 3, method: "confirmed" });
  expect(card.issue.labels).toEqual(["product:osn-core", "complexity:3"]);
});

test("the CLI keeps an unconfirmed rating marked", async () => {
  const { card } = await run(["--issue-labels", "complexity:5,complexity:unconfirmed"]);

  expect(card.complexity).toEqual({ declared: 5, method: "unconfirmed" });
});

test("the CLI records a hand-passed rating as manual", async () => {
  const { card } = await run(["--complexity", "8"]);

  expect(card.complexity).toEqual({ declared: 8, method: "manual" });
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
    expect(stderr).toContain("wiki/observability/session-metrics.md");
    expect(
      await Bun.file(
        new URL("../../../wiki/observability/session-metrics.md", import.meta.url).pathname,
      ).text(),
    ).toContain("## Attributing subagent spend");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `prep-pr` writes the card, the review adds a commit, and the card is written
// again — so a second run over unchanged inputs is the common case, not the odd
// one. Stamping `generated_at` every time turned each of those into a one-line
// diff with no data behind it.
test("a second run over unchanged inputs leaves the card file alone", async () => {
  const { writes } = await run([], 2);

  expect(writes).toHaveLength(2);
  expect(writes[1]!.text).toBe(writes[0]!.text);
  expect(writes[1]!.mtimeMs).toBe(writes[0]!.mtimeMs);
});
