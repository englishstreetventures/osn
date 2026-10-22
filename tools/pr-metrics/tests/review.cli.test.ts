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
import { dirname, join } from "node:path";

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
 * must never be counted, and a trailing section whose `path:line` is on no
 * `**Issue:**` line and so is no finding's location. */
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
async function editLine(f: Fixture, n: number | number[], date: string): Promise<void> {
  const path = join(f.dir, TARGET);
  const lines = (await Bun.file(path).text()).split("\n");
  for (const line of [n].flat()) lines[line - 1] = `export const v${line} = ${line} * 2;`;
  await writeFile(path, lines.join("\n"));
  await f.git(["commit", "-qam", `edit ${[n].flat().join(",")}`], date);
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
      acted_on_by_test: 0,
      acted_on_paired_by_test: 0,
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
    // The security report is never opened, and the tracker-kind finding in the
    // tests report is not counted.
    expect(card.review?.reports).toBe(1);
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
  input?: number;
  cacheWrite?: number;
  sidechain?: boolean;
  at: string;
}) =>
  JSON.stringify({
    type: "assistant",
    gitBranch: BRANCH,
    sessionId: "sess-1",
    requestId: fields.requestId,
    isSidechain: fields.sidechain ?? false,
    timestamp: fields.at,
    message: {
      role: "assistant",
      model: fields.model ?? "claude-opus-5",
      content: Array.from({ length: fields.tools ?? 0 }, () => ({
        type: "tool_use",
        name: "Read",
        input: {},
      })),
      usage: {
        input_tokens: fields.input ?? 0,
        output_tokens: 1,
        cache_read_input_tokens: fields.cacheRead ?? 0,
        cache_creation_input_tokens: fields.cacheWrite ?? 0,
      },
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

test(
  "a subagent call, a call with no requestId and every context component are counted",
  withFixture(
    async (f) => {
      const { card } = await f.card();

      expect(card.interaction.requests).toEqual({
        main: 3,
        subagent: 1,
        with_tools: 1,
        with_one_tool: 1,
        context_median: 100,
        context_p90: 3_000,
      });
    },
    [
      // Input, cache read and cache write all count: 500 + 1,000 + 500.
      assistant({
        requestId: "r1",
        tools: 1,
        input: 500,
        cacheRead: 1_000,
        cacheWrite: 500,
        at: "2026-09-01T10:59:10Z",
      }),
      assistant({ requestId: "r2", sidechain: true, cacheRead: 3_000, at: "2026-09-01T10:59:20Z" }),
      // No requestId: each record is its own call.
      assistant({ cacheRead: 100, at: "2026-09-01T10:59:30Z" }),
      assistant({ cacheRead: 100, at: "2026-09-01T10:59:40Z" }),
    ],
  ),
);

test(
  "the rendered block carries the call and review rows, as counts",
  withFixture(
    async (f) => {
      await f.report(REPORT, REPORT_WRITTEN);
      await editLine(f, 10, FIXED);

      const { stdout } = await f.card({ extra: ["--format", "markdown"] });

      expect(stdout).toContain("| Model calls | 2 · 50% of those using tools used one ·");
      expect(stdout).toContain(
        "| Review (tests and docs lenses) | 1 of 1 paired findings acted on · control 0 of 1 |",
      );
    },
    [
      assistant({ requestId: "r1", tools: 1, at: "2026-09-01T10:59:10Z" }),
      assistant({ requestId: "r2", tools: 2, at: "2026-09-01T10:59:20Z" }),
    ],
  ),
);

test(
  "with no call using a tool, the render shows no share rather than 0%",
  withFixture(
    async (f) => {
      const { stdout } = await f.card({ extra: ["--format", "markdown"] });

      expect(stdout).toContain("| Model calls | 1 · — of those using tools used one ·");
    },
    [assistant({ requestId: "r1", at: "2026-09-01T10:59:10Z" })],
  ),
);

test(
  "a fix amended into the reviewed commit leaves the report unread, not a zero",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    const lines = TARGET_LINES.map((l, i) => (i === 9 ? "export const v10 = 20;" : l));
    await writeFile(join(f.dir, TARGET), `${lines.join("\n")}\n`);
    // Amend keeps the author time from before the review; only the committer
    // time moves past it.
    const proc = Bun.spawn(["git", "commit", "-q", "--amend", "-a", "--no-edit"], {
      cwd: f.dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_COMMITTER_DATE: FIXED },
    });
    await proc.exited;

    const { card } = await f.card();

    expect(card.review).toBeNull();
  }),
);

