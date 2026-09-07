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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
}

async function run(): Promise<CliRun> {
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
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const card = JSON.parse(
      await Bun.file(join(dir, "out", "feat-metrics-cli-fixture.json")).text(),
    ) as Card;

    return { exitCode, stdout, stderr, card };
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
