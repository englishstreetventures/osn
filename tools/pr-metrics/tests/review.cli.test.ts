// The review acted-on counts and the per-request counts, through the real
// script against a throwaway repository. Both read things a pure-function test
// cannot fake honestly: a `git diff` from the reviewed commit, file mtimes
// against author dates, and the working directory `retro` runs the script from
// (`bun run --cwd tools/pr-metrics card`), which decides what a relative
// pathspec means.
//
// Every commit and every report carries an explicit time. Commit times are
// whole seconds, so a fixture that let them default would put the reviewed
// commit, the report and the fix in one second and pick the wrong baseline on
// some runs.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Card } from "../index";

const SCRIPT = new URL("../index.ts", import.meta.url).pathname;
const BRANCH = "feat/review-fixture";

const SEEDED = "2026-09-01T10:00:00Z";
const REVIEWED = "2026-09-01T11:00:00Z";
const REPORT_WRITTEN = "2026-09-01T11:30:00Z";
const FIXED = "2026-09-01T12:00:00Z";

const TARGET = "osn/api/src/target.ts";
const TARGET_LINES = Array.from({ length: 80 }, (_, i) => `export const v${i + 1} = ${i + 1};`);

/** Two counted findings (one located, one not), one tracker-kind finding that
 * must never be counted, and a trailing section whose `path:line` must not be
 * read as part of the last finding. */
const REPORT = [
  "## Test findings",
  "",
  "**T-U1** — untested export",
  `**Issue:** \`${TARGET}:10\` exports \`v10\` with no test.`,
  "**Why:** nothing fails if it breaks.",
  "",
  "**T-E1** — error path",
  "**Issue:** the failure branch has no test.",
  "",
  "**S-H1** — tracker kind",
  `**Issue:** \`${TARGET}:12\` is a tracker-only finding.`,
  "",
  "## Files audited",
  "",
  `- \`${TARGET}:70\` clear`,
  "",
].join("\n");

interface Fixture {
  dir: string;
  git: (args: string[], date?: string) => Promise<string>;
  card: (options?: { cwd?: string; extra?: string[] }) => Promise<{ card: Card; stdout: string }>;
  report: (text: string, written: string, name?: string) => Promise<void>;
}

async function fixture(sessions: string[] = []): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-review-"));

  const git = async (args: string[], date?: string): Promise<string> => {
    const env = date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env;
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    return out.trim();
  };

  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "seed"], SEEDED);

  await git(["checkout", "-qb", BRANCH]);
  await mkdir(join(dir, "osn", "api", "src"), { recursive: true });
  await mkdir(join(dir, "tools", "pr-metrics"), { recursive: true });
  await writeFile(join(dir, TARGET), `${TARGET_LINES.join("\n")}\n`);
  await git(["add", "."]);
  await git(["commit", "-qm", "work"], REVIEWED);

  const project = join(dir, "sessions", "-fixture");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "sess-1.jsonl"), sessions.join("\n"));

  const report = async (text: string, written: string, name = "TEST-REVIEW.md") => {
    const path = join(dir, name);
    await writeFile(path, text);
    const at = new Date(written);
    await utimes(path, at, at);
  };

  const card = async (options: { cwd?: string; extra?: string[] } = {}) => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        SCRIPT,
        ...(options.extra ?? []),
        "--branch",
        BRANCH,
        "--base",
        "main",
        "--sessions-dir",
        join(dir, "sessions"),
        "--pr",
        "77",
        "--out-dir",
        join(dir, "out"),
      ],
      { cwd: options.cwd ?? dir, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`card exited ${code}: ${stderr}`);

    const written = Bun.file(join(dir, "out", "feat-review-fixture.json"));

    return {
      card: (await written.exists()) ? ((await written.json()) as Card) : ({} as Card),
      stdout,
    };
  };

  return { dir, git, card, report };
}

/** Replace line `n` (1-based) of the target and commit it at `date`. */
async function editLine(f: Fixture, n: number, date: string): Promise<void> {
  const lines = [...TARGET_LINES];
  lines[n - 1] = `export const v${n} = ${n} * 2;`;
  await writeFile(join(f.dir, TARGET), `${lines.join("\n")}\n`);
  await f.git(["commit", "-qam", `fix line ${n}`], date);
}

const withFixture =
  (body: (f: Fixture) => Promise<void>, sessions: string[] = []) =>
  async () => {
    const f = await fixture(sessions);
    try {
      await body(f);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  };

// 1, and the omitted-count hunk: a one-line change prints `@@ -10 +10 @@`.
test(
  "a finding whose line a later commit changed is acted on; its control is not",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);

    const { card } = await f.card();

    expect(card.review).toEqual({
      reports: 1,
      findings: 2,
      located: 1,
      acted_on: 1,
      paired: 1,
      acted_on_paired: 1,
      control_changed: 0,
    });
  }),
);