test(
  "the baseline is the newest commit before the review, not the oldest",
  withFixture(async (f) => {
    // Changed before the review, so the review read it as it now stands.
    await editLine(f, 50, "2026-09-01T11:15:00Z");
    await f.report(`**T-U1** — x\n**Issue:** \`${TARGET}:50\` has no test.\n`, REPORT_WRITTEN);
    await editLine(f, 70, FIXED);

    const { card } = await f.card();

    expect(card.review?.located).toBe(1);
    expect(card.review?.acted_on).toBe(0);
  }),
);

test(
  "a control line that changed is counted against the finding",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    // Line 45 is the control for line 10.
    await editLine(f, [10, 45], FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on_paired).toBe(1);
    expect(card.review?.control_changed).toBe(1);
  }),
);

test(
  "near the end of a file the control is the line 35 before",
  withFixture(async (f) => {
    await f.report(`**T-U1** — x\n**Issue:** \`${TARGET}:70\` has no test.\n`, REPORT_WRITTEN);
    await editLine(f, 35, FIXED);

    const { card } = await f.card();

    expect(card.review?.paired).toBe(1);
    expect(card.review?.acted_on).toBe(0);
    expect(card.review?.control_changed).toBe(1);
  }),
);

test(
  "a change 3 lines from the cited line counts",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 13, FIXED);
    expect((await f.card()).card.review?.acted_on).toBe(1);
  }),
);

test(
  "a change 4 lines from the cited line does not count",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 14, FIXED);
    expect((await f.card()).card.review?.acted_on).toBe(0);
  }),
);

// The fallback fires when a session ends, which can fall between the reviews
// and the fixes; a figure recorded then would be kept by every later run.
test(
  "the --if-absent fallback records no review, so the later run counts the fixes",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);

    const early = await f.card({ extra: ["--if-absent"] });
    expect(early.card.review).toBeNull();

    await editLine(f, 10, FIXED);
    expect((await f.card()).card.review?.acted_on).toBe(1);
  }),
);

test(
  "a later run keeps the recorded counts over a rewritten report unless told to read it",
  withFixture(async (f) => {
    await f.report(REPORT, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);
    expect((await f.card()).card.review?.acted_on).toBe(1);

    await f.report(`**T-U1** — x\n**Issue:** \`${TARGET}:60\` has no test.\n`, REPORT_WRITTEN);
    expect((await f.card()).card.review?.acted_on).toBe(1);

    const named = await f.card({ extra: ["--review-reports", "TEST-REVIEW.md"] });
    expect(named.card.review?.acted_on).toBe(0);
  }),
);

test(
  "an absolute path is matched after a URL, and a line past the end is not located",
  withFixture(async (f) => {
    const root = await f.git(["rev-parse", "--show-toplevel"]);
    await f.report(
      [
        "**T-U1** — x",
        `**Issue:** see https://id.musubi.localhost:443 then \`${root}/${TARGET}:10\`.`,
        "",
        "**T-U2** — y",
        `**Issue:** \`${TARGET}:500\` is past the end.`,
        "",
      ].join("\n"),
      REPORT_WRITTEN,
    );
    await editLine(f, 10, FIXED);

    const { card } = await f.card();

    expect(card.review?.findings).toBe(2);
    expect(card.review?.located).toBe(1);
    expect(card.review?.acted_on).toBe(1);
  }),
);

// A tests finding is fixed by a new test, not by changing the line it cites.
// It counts as acted on when its window changed, or when a commit after the
// review added lines to a file under the same package's `tests/` that imports
// the cited file.

/** Committed after the "work" commit and before the report, so part of what
 * the review read. */
const BEFORE_REPORT = "2026-09-01T11:15:00Z";

const SOURCE = `${TARGET_LINES.join("\n")}\n`;

/** Write each file and commit exactly those paths at `date`. */
async function commitFiles(f: Fixture, files: Record<string, string>, date: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(f.dir, path)), { recursive: true });
    await writeFile(join(f.dir, path), text);
  }
  await f.git(["add", "--", ...Object.keys(files)], date);
  await f.git(["commit", "-qm", `files ${Object.keys(files).join(",")}`], date);
}

const finding = (kind: "T" | "D", path: string, line = 10): string =>
  `**${kind}-U1** — untested\n**Issue:** \`${path}:${line}\` has no test.\n`;

const importing = (specifier: string): string =>
  `import { v1 } from "${specifier}";\n\ntest("v1", () => expect(v1).toBe(1));\n`;

const SECOND_CASE = `\ntest("v2", () => expect(2).toBe(2));\n`;

/** `osn/api` as a package with a test file that already imports the target
 * when the review runs; after it, a commit appends a case and leaves the
 * import alone. The cited line never changes. */
async function caseAppended(f: Fixture): Promise<void> {
  const existing = importing("../src/target.ts");
  await commitFiles(
    f,
    { "osn/api/package.json": "{}\n", "osn/api/tests/target.test.ts": existing },
    BEFORE_REPORT,
  );
  await f.report(finding("T", TARGET), REPORT_WRITTEN);
  await commitFiles(f, { "osn/api/tests/target.test.ts": `${existing}${SECOND_CASE}` }, FIXED);
}

test(
  "a tests finding counts as acted on when a later commit adds a test importing its file",
  withFixture(async (f) => {
    // No package.json anywhere, and no tests/ until the fix makes one.
    await commitFiles(f, { "src/x.ts": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "src/x.ts"), REPORT_WRITTEN);
    await commitFiles(f, { "tests/x.test.ts": importing("../src/x") }, FIXED);

    const { card } = await f.card();

    expect(card.review).toEqual({
      reports: 1,
      findings: 1,
      located: 1,
      acted_on: 1,
      paired: 1,
      acted_on_paired: 1,
      control_changed: 0,
      acted_on_by_test: 1,
      acted_on_paired_by_test: 1,
    });
  }),
);