// 2
test(
  "a finding whose line nothing changed is not acted on",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 60, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(0);
    expect(card.review?.located).toBe(1);
  }),
);

// 3
test(
  "a finding without a path:line, or naming a file absent at the baseline, is not located",
  withFixture(async (f) => {
    const text = [
      "## Test findings",
      "",
      "**T-M1** — missing file",
      "**Issue:** `osn/api/src/not-there.ts:4` has no test file.",
      "",
      "**T-E1** — error path",
      "**Issue:** the failure branch has no test.",
      "",
    ].join("\n");
    await f.report(text, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);

    const { card } = await f.card();

    expect(card.review?.findings).toBe(2);
    expect(card.review?.located).toBe(0);
  }),
);

// 4
test(
  "no review report means review is null, not zeros",
  withFixture(async (f) => {
    await editLine(f, 10, FIXED);

    const { card } = await f.card();

    expect(card.review).toBeNull();
  }),
);

// 5
test(
  "a re-run with the reports gone keeps the counts the first run recorded",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);
    const first = await f.card();
    expect(first.card.review?.acted_on).toBe(1);

    await unlink(join(f.dir, "TEST-REVIEW.md"));
    const second = await f.card();

    expect(second.card.review).toEqual(first.card.review);
  }),
);

// 6 — redaction. The card is committed to a public repository and the render
// goes on a public pull-request body.
test(
  "neither the card nor its render names a finding, a path, or counts a tracker kind",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await f.report(
      "## Security findings\n\n**S-M1** — x\n**Issue:** `osn/api/src/target.ts:5` y.\n",
      REPORT_WRITTEN,
      "SECURITY-REVIEW.md",
    );
    await editLine(f, 10, FIXED);

    const { card } = await f.card();
    const { stdout: render } = await f.card({ extra: ["--format", "markdown"] });
    const text = JSON.stringify(card);

    for (const leaked of ["T-U1", "T-E1", "S-H1", "S-M1", "target.ts"]) {
      expect(text).not.toContain(leaked);
      expect(render).not.toContain(leaked);
    }
    // Two reports read, but only the two test-kind findings counted.
    expect(card.review?.reports).toBe(2);
    expect(card.review?.findings).toBe(2);
  }),
);

// 10
test(
  "run from inside the package, as retro runs it, the diff still finds the fix",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);

    const { card } = await f.card({ cwd: join(f.dir, "tools", "pr-metrics") });

    expect(card.review?.acted_on).toBe(1);
  }),
);

// 11
test(
  "a rebase after the review, which resets committer dates, keeps the reviewed baseline",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);
    // Rewrites both branch commits with a committer date after the report.
    await f.git(["rebase", "-q", "--force-rebase", "main"], "2026-09-05T09:00:00Z");

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(1);
  }),
);

// 12
test(
  "a report older than every commit on the branch is stale and is not read",
  withFixture(async (f) => {
    await f.report(REPORT, "2026-09-01T10:30:00Z");
    await editLine(f, 10, FIXED);

    const { card } = await f.card();

    expect(card.review).toBeNull();
  }),
);

// 7
const assistant = (fields: {
  requestId?: string;
  model?: string;
  tools?: number;
  cacheRead?: number;
  at: string;
}) =>
  JSON.stringify({
    type: "assistant",
    gitBranch: BRANCH,
    sessionId: "sess-1",
    requestId: fields.requestId,
    timestamp: fields.at,
    message: {
      role: "assistant",
      model: fields.model ?? "claude-opus-5",
      content: Array.from({ length: fields.tools ?? 0 }, () => ({
        type: "tool_use",
        name: "Read",
        input: {},
      })),
      usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: fields.cacheRead ?? 0 },
    },
  });

test(
  "requests are counted per response, not per record, and only for real model calls",
  withFixture(
    async (f) => {
      const { card } = await f.card();

      expect(card.interaction.requests).toEqual({
        main: 3,
        subagent: 0,
        with_tools: 2,
        with_one_tool: 1,
        context_median: 2_000,
        context_p90: 3_000,
      });
    },
    [
      JSON.stringify({
        type: "user",
        gitBranch: BRANCH,
        sessionId: "sess-1",
        timestamp: "2026-09-01T10:59:00Z",
        message: { content: "go" },
      }),
      // One response split over two records: one request, two tools.
      assistant({ requestId: "r1", tools: 1, cacheRead: 1_000, at: "2026-09-01T10:59:10Z" }),
      assistant({ requestId: "r1", tools: 1, cacheRead: 1_000, at: "2026-09-01T10:59:11Z" }),
      assistant({ requestId: "r2", tools: 1, cacheRead: 3_000, at: "2026-09-01T10:59:20Z" }),
      assistant({ requestId: "r3", tools: 0, cacheRead: 2_000, at: "2026-09-01T10:59:30Z" }),
      assistant({ model: "<synthetic>", at: "2026-09-01T10:59:40Z" }),
    ],
  ),
);