test(
  "a later test for another file does not count",
  withFixture(async (f) => {
    await commitFiles(f, { "src/x.ts": SOURCE, "src/other.ts": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "src/x.ts"), REPORT_WRITTEN);
    await commitFiles(f, { "tests/other.test.ts": importing("../src/other") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.located).toBe(1);
    expect(card.review?.acted_on).toBe(0);
  }),
);

test(
  "a case appended to a test file that already imports the cited file counts",
  withFixture(async (f) => {
    await caseAppended(f);

    const { card } = await f.card();

    expect(card.review).toEqual({
      reports: 1,
      findings: 1,
      located: 1,
      acted_on: 1,
      paired: 1,
      acted_on_paired: 1,
      control_changed: 0,
      acted_on_by_test: 1,
      acted_on_paired_by_test: 1,
    });
  }),
);

test(
  "a test that imports the cited file but did not change after the review does not count",
  withFixture(async (f) => {
    await commitFiles(
      f,
      { "osn/api/tests/target.test.ts": importing("../src/target") },
      BEFORE_REPORT,
    );
    await f.report(finding("T", TARGET), REPORT_WRITTEN);
    await editLine(f, 60, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(0);
  }),
);

test(
  "a test in another package's tests/ does not count, even when that package is cited too",
  withFixture(async (f) => {
    await commitFiles(
      f,
      {
        "osn/api/package.json": "{}\n",
        "osn/web/package.json": "{}\n",
        "osn/web/src/view.ts": SOURCE,
      },
      BEFORE_REPORT,
    );
    await f.report(
      `${finding("T", TARGET)}\n${finding("T", "osn/web/src/view.ts")}`,
      REPORT_WRITTEN,
    );
    await commitFiles(
      f,
      { "osn/web/tests/view.test.ts": importing("../../api/src/target") },
      FIXED,
    );

    const { card } = await f.card();

    expect(card.review?.located).toBe(2);
    expect(card.review?.acted_on).toBe(0);
  }),
);

test(
  "a docs finding does not count when a test importing its file lands",
  withFixture(async (f) => {
    // A tests finding on the same line of the same report, which the test does
    // count.
    await f.report(`${finding("T", TARGET)}\n${finding("D", TARGET)}`, REPORT_WRITTEN);
    await commitFiles(f, { "osn/api/tests/target.test.ts": importing("../src/target") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.located).toBe(2);
    expect(card.review?.acted_on).toBe(1);
    expect(card.review?.acted_on_by_test).toBe(1);
  }),
);

test(
  "a test that names the cited file only in a plain string does not count",
  withFixture(async (f) => {
    await f.report(finding("T", TARGET), REPORT_WRITTEN);
    await commitFiles(
      f,
      {
        "osn/api/tests/target.test.ts": `const path = "../src/target";\n\ntest("path", () => expect(path).toBeTruthy());\n`,
      },
      FIXED,
    );

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(0);
  }),
);

test(
  "a test file that imports the cited file and only lost lines does not count",
  withFixture(async (f) => {
    const oneCase = importing("../src/target");
    await commitFiles(
      f,
      { "osn/api/tests/target.test.ts": `${oneCase}${SECOND_CASE}` },
      BEFORE_REPORT,
    );
    await f.report(finding("T", TARGET), REPORT_WRITTEN);
    await commitFiles(f, { "osn/api/tests/target.test.ts": oneCase }, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(0);
  }),
);

test(
  "a directory with no package.json is a package once it holds a tests/ directory",
  withFixture(async (f) => {
    // scripts/ has no package.json, and its tests/ is made by the fix.
    await commitFiles(f, { "scripts/x.ts": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "scripts/x.ts"), REPORT_WRITTEN);
    await commitFiles(f, { "scripts/tests/x.test.ts": importing("../x") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(1);
  }),
);

test(
  "run from inside the package, as retro runs it, a landed test still counts",
  withFixture(async (f) => {
    await caseAppended(f);

    const { card } = await f.card({ cwd: join(f.dir, "tools", "pr-metrics") });

    expect(card.review?.acted_on).toBe(1);
  }),
);

test(
  "a finding whose window changed is not also counted as acted on by its test",
  withFixture(async (f) => {
    await caseAppended(f);
    await editLine(f, 10, "2026-09-01T12:30:00Z");

    const { card } = await f.card();

    expect(card.review?.acted_on_paired).toBe(1);
    expect(card.review?.acted_on_paired_by_test).toBe(0);
    expect(card.review?.acted_on_by_test).toBe(0);
  }),
);

test(
  "the review row says how many paired findings a new test counted",
  withFixture(async (f) => {
    await caseAppended(f);

    const { stdout } = await f.card({ extra: ["--format", "markdown"] });

    expect(stdout).toContain(
      "| Review (tests and docs lenses) | 1 of 1 paired findings acted on (1 by a new test) · control 0 of 1 |",
    );
  }),
);

test(
  "a finding with no room for a control counts by its test, but not as paired",
  withFixture(async (f) => {
    await commitFiles(
      f,
      { "src/short.ts": "export const v1 = 1;\nexport const v2 = 2;\n" },
      BEFORE_REPORT,
    );
    await f.report(finding("T", "src/short.ts", 2), REPORT_WRITTEN);
    await commitFiles(f, { "tests/short.test.ts": importing("../src/short") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(1);
    expect(card.review?.acted_on_by_test).toBe(1);
    expect(card.review?.paired).toBe(0);
    expect(card.review?.acted_on_paired_by_test).toBe(0);
  }),
);

test(
  "a test in a subdirectory of tests/ resolves its import from its own directory",
  withFixture(async (f) => {
    // tests/ mirrors src/, so the test sits one directory deeper than tests/.
    await commitFiles(
      f,
      { "osn/api/package.json": "{}\n", "osn/api/src/services/x.ts": SOURCE },
      BEFORE_REPORT,
    );
    await f.report(finding("T", "osn/api/src/services/x.ts"), REPORT_WRITTEN);
    await commitFiles(
      f,
      { "osn/api/tests/services/x.test.ts": importing("../../src/services/x") },
      FIXED,
    );

    const { card } = await f.card();

    expect(card.review?.acted_on).toBe(1);
    expect(card.review?.acted_on_by_test).toBe(1);
  }),
);

test(
  "a test file belongs to the deepest package whose tests/ holds it",
  withFixture(async (f) => {
    // A package kept inside another package's tests/, each with a cited file.
    // Its own test counts only if it is filed under the inner package.
    const inner = "tools/kit/tests/fixture";
    await commitFiles(
      f,
      {
        "tools/kit/package.json": "{}\n",
        "tools/kit/src/y.ts": SOURCE,
        "tools/kit/tests/y.test.ts": importing("../src/y"),
        [`${inner}/package.json`]: "{}\n",
        [`${inner}/src/x.ts`]: SOURCE,
      },
      BEFORE_REPORT,
    );
    await f.report(
      `${finding("T", `${inner}/src/x.ts`)}\n${finding("T", "tools/kit/src/y.ts")}`,
      REPORT_WRITTEN,
    );
    await commitFiles(f, { [`${inner}/tests/x.test.ts`]: importing("../src/x") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.located).toBe(2);
    expect(card.review?.acted_on).toBe(1);
    expect(card.review?.acted_on_by_test).toBe(1);
  }),
);

const IMPORT_FORMS: [string, string][] = [
  ["a dynamic import", `const x = await import("../src/x");`],
  ["a bare import", `import "../src/x";`],
  ["require", `const x = require("../src/x");`],
  ["vi.mock", `vi.mock("../src/x", () => ({}));`],
  ["vi.doMock", `vi.doMock("../src/x", () => ({}));`],
  ["mock.module", `mock.module("../src/x", () => ({}));`],
  ["importActual", `const x = await vi.importActual("../src/x");`],
  ["new URL", `const x = new URL("../src/x.ts", import.meta.url);`],
];

test.each(IMPORT_FORMS)("a test that loads the cited file through %s counts", (_, statement) =>
  withFixture(async (f) => {
    await commitFiles(f, { "src/x.ts": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "src/x.ts"), REPORT_WRITTEN);
    await commitFiles(
      f,
      { "tests/x.test.ts": `${statement}\n\ntest("x", () => expect(x).toBeTruthy());\n` },
      FIXED,
    );

    const { card } = await f.card();

    expect(card.review?.acted_on_by_test).toBe(1);
  })(),
);

test(
  "an import of a directory counts for its index file",
  withFixture(async (f) => {
    await commitFiles(f, { "src/foo/index.ts": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "src/foo/index.ts"), REPORT_WRITTEN);
    await commitFiles(f, { "tests/foo.test.ts": importing("../src/foo") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on_by_test).toBe(1);
  }),
);

test(
  "an import that names another code extension counts for the cited file",
  withFixture(async (f) => {
    // TypeScript's ESM form: `./view.js` for `view.tsx`.
    await commitFiles(f, { "src/view.tsx": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "src/view.tsx"), REPORT_WRITTEN);
    await commitFiles(f, { "tests/view.test.ts": importing("../src/view.js") }, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on_by_test).toBe(1);
  }),
);

test(
  "a long run of whitespace after an import keyword does not stall the card",
  withFixture(async (f) => {
    // Each keyword with no quote after it is tried once; the scan stays linear
    // in the run's length, so the card finishes inside the test's time limit.
    const stalled = `import${" ".repeat(200_000)}{ v1 } from "../src/x";\n`;
    await commitFiles(f, { "src/x.ts": SOURCE }, BEFORE_REPORT);
    await f.report(finding("T", "src/x.ts"), REPORT_WRITTEN);
    await commitFiles(f, { "tests/x.test.ts": stalled }, FIXED);

    const { card } = await f.card();

    expect(card.review?.acted_on_by_test).toBe(1);
  }),
);

test(
  "a cited path outside the repository leaves the report's other findings located",
  withFixture(async (f) => {
    await f.report(`${finding("T", "../outside.ts")}\n${finding("D", TARGET)}`, REPORT_WRITTEN);
    await editLine(f, 10, FIXED);

    const { card } = await f.card();

    expect(card.review?.findings).toBe(2);
    expect(card.review?.located).toBe(1);
    expect(card.review?.acted_on).toBe(1);
  }),
);
