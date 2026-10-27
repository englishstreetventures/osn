// `backfill.ts` recards merged pull requests in bulk and had no test at all.
// It is the tool nobody watches: a wrong argv or a renamed `--json` field only
// surfaces when someone runs it over hundreds of PRs and gets numbers that
// cannot be checked by hand.
//
// The seam is a stubbed `gh` on `PATH`. `sh()` spawns a bare `"gh"` with no
// `env`, so the child inherits the backfill process's environment and a
// directory PREPENDED to `PATH` resolves the stub. Prepended, never replaced:
// `repoProjectPaths()` and `repoRoot()` spawn `git`, and `transcriptFiles`
// spawns `sh -c ls`, so a replaced `PATH` loses them and every transcript
// silently vanishes.

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ChangedFile, keepRating, numstatFromApi } from "../backfill";
import { branchSlug, type Card, type IssueSelection, parseNumstat } from "../index";

test("numstatFromApi reshapes the GitHub API's file list into numstat lines", () => {
  const files: ChangedFile[] = [
    { filename: "osn/api/src/auth.ts", additions: 10, deletions: 3 },
    { filename: "wiki/notes.md", additions: 5, deletions: 0 },
    { filename: "bun.lock", additions: 1, deletions: 1 },
  ];

  expect(numstatFromApi(files)).toBe(
    "10\t3\tosn/api/src/auth.ts\n5\t0\twiki/notes.md\n1\t1\tbun.lock",
  );

  // The lines exist to be understood by `parseNumstat`, so assert that rather
  // than only the string: a tab swapped for a space would still look right.
  const diff = parseNumstat(numstatFromApi(files), 2);

  expect(diff.commits).toBe(2);
  expect(diff.loc.source).toEqual({ added: 10, deleted: 3 });
  expect(diff.loc.docs).toEqual({ added: 5, deleted: 0 });
});

// Git permits tabs and newlines in path names and the files API returns the
// path verbatim, so a merged PR adding such a file could inject an extra record
// into the numstat that `parseNumstat` then counts as a real file — its own
// bucket, its own counts, its own entry in `card.diff.packages`.
test("numstatFromApi drops a filename carrying the delimiters it formats with", () => {
  const files: ChangedFile[] = [
    { filename: "osn/api/src/real.ts", additions: 1, deletions: 0 },
    { filename: "evil\n999\t999\tfake/injected.ts", additions: 1, deletions: 0 },
    { filename: "also\tevil.ts", additions: 1, deletions: 0 },
  ];

  const lines = numstatFromApi(files).split("\n").filter(Boolean);

  expect(lines).toEqual(["1\t0\tosn/api/src/real.ts"]);
  expect(parseNumstat(numstatFromApi(files), 1).files.source).toBe(1);
});

/** Every temp directory this file makes, removed even when a fixture throws
 * partway through — `fixture()` does ~20 awaits after `mkdtemp` and each one
 * can reject, leaving a directory behind with an executable `gh` in it. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const BACKFILL = new URL("../backfill.ts", import.meta.url).pathname;
const CARD = new URL("../index.ts", import.meta.url).pathname;

/** The branch carries a trailing dash on purpose: it is legal in git
 * (`git check-ref-format --branch 'feat/foo-'` passes) and it is exactly where
 * `backfill`'s inline slug used to diverge from `branchSlug`. */
const BRANCH = "feat/backfill-fixture-";
const SLUG = "feat-backfill-fixture";
const PR = 4242;

/** Claude Code names a project directory after the session's cwd with `/` and
 * `.` flattened to `-`, and the collector trusts a `TASK-BRANCH:` marker only
 * from a directory this repository owns. `git` resolves symlinks, so the name
 * has to come from git rather than from `mkdtemp`. */
async function projectDirFor(repo: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: repo, stdout: "pipe" });
  const top = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  return top.replaceAll(/[/.]/g, "-");
}

/**
 * A throwaway git repository, a sessions tree whose project directory this
 * repo owns, and a stubbed `gh`.
 *
 * A git repository and not a plain temp dir, deliberately: from a non-git
 * directory both `git` calls in `repoProjectPaths()` fail, it returns `[]`, and
 * `ownedByRepo` then answers `true` for everything — the test would pass
 * without ever exercising ownership.
 */
async function fixture(options: { withTranscript: boolean; withBranch?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-backfill-"));
  tempDirs.push(dir);
  // Identity through the environment and signing through `-c` rather than three
  // `git config` spawns: `fixture()` is the largest line item in this file's
  // runtime and every spawn here is paid five times.
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    await proc.exited;
  };

  await git("init", "-q", "-b", "main");
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await git("add", ".");
  await git("commit", "-qm", "seed");

  // Only the test that also runs `card` needs a real branch: `index.ts` resolves
  // `git diff --numstat main...HEAD` against it, while `backfill.ts` takes every
  // branch name from the stubbed `gh` JSON and never touches a local ref.
  if (options.withBranch) {
    await git("checkout", "-qb", BRANCH);
    await mkdir(join(dir, "osn", "api", "src"), { recursive: true });
    await writeFile(join(dir, "osn", "api", "src", "svc.ts"), "export const a = 1;\n");
    await git("add", ".");
    await git("commit", "-qm", "work");
  }

  const sessions = join(dir, "sessions");
  const project = join(sessions, await projectDirFor(dir));
  const subagents = join(project, "sess-1", "subagents");
  await mkdir(subagents, { recursive: true });

  if (options.withTranscript) {
    // The orchestrator session runs on `main` and dispatches with the marker.
    await writeFile(
      join(project, "sess-1.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        gitBranch: "main",
        timestamp: "2026-09-09T10:00:00.000Z",
        requestId: "req-parent",
        message: {
          model: "claude-opus-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_dispatch",
              name: "Agent",
              input: { prompt: `TASK-BRANCH: ${BRANCH}\n\nImplement it.` },
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
      [400, 600]
        .map((output, i) =>
          JSON.stringify({
            type: "assistant",
            sessionId: "sess-1",
            gitBranch: "main",
            isSidechain: true,
            effort: "high",
            requestId: `req-w${i}`,
            timestamp: `2026-09-09T10:0${i + 1}:00.000Z`,
            message: { model: "claude-opus-5", usage: { output_tokens: output } },
          }),
        )
        .join("\n"),
    );
  }

  // A SECOND project directory, with a name this repository does not own,
  // carrying the same marker for the same branch. `repoPaths` is what stops
  // another checkout's transcript — MCP server names, private skill names —
  // being attributed to a card this repo commits publicly, and a positive-only
  // fixture cannot tell a working scope check from one that admits everything.
  // Its 9999 tokens must not appear in any assertion below.
  const foreign = join(sessions, "-Users-ac--work-otherproj-main", "sess-1", "subagents");
  await mkdir(foreign, { recursive: true });
  await writeFile(
    join(sessions, "-Users-ac--work-otherproj-main", "sess-1.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      sessionId: "other-1",
      gitBranch: "main",
      message: {
        model: "claude-opus-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_foreign",
            name: "Agent",
            input: { prompt: `TASK-BRANCH: ${BRANCH}\n\nSomeone else's work.` },
          },
        ],
      },
    })}\n`,
  );
  await writeFile(
    join(foreign, "agent-other.meta.json"),
    JSON.stringify({ toolUseId: "toolu_foreign", spawnDepth: 1 }),
  );
  await writeFile(
    join(foreign, "agent-other.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      sessionId: "other-1",
      gitBranch: "main",
      isSidechain: true,
      requestId: "req-foreign",
      message: { model: "claude-opus-5", usage: { output_tokens: 9999 } },
    })}\n`,
  );

  // The stub. Executable with a shebang, or Bun skips it and silently resolves
  // the REAL `gh` further down PATH — verified on Bun 1.4.0 — which would send
  // the test to the network with the developer's credentials.
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const log = join(dir, "gh-calls.log");
  await writeFile(
    join(binDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*)
    printf '%s' '[{"number":${PR},"headRefName":"${BRANCH}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","labels":[],"closingIssuesReferences":[]}]' ;;
  *"api graphql"*)
    printf '%s' '{"data":{"repository":{"p${PR}":{"commits":{"totalCount":3}}}}}' ;;
  *"/files"*)
    printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *)
    printf '%s' '3' ;;
esac
`,
  );
  await chmod(join(binDir, "gh"), 0o755);

  // Assert the mode rather than trusting the `chmod` above. A comment saying
  // why something is safe is intent; this is the control.
  expect((await stat(join(binDir, "gh"))).mode & 0o111).toBeGreaterThan(0);

  return { dir, sessions, binDir, log, git };
}

async function runBackfill(f: Awaited<ReturnType<typeof fixture>>, extra: string[] = []) {
  const proc = Bun.spawn(
    ["bun", BACKFILL, "--sessions-dir", f.sessions, "--out-dir", join(f.dir, "cards"), ...extra],
    {
      cwd: f.dir,
      stdout: "pipe",
      stderr: "pipe",
      // Prepend, never replace: `git` and `sh` are still needed.
      //
      // The tokens are blanked as a SECOND line of defence. Shadowing on PATH
      // is the happy path, but it fails on any exec error — a `noexec` TMPDIR,
      // a filesystem that drops the execute bit, an MDM policy — and the real
      // `gh` then resolves further down. With no credentials that fall-through
      // exits non-zero and the test fails loudly offline, instead of quietly
      // going online with the developer's account.
      env: {
        ...process.env,
        PATH: `${f.binDir}:${process.env.PATH}`,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GH_CONFIG_DIR: join(f.dir, "gh-config"),
        GH_NO_UPDATE_NOTIFIER: "1",
        // The stub reads its log path from here rather than having it
        // interpolated into its own source: `JSON.stringify` escapes `"` and
        // `\` but leaves `$` and backticks live inside a double-quoted shell
        // word, and this path descends from `TMPDIR`.
        GH_CALL_LOG: f.log,
      },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

test("backfill cards a marked subagent, and agrees with `card` on both figure and filename", async () => {
  const f = await fixture({ withTranscript: true, withBranch: true });
  try {
    const run = await runBackfill(f);

    expect(run.exitCode).toBe(0);

    // The stub was actually reached — without this the test passes just as well
    // against the real `gh` failing on a PR number no repository has.
    const calls = await readFile(f.log, "utf8");
    expect(calls).toContain("pr list");
    expect(calls).toContain(`repos/englishstreetventures/osn/pulls/${PR}/files`);
    // One batched GraphQL document, not a REST call per pull request.
    expect(calls).toContain("api graphql");
    expect(calls).not.toContain("--jq .commits");

    // The filename `branchSlug` would produce, not the inline slug: a trailing
    // dash is where the two used to differ.
    const backfilled = JSON.parse(await readFile(join(f.dir, "cards", `${SLUG}.json`), "utf8")) as {
      spend: { usd_equivalent: number; by_actor: Record<string, { tokens: { output: number } }> };
      issue: { number: number | null; labels: string[] };
      complexity: { declared: number | null; method: string };
    };

    // Assert the marker path FIRST. Equality alone can pass vacuously: if
    // ownership were broken for both tools they would agree on a number that
    // never included the subagent at all.
    // 1000, never 10999: the foreign project's marked transcript names this
    // same branch and must be rejected on ownership alone.
    expect(backfilled.spend.by_actor.subagent?.tokens.output).toBe(1000);
    expect(backfilled.spend.by_actor.main?.tokens.output).toBe(0);

    // This fixture's PR has no linked issue (`closingIssuesReferences: []`) —
    // a rating must never be guessed for it.
    expect(backfilled.issue.number).toBeNull();
    expect(backfilled.issue.labels).toEqual([]);
    expect(backfilled.complexity.declared).toBeNull();
    expect(backfilled.complexity.method).toBe("none");

    // Now the agreement the doc comment has only ever asserted in prose. Read
    // the JSON: both tools print `toFixed(2)`, so comparing stdout compares
    // two-decimal roundings.
    const live = Bun.spawn(
      [
        "bun",
        CARD,
        "--branch",
        BRANCH,
        "--base",
        "main",
        "--sessions-dir",
        f.sessions,
        "--out-dir",
        join(f.dir, "live"),
      ],
      { cwd: f.dir, stdout: "pipe", stderr: "pipe" },
    );
    await live.exited;

    const liveCard = JSON.parse(await readFile(join(f.dir, "live", `${SLUG}.json`), "utf8")) as {
      spend: { usd_equivalent: number };
    };

    expect(backfilled.spend.usd_equivalent).toBeGreaterThan(0);
    expect(backfilled.spend.usd_equivalent).toBe(liveCard.spend.usd_equivalent);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// `wiki/conventions/session-metrics.md` §Backfilling states this rule and
// nothing tested it: a zero-cost card is indistinguishable from a genuinely
// cheap one once it is in the datalake, and it drags every average it touches.
test("a merged PR with no local transcript is skipped, not written as a zero card", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const { stdout } = await runBackfill(f);

    expect(stdout).toContain("wrote 0 card(s)");
    expect(stdout).toContain(String(PR));

    // Every test that spawns backfill proves the stub answered, not the real
    // `gh` — otherwise this one would fail on the assertions above only after
    // an authenticated call had already gone out.
    expect(await readFile(f.log, "utf8")).toContain("pr list");

    // `mkdirSync` sits inside the write branch, so on a skip the directory is
    // never created — assert absence, not emptiness.
    expect(await Bun.file(join(f.dir, "cards", `${SLUG}.json`)).exists()).toBe(false);
    const dir = Bun.spawnSync(["test", "-d", join(f.dir, "cards")]);
    expect(dir.exitCode).not.toBe(0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("--dry-run reports what it would write and writes nothing", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    const { stdout } = await runBackfill(f, ["--dry-run"]);

    expect(stdout).toContain("would write");
    expect(stdout).toContain(`#${PR}`);
    expect(await Bun.file(join(f.dir, "cards", `${SLUG}.json`)).exists()).toBe(false);

    // The three `gh` calls run BEFORE the dry-run branch, so the stub is still
    // exercised — a dry run is not an offline run.
    const calls = await readFile(f.log, "utf8");
    expect(calls).toContain("pr list");
    expect(calls).toContain("api graphql");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// `branchSlug` is not injective: `feat/x-`, `feat-x` and `feat/x` all slug to
// `feat-x`. `card` writes one file per run so it cannot notice; `backfill`
// writes many in one pass and can. A silently overwritten card is
// indistinguishable from a PR that was never backfilled, which is the same
// failure the file already refuses for zero-cost cards.
test("backfill warns rather than silently overwriting when two branches share a slug", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    // A second merged PR whose different branch name slugs to the same file.
    await writeFile(
      join(f.binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*)
    printf '%s' '[{"number":${PR},"headRefName":"${BRANCH}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","labels":[],"closingIssuesReferences":[]},{"number":9999,"headRefName":"${SLUG}","mergedAt":"2026-09-09T13:00:00Z","baseRefOid":"ccc","headRefOid":"ddd","labels":[],"closingIssuesReferences":[]}]' ;;
  *"api graphql"*)
    printf '%s' '{"data":{"repository":{"p${PR}":{"commits":{"totalCount":3}},"p9999":{"commits":{"totalCount":1}}}}}' ;;
  *"/files"*)
    printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *)
    printf '%s' '3' ;;
esac
`,
    );
    await chmod(join(f.binDir, "gh"), 0o755);

    // Both branches need transcripts, or the second is skipped before the
    // collision can happen.
    const project = join(f.sessions, await projectDirFor(f.dir));
    await writeFile(
      join(project, "sess-2.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-2",
        gitBranch: SLUG,
        requestId: "req-other",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
      })}\n`,
    );

    const { stdout, stderr } = await runBackfill(f);

    expect(stdout + stderr).toContain("collision");
    expect(stdout + stderr).toContain(SLUG);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// `backfill.ts` guards `gh pr list` failing and exits 1 with a message naming
// authentication. The stub always exited 0, so that path had never run — and it
// is the path a developer hits first, on the day their `gh` token expires.
test("a failing `gh pr list` exits non-zero and says so, rather than carding nothing quietly", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    await writeFile(
      join(f.binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
echo "gh: could not authenticate" >&2
exit 1
`,
    );
    await chmod(join(f.binDir, "gh"), 0o755);

    const { stderr, exitCode } = await runBackfill(f);

    expect(exitCode).toBe(1);

    // The FIRST line, not a substring of the whole stream. Bun prints a source
    // excerpt when a script throws, and that excerpt quotes the very
    // `console.error` line this asserts on — so `toContain` over all of stderr
    // passes just as happily on a crash as on the handled path, which is the
    // opposite of what this test is for. A crash's first line is the excerpt's
    // `110 | …`; the handled path's is the message itself.
    const firstLine = stderr.trim().split("\n")[0] ?? "";

    expect(firstLine).toContain("pr-metrics backfill:");
    expect(firstLine).toContain("authenticated");
    expect(await Bun.file(join(f.dir, "cards", `${SLUG}.json`)).exists()).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// The whole point of the batching: `gh` invocations must grow with the number of
// pull requests once, not twice. Before this, a `--limit 100` run made 201 calls
// and took about 150 s; the count is what stops that returning unnoticed.
test("one gh call per carded PR for files, plus one batched query, and no per-PR commits call", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    await runBackfill(f);

    const calls = (await readFile(f.log, "utf8")).split("\n").filter(Boolean);

    // One `repo view` per run, `pr list`, one `api graphql`, one `/files` for
    // the single carded PR.
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.includes("repo view"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("api graphql"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/files"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("--jq .commits"))).toHaveLength(0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// The bug this file exists to catch: `backfill` must read a rating off the
// pull request's LINKED ISSUE, never the pull request's own labels (which
// this repository never sets) — and the fetch has to work across two pull
// requests sharing one batched `nodes(ids:)` document, not just one.
test("backfill reads complexity off the linked issue's labels, in one batched nodes(ids:) call", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branchA = "feat/complexity-a";
    const branchB = "feat/complexity-b";
    const slugA = "feat-complexity-a";
    const slugB = "feat-complexity-b";

    await writeFile(
      join(f.binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*)
    printf '%s' '[{"number":5001,"headRefName":"${branchA}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","closingIssuesReferences":[{"id":"I_test_970","number":970,"repository":{"name":"osn","owner":{"login":"englishstreetventures"}}}]},{"number":5002,"headRefName":"${branchB}","mergedAt":"2026-09-09T13:00:00Z","baseRefOid":"ccc","headRefOid":"ddd","closingIssuesReferences":[{"id":"I_test_200","number":200,"repository":{"name":"osn","owner":{"login":"englishstreetventures"}}}]}]' ;;
  *"nodes(ids:"*)
    printf '%s' '{"data":{"nodes":[{"labels":{"nodes":[{"name":"product:osn-core"},{"name":"complexity:3"},{"name":"complexity:unconfirmed"}]}},{"labels":{"nodes":[{"name":"product:cire"}]}}]}}' ;;
  *"api graphql"*)
    printf '%s' '{"data":{"repository":{"p5001":{"commits":{"totalCount":3}},"p5002":{"commits":{"totalCount":1}}}}}' ;;
  *"/files"*)
    printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *)
    printf '%s' '3' ;;
esac
`,
    );
    await chmod(join(f.binDir, "gh"), 0o755);

    const project = join(f.sessions, await projectDirFor(f.dir));
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "sess-a.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-a",
        gitBranch: branchA,
        requestId: "req-a",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
      })}\n`,
    );
    await writeFile(
      join(project, "sess-b.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-b",
        gitBranch: branchB,
        requestId: "req-b",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
      })}\n`,
    );

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);

    // One batched call for both issues' labels, not one per pull request.
    const calls = (await readFile(f.log, "utf8")).split("\n").filter(Boolean);
    expect(calls.filter((c) => c.includes("nodes(ids:"))).toHaveLength(1);

    const cardA = JSON.parse(await readFile(join(f.dir, "cards", `${slugA}.json`), "utf8")) as {
      issue: { number: number | null; labels: string[] };
      complexity: { declared: number | null; method: string };
    };
    expect(cardA.issue.number).toBe(970);
    expect(cardA.issue.labels).toEqual([
      "product:osn-core",
      "complexity:3",
      "complexity:unconfirmed",
    ]);
    expect(cardA.complexity.declared).toBe(3);
    expect(cardA.complexity.method).toBe("unconfirmed");

    // The linked issue has no `complexity:` label — a real, checked "none",
    // not a skipped fetch: `issue.labels` still carries what was found.
    const cardB = JSON.parse(await readFile(join(f.dir, "cards", `${slugB}.json`), "utf8")) as {
      issue: { number: number | null; labels: string[] };
      complexity: { declared: number | null; method: string };
    };
    expect(cardB.issue.number).toBe(200);
    expect(cardB.issue.labels).toEqual(["product:cire"]);
    expect(cardB.complexity.declared).toBeNull();
    expect(cardB.complexity.method).toBe("none");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// `backfill.ts`'s own rule ("a card must never claim to have checked
// something it did not") applies to a rating exactly as it does to spend: a
// lookup that never resolved must not read the same as one that resolved and
// found nothing.
test("a failed label lookup is reported and left unrated, not written as a checked none", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/lookup-fails";
    const slug = "feat-lookup-fails";

    await writeFile(
      join(f.binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*)
    printf '%s' '[{"number":7001,"headRefName":"${branch}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","closingIssuesReferences":[{"id":"I_test_vanished","number":444,"repository":{"name":"osn","owner":{"login":"englishstreetventures"}}}]}]' ;;
  *"nodes(ids:"*)
    printf '%s' '{"data":{"nodes":[null]},"errors":[{"type":"NOT_FOUND"}]}'
    exit 1 ;;
  *"api graphql"*)
    printf '%s' '{"data":{"repository":{"p7001":{"commits":{"totalCount":1}}}}}' ;;
  *"/files"*)
    printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *)
    printf '%s' '3' ;;
esac
`,
    );
    await chmod(join(f.binDir, "gh"), 0o755);

    const project = join(f.sessions, await projectDirFor(f.dir));
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "sess-vanished.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-vanished",
        gitBranch: branch,
        requestId: "req-vanished",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
      })}\n`,
    );

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("#444");

    const card = JSON.parse(await readFile(join(f.dir, "cards", `${slug}.json`), "utf8")) as {
      complexity: { declared: number | null; method: string };
    };
    expect(card.complexity.declared).toBeNull();
    expect(card.complexity.method).toBe("lookup-failed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// The backfill is run again whenever the tool learns something new — a price
// list, a label source. Rewriting every card it touches buries the handful that
// changed under a hundred one-line timestamp diffs.
test("a second backfill over unchanged inputs rewrites nothing", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    const first = await runBackfill(f);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("wrote 1 card(s).");

    const cardPath = join(f.dir, "cards", `${SLUG}.json`);
    const before = {
      text: await readFile(cardPath, "utf8"),
      mtimeMs: (await stat(cardPath)).mtimeMs,
    };

    const second = await runBackfill(f);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("wrote 0 card(s).");
    expect(second.stdout).toContain("left 1 card(s) untouched");
    expect(await readFile(cardPath, "utf8")).toBe(before.text);
    expect((await stat(cardPath)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// The review counts come from report files that are gone by merge time, so a
// backfill that rebuilt the card without them would erase the only record.
test("a backfill keeps the review counts the card on disk already holds", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    expect((await runBackfill(f)).exitCode).toBe(0);

    const cardPath = join(f.dir, "cards", `${SLUG}.json`);
    const review = {
      reports: 1,
      findings: 3,
      located: 2,
      acted_on: 2,
      paired: 1,
      acted_on_paired: 1,
      control_changed: 0,
    };
    const card = JSON.parse(await readFile(cardPath, "utf8"));
    await writeFile(cardPath, JSON.stringify({ ...card, review }));

    expect((await runBackfill(f)).exitCode).toBe(0);

    expect(JSON.parse(await readFile(cardPath, "utf8")).review).toEqual(review);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// --- one branch name, several merged pull requests ---------------------------

const LATER_PR = 5000;

/** A stub `gh` listing the given merged pull requests, newest first as the
 * real listing is, all on `BRANCH` unless they say otherwise. */
async function stubListing(
  f: Awaited<ReturnType<typeof fixture>>,
  pulls: { number: number; mergedAt: string }[],
) {
  const listing = JSON.stringify(
    pulls.map((p) => ({
      number: p.number,
      headRefName: BRANCH,
      mergedAt: p.mergedAt,
      baseRefOid: "aaa",
      headRefOid: "bbb",
      labels: [],
      closingIssuesReferences: [],
    })),
  );
  const commits = JSON.stringify({
    data: {
      repository: Object.fromEntries(
        pulls.map((p) => [`p${p.number}`, { commits: { totalCount: 1 } }]),
      ),
    },
  });

  await writeFile(
    join(f.binDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*) printf '%s' '${listing}' ;;
  *"api graphql"*) printf '%s' '${commits}' ;;
  *"/files"*) printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *) printf '%s' '3' ;;
esac
`,
  );
  await chmod(join(f.binDir, "gh"), 0o755);
}

/** A second session on `BRANCH`, two days after the first pull request merged:
 * 100 output tokens that belong to the later pull request alone. */
async function laterSession(f: Awaited<ReturnType<typeof fixture>>) {
  const project = join(f.sessions, await projectDirFor(f.dir));
  await writeFile(
    join(project, "sess-3.jsonl"),
    [
      ["2026-09-11T09:00:00.000Z", 70],
      ["2026-09-11T09:05:00.000Z", 30],
    ]
      .map(([timestamp, output], i) =>
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-3",
          gitBranch: BRANCH,
          uuid: `later-${i}`,
          requestId: `req-later-${i}`,
          timestamp,
          message: { model: "claude-opus-5", usage: { output_tokens: output } },
        }),
      )
      .join("\n"),
  );
}

/** A card already on disk, as an earlier run or `retro` would have left it. */
async function plantCard(
  f: Awaited<ReturnType<typeof fixture>>,
  file: string,
  pr: { number: number; merged_at: string | null },
) {
  await mkdir(join(f.dir, "cards"), { recursive: true });
  const text = `${JSON.stringify({
    schema_version: 1,
    pr: { ...pr, branch: BRANCH, phase: "at-open", generated_at: "2026-09-01T00:00:00Z" },
    spend: { usd_equivalent: 12.34 },
    interaction: {},
  })}\n`;
  await writeFile(join(f.dir, "cards", file), text);

  return text;
}

interface WrittenCard {
  pr: { number: number };
  window: { sessions: number; first_ts: string; last_ts: string };
  spend: { tokens: { output: number } };
}

async function readCard(f: Awaited<ReturnType<typeof fixture>>, file: string) {
  return JSON.parse(await readFile(join(f.dir, "cards", file), "utf8")) as WrittenCard;
}

// The case the cards were wrong about: #984 and #1375 shared one branch name,
// and a backfill over both wrote the later card over the earlier one, carrying
// both pull requests' sessions.
test("two merged pull requests on one branch name get two cards, each from its own records", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    await stubListing(f, [
      { number: LATER_PR, mergedAt: "2026-09-12T12:00:00Z" },
      { number: PR, mergedAt: "2026-09-09T12:00:00Z" },
    ]);
    await laterSession(f);

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("wrote 2 card(s).");
    expect(await readFile(f.log, "utf8")).toContain("pr list");

    const first = await readCard(f, `${SLUG}.json`);
    expect(first.pr.number).toBe(PR);
    expect(first.window.sessions).toBe(1);
    expect(first.window.first_ts).toBe("2026-09-09T10:01:00.000Z");
    expect(first.window.last_ts).toBe("2026-09-09T10:02:00.000Z");
    expect(first.spend.tokens.output).toBe(1000);

    const second = await readCard(f, `${SLUG}-${LATER_PR}.json`);
    expect(second.pr.number).toBe(LATER_PR);
    expect(second.window.sessions).toBe(1);
    expect(second.window.first_ts).toBe("2026-09-11T09:00:00.000Z");
    expect(second.spend.tokens.output).toBe(100);

    // A second pass finds both cards already right and touches neither.
    const again = await runBackfill(f);
    expect(again.stdout).toContain("wrote 0 card(s).");
    expect(again.stdout).toContain("left 2 card(s) untouched");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// `--limit` reaches back only so far: the earlier pull request may be in no
// listing, and its card on disk is then the only record that it exists.
test("a card on disk for an earlier pull request outside the listing keeps its file", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    await stubListing(f, [{ number: PR, mergedAt: "2026-09-09T12:00:00Z" }]);
    const planted = await plantCard(f, `${SLUG}.json`, {
      number: 777,
      merged_at: "2026-09-01T00:00:00Z",
    });

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);

    expect(await readFile(join(f.dir, "cards", `${SLUG}.json`), "utf8")).toBe(planted);
    const card = await readCard(f, `${SLUG}-${PR}.json`);
    expect(card.pr.number).toBe(PR);
    expect(card.spend.tokens.output).toBe(1000);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// Once the earlier pull request's transcripts age out, its window is empty. A
// zero card written over its measured one would read like a cheap pull request.
test("a pull request whose window holds no records is held back, its card untouched", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    await stubListing(f, [
      { number: LATER_PR, mergedAt: "2026-09-12T12:00:00Z" },
      { number: PR, mergedAt: "2026-09-09T12:00:00Z" },
    ]);
    await laterSession(f);
    const planted = await plantCard(f, `${SLUG}.json`, {
      number: PR,
      merged_at: "2026-09-09T12:00:00Z",
    });

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(`#${PR}: no records`);
    expect(run.stdout).toContain(`held back 1 PR(s)`);

    expect(await readFile(join(f.dir, "cards", `${SLUG}.json`), "utf8")).toBe(planted);
    expect((await readCard(f, `${SLUG}-${LATER_PR}.json`)).spend.tokens.output).toBe(100);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("an earlier pull request with no known merge time holds the later one back", async () => {
  const f = await fixture({ withTranscript: true });
  try {
    await stubListing(f, [{ number: PR, mergedAt: "2026-09-09T12:00:00Z" }]);
    const planted = await plantCard(f, `${SLUG}.json`, { number: 777, merged_at: null });

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("#777, whose merge time is unknown");
    expect(run.stdout).toContain("wrote 0 card(s).");
    expect(await readFile(join(f.dir, "cards", `${SLUG}.json`), "utf8")).toBe(planted);
    expect(await Bun.file(join(f.dir, "cards", `${SLUG}-${PR}.json`)).exists()).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// A slug neighbour's card left by an earlier run: `feat-backfill-fixture` is
// another branch name that flattens to the same file. The in-run collision
// check cannot see it, since this run never claimed the file.
test("backfill never writes over another pull request's card left by an earlier run", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const planted = await plantCard(f, `${SLUG}.json`, { number: 777, merged_at: null });
    await writeFile(
      join(f.binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*)
    printf '%s' '[{"number":9999,"headRefName":"${SLUG}","mergedAt":"2026-09-09T13:00:00Z","baseRefOid":"ccc","headRefOid":"ddd","labels":[],"closingIssuesReferences":[]}]' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p9999":{"commits":{"totalCount":1}}}}}' ;;
  *"/files"*) printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *) printf '%s' '3' ;;
esac
`,
    );
    await chmod(join(f.binDir, "gh"), 0o755);
    const project = join(f.sessions, await projectDirFor(f.dir));
    await writeFile(
      join(project, "sess-2.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-2",
        gitBranch: SLUG,
        requestId: "req-neighbour",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
      })}\n`,
    );

    const run = await runBackfill(f);

    expect(run.exitCode).toBe(0);
    expect(await readFile(f.log, "utf8")).toContain("pr list");
    expect(run.stderr).toContain(`${SLUG}.json is the card for #777`);
    expect(run.stdout).toContain("held back 1 PR(s)");
    expect(await readFile(join(f.dir, "cards", `${SLUG}.json`), "utf8")).toBe(planted);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// --- the repository a linked issue belongs to --------------------------------

/** A stub `gh` answering the given `case` arms, logging every call. */
async function stubGh(f: Awaited<ReturnType<typeof fixture>>, arms: string) {
  await writeFile(
    join(f.binDir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
${arms}
  *"/files"*)
    printf '%s\\n' '{"filename":"osn/api/src/svc.ts","additions":1,"deletions":0}' ;;
  *)
    exit 1 ;;
esac
`,
  );
  await chmod(join(f.binDir, "gh"), 0o755);
}

/** One main-thread session on `branch`, so the pull request has spend to card. */
async function sessionOn(f: Awaited<ReturnType<typeof fixture>>, branch: string) {
  const project = join(f.sessions, await projectDirFor(f.dir));
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, `sess-${branchSlug(branch)}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      sessionId: `sess-${branchSlug(branch)}`,
      gitBranch: branch,
      requestId: `req-${branchSlug(branch)}`,
      timestamp: "2026-09-09T11:00:00.000Z",
      message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
    })}\n`,
  );
}

function prListing(
  number: number,
  branch: string,
  refs: { id: string; number: number; repo?: string }[],
  body = "",
): string {
  return JSON.stringify([
    {
      number,
      headRefName: branch,
      mergedAt: "2026-09-09T12:00:00Z",
      baseRefOid: "aaa",
      headRefOid: "bbb",
      body,
      closingIssuesReferences: refs.map(({ repo = "englishstreetventures/osn", ...ref }) => {
        const [login = "", name = ""] = repo.split("/");

        return { ...ref, repository: { name, owner: { login } } };
      }),
    },
  ]);
}

const RATED = '{"data":{"nodes":[{"labels":{"nodes":[{"name":"complexity:3"}]}}]}}';

// GitHub redirects a renamed owner, so every `gh` call succeeds with the old
// name — and then a typed-string comparison read every issue in this repository
// as foreign and wrote `not-fetched` on every card.
test("backfill reads an in-repo issue's rating when --repo names the repository by an old name", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/renamed-owner";
    await stubGh(
      f,
      `  *"repo view xchromo/osn"*) printf '%s' 'englishstreetventures/osn' ;;
  *"pr list"*) printf '%s' '${prListing(8001, branch, [{ id: "I_r", number: 970 }])}' ;;
  *"nodes(ids:"*) printf '%s' '${RATED}' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8001":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const run = await runBackfill(f, ["--repo", "xchromo/osn"]);
    expect(run.exitCode).toBe(0);

    const card = JSON.parse(
      await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8"),
    ) as Card;
    expect(card.issue.number).toBe(970);
    expect(card.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });

    // Every later call uses the canonical name, not the redirected one.
    const calls = await readFile(f.log, "utf8");
    expect(calls).toContain("repos/englishstreetventures/osn/pulls/8001/files");
    expect(calls).not.toContain("repos/xchromo/osn/");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("backfill falls back to the typed repository, ignoring case, when gh cannot name it", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/case-variant";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(8002, branch, [{ id: "I_c", number: 971 }])}' ;;
  *"nodes(ids:"*) printf '%s' '${RATED}' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8002":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const run = await runBackfill(f, ["--repo", "EnglishStreetVentures/osn"]);
    expect(run.exitCode).toBe(0);

    const card = JSON.parse(
      await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8"),
    ) as Card;
    expect(card.complexity.declared).toBe(3);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("backfill names the body's first Closes issue and sums every one the merge closed", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/batched";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(
        8003,
        branch,
        [
          { id: "I_a", number: 1031 },
          { id: "I_b", number: 1550 },
        ],
        "Closes #1550\nCloses #1031",
      )}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[{"labels":{"nodes":[{"name":"complexity:1"}]}},{"labels":{"nodes":[{"name":"complexity:3"}]}}]}}' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8003":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    expect((await runBackfill(f)).exitCode).toBe(0);

    const card = JSON.parse(
      await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8"),
    ) as Card;
    expect(card.issue.number).toBe(1550);
    expect(card.issue.labels).toEqual(["complexity:3"]);
    expect(card.complexity).toEqual({ declared: 4, method: "confirmed", issues: 2 });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// A backfill that cannot read a label must not erase the rating a card already
// holds: the card on disk is the record, and the next run may have the network.
test("backfill never replaces a rating on disk with a lookup that failed", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/keep-rating";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(8004, branch, [{ id: "I_k", number: 972 }])}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[null]}}'
    exit 1 ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8004":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const cardPath = join(f.dir, "cards", `${branchSlug(branch)}.json`);
    await mkdir(join(f.dir, "cards"), { recursive: true });
    await writeFile(
      cardPath,
      JSON.stringify({
        schema_version: 1,
        pr: { number: 8004, branch, merged_at: "2026-09-09T12:00:00Z", phase: "at-open" },
        issue: { number: 972, type: "Bug", labels: ["complexity:3"] },
        complexity: { declared: 3, method: "confirmed" },
        spend: { usd_equivalent: 1 },
        interaction: {},
      }),
    );

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("#8004");

    const card = JSON.parse(await readFile(cardPath, "utf8")) as Card;
    expect(card.issue).toEqual({ number: 972, type: "Bug", labels: ["complexity:3"] });
    expect(card.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// A card before version 3 rates one issue. Under version 3 `declared` is the sum over
// every issue the pull request closes, so one issue's rating cannot be carried
// into a rebuilt card for a pull request that closes several: it would count
// four issues of work at one issue's rating. When this run cannot read the sum
// either, the card on disk stays exactly as it was, on its old version.
test("backfill leaves a one-issue card alone rather than relabel it as a batched sum", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/keep-batched";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(8005, branch, [
        { id: "I_p", number: 1070 },
        { id: "I_q", number: 1074 },
      ])}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[null]}}'
    exit 1 ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8005":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const cardPath = join(f.dir, "cards", `${branchSlug(branch)}.json`);
    await mkdir(join(f.dir, "cards"), { recursive: true });
    const planted = `${JSON.stringify({
      schema_version: 1,
      pr: { number: 8005, branch, merged_at: "2026-09-09T12:00:00Z", phase: "at-open" },
      issue: { number: 1070, type: "Bug", labels: ["complexity:1"] },
      complexity: { declared: 1, method: "confirmed" },
      spend: { usd_equivalent: 1 },
      interaction: {},
    })}\n`;
    await writeFile(cardPath, planted);

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("#8005");
    expect(await readFile(cardPath, "utf8")).toBe(planted);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// `wiki/conventions/session-metrics.md` §Backfilling: a pull request that links
// no issue here takes its rating from the tracker issues GitHub registered as
// closed — their `complexity:` pair and nothing else. The tracker's ids go in a
// call of their own, so a tracker the token cannot read never costs a public
// lookup, and its other labels are dropped as the answer arrives.
const TRACKER = "englishstreetventures/osn-tracker";
const TRACKER_FINDING =
  '{"data":{"nodes":[{"labels":{"nodes":[{"name":"severity:high"},{"name":"area:security"},{"name":"needs:decision"},{"name":"complexity:3"},{"name":"complexity:unconfirmed"}]}}]}}';

test("backfill rates a tracker-only pull request from the tracker and writes none of its other labels", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/tracker-linked";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(
        6001,
        branch,
        [{ id: "I_tracker_900619", number: 900619, repo: TRACKER }],
        `Closes ${TRACKER}#900619`,
      )}' ;;
  *"nodes(ids:"*"I_tracker_900619"*) printf '%s' '${TRACKER_FINDING}' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p6001":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    expect((await runBackfill(f)).exitCode).toBe(0);

    const text = await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8");
    const card = JSON.parse(text) as Card;
    // The tracker issue's number is private, so it is not recorded at all.
    expect(card.issue.number).toBeNull();
    expect(card.issue.labels).toEqual([]);
    expect(card.complexity).toEqual({ declared: 3, method: "unconfirmed", issues: 1 });
    expect(text).not.toMatch(/severity:|area:|needs:/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("backfill records not-fetched for a tracker issue the token cannot resolve", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/tracker-unreadable";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(6002, branch, [
        { id: "I_tracker_900620", number: 900620, repo: TRACKER },
      ])}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[null]},"errors":[{"type":"NOT_FOUND"}]}'
    exit 1 ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p6002":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);

    const card = JSON.parse(
      await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8"),
    ) as Card;
    expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
    expect(run.stderr).toContain("could not read 1 issue in another repository");
    expect(run.stderr).not.toContain("osn-tracker#");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// Beside an issue here, the tracker issues a pull request closes are its own
// review findings, filed and fixed on the branch: they add nothing to the sum,
// so their ids are never sent.
test("backfill never asks the tracker about a pull request that closes an issue here", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/tracker-beside";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(6003, branch, [
        { id: "I_local_970", number: 970 },
        { id: "I_tracker_900619", number: 900619, repo: TRACKER },
      ])}' ;;
  *"nodes(ids:"*"I_tracker_900619"*) printf '%s' '${TRACKER_FINDING}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[{"labels":{"nodes":[{"name":"product:osn-core"},{"name":"complexity:2"}]}}]}}' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p6003":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    expect((await runBackfill(f)).exitCode).toBe(0);

    const text = await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8");
    const card = JSON.parse(text) as Card;
    expect(card.issue.number).toBe(970);
    expect(card.issue.labels).toEqual(["product:osn-core", "complexity:2"]);
    expect(card.complexity).toEqual({ declared: 2, method: "confirmed", issues: 1 });
    expect(text).not.toMatch(/severity:|area:/);
    expect(await readFile(f.log, "utf8")).not.toContain("I_tracker_900619");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// A card is public, and the rating on disk is kept only as a number. Its issue
// block is kept only when this run links that issue to this repository: a
// tracker number or tracker labels on a card written some other way never
// survive a backfill.
test("backfill keeps a rating on disk but not an issue this repository does not link", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/keep-tracker";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(
        8006,
        branch,
        [{ id: "I_t", number: 900619, repo: "englishstreetventures/osn-tracker" }],
        "Closes englishstreetventures/osn-tracker#900619",
      )}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[null]}}'
    exit 1 ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8006":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const cardPath = join(f.dir, "cards", `${branchSlug(branch)}.json`);
    await mkdir(join(f.dir, "cards"), { recursive: true });
    await writeFile(
      cardPath,
      JSON.stringify({
        schema_version: 1,
        pr: { number: 8006, branch, merged_at: "2026-09-09T12:00:00Z", phase: "at-open" },
        issue: { number: 900619, type: "Bug", labels: ["severity:high", "complexity:3"] },
        complexity: { declared: 3, method: "confirmed" },
        spend: { usd_equivalent: 1 },
        interaction: {},
      }),
    );

    expect((await runBackfill(f)).exitCode).toBe(0);

    const card = JSON.parse(await readFile(cardPath, "utf8")) as Card;
    expect(card.issue.number).toBeNull();
    expect(card.issue.labels).toEqual([]);
    expect(card.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("backfill strips a tracker issue's number and labels from a card it cannot re-rate", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/keep-tracker-two";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(8007, branch, [
        { id: "I_t1", number: 900619, repo: TRACKER },
        { id: "I_t2", number: 900620, repo: TRACKER },
      ])}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[null,null]}}'
    exit 1 ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8007":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const cardPath = join(f.dir, "cards", `${branchSlug(branch)}.json`);
    await mkdir(join(f.dir, "cards"), { recursive: true });
    await writeFile(
      cardPath,
      JSON.stringify({
        schema_version: 1,
        pr: { number: 8007, branch, merged_at: "2026-09-09T12:00:00Z", phase: "at-open" },
        issue: { number: 900619, type: "Bug", labels: ["severity:high", "complexity:3"] },
        complexity: { declared: 3, method: "confirmed" },
        spend: { usd_equivalent: 1 },
        interaction: {},
      }),
    );

    expect((await runBackfill(f)).exitCode).toBe(0);

    const text = await readFile(cardPath, "utf8");
    const card = JSON.parse(text) as Card;
    expect(text).not.toContain("severity:");
    expect(card.issue).toEqual({ number: null, type: null, labels: [] });
    expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

// The warning counts what the sum would cover — on a tracker-only pull request,
// the tracker issues it closes, not the none it closes here.
test("backfill leaves an issueless tracker-only card as it is and counts the issues the sum covers", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/keep-tracker-three";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(8009, branch, [
        { id: "I_t1", number: 900619, repo: TRACKER },
        { id: "I_t2", number: 900620, repo: TRACKER },
        { id: "I_t3", number: 900621, repo: TRACKER },
      ])}' ;;
  *"nodes(ids:"*) printf '%s' '{"data":{"nodes":[null,null,null]}}'
    exit 1 ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8009":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    const cardPath = join(f.dir, "cards", `${branchSlug(branch)}.json`);
    await mkdir(join(f.dir, "cards"), { recursive: true });
    const before = JSON.stringify({
      schema_version: 1,
      pr: { number: 8009, branch, merged_at: "2026-09-09T12:00:00Z", phase: "at-open" },
      issue: { number: null, type: null, labels: [] },
      complexity: { declared: 3, method: "manual" },
      spend: { usd_equivalent: 1 },
      interaction: {},
    });
    await writeFile(cardPath, before);

    const run = await runBackfill(f);

    expect(run.exitCode).toBe(0);
    expect(await readFile(cardPath, "utf8")).toBe(before);
    expect(run.stderr).toContain("rates fewer issues than the 3 this pull request closes");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("backfill records not-fetched for a merged pull request whose tracker line GitHub did not register", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/tracker-body-only";
    await stubGh(
      f,
      `  *"pr list"*) printf '%s' '${prListing(8008, branch, [], `Closes ${TRACKER}#900621`)}' ;;
  *"api graphql"*) printf '%s' '{"data":{"repository":{"p8008":{"commits":{"totalCount":1}}}}}' ;;`,
    );
    await sessionOn(f, branch);

    expect((await runBackfill(f)).exitCode).toBe(0);

    const card = JSON.parse(
      await readFile(join(f.dir, "cards", `${branchSlug(branch)}.json`), "utf8"),
    ) as Card;
    expect(card.complexity).toEqual({ declared: null, method: "not-fetched", issues: 0 });
    expect(await readFile(f.log, "utf8")).not.toContain("nodes(ids:");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

describe("keepRating", () => {
  const next = (complexity: Card["complexity"], issue: number | null = 2): Card =>
    ({
      pr: { number: 1 },
      issue: { number: issue, type: null, labels: [] },
      complexity,
    }) as unknown as Card;
  const disk = (complexity: unknown, pr = 1, issue = 2) => ({
    pr: { number: pr },
    issue: { number: issue, type: null, labels: ["complexity:5", "complexity:unconfirmed"] },
    complexity,
  });
  const links = (
    closed: number[],
    partOf: number[] = [],
    closedElsewhere: number[] = [],
  ): IssueSelection => ({
    issue: null,
    closed,
    partOf,
    foreign: closedElsewhere.length > 0,
    closedElsewhere: closedElsewhere.map((number) => ({ repo: TRACKER, number })),
    partOfElsewhere: [],
    candidates: [],
  });

  test("keeps an unconfirmed rating over a null", () => {
    const kept = keepRating(
      disk({ declared: 5, method: "unconfirmed" }),
      next({ declared: null, method: "lookup-failed", issues: 0 }),
      links([2]),
    );

    expect(kept?.complexity).toEqual({ declared: 5, method: "unconfirmed", issues: 1 });
    expect(kept?.issue.labels).toEqual(["complexity:5", "complexity:unconfirmed"]);
  });

  test("keeps a confirmed rating over an unconfirmed one for the same issue", () => {
    const kept = keepRating(
      disk({ declared: 3, method: "confirmed" }),
      next({ declared: 3, method: "unconfirmed", issues: 1 }),
      links([2]),
    );

    expect(kept?.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
  });

  test("keeps a sum over a null when it covers every issue the pull request closes", () => {
    const kept = keepRating(
      disk({ declared: 4, method: "confirmed", issues: 2 }),
      next({ declared: null, method: "lookup-failed", issues: 0 }),
      links([2, 3]),
    );

    expect(kept?.complexity).toEqual({ declared: 4, method: "confirmed", issues: 2 });
  });

  test("never carries one issue's rating into a pull request that closes several", () => {
    const sum = next({ declared: 5, method: "unconfirmed", issues: 4 });

    expect(keepRating(disk({ declared: 1, method: "confirmed" }), sum, links([2, 3, 4, 5]))).toBe(
      sum,
    );
    expect(
      keepRating(
        disk({ declared: 1, method: "confirmed" }),
        next({ declared: null, method: "lookup-failed", issues: 0 }),
        links([2, 3, 4, 5]),
      ),
    ).toBeNull();
  });

  test("a Part of null drops a looked-up rating and keeps one a caller gave", () => {
    const partOf = next({ declared: null, method: "part-of", issues: 0 });

    expect(keepRating(disk({ declared: 8, method: "confirmed" }), partOf, links([], [2]))).toBe(
      partOf,
    );
    expect(
      keepRating(disk({ declared: 3, method: "manual" }), partOf, links([], [2]))?.complexity,
    ).toEqual({ declared: 3, method: "manual", issues: 1 });
  });

  test("keeps the rating but not an issue this run does not link to this repository", () => {
    const fresh = next({ declared: null, method: "not-fetched", issues: 0 }, null);
    const kept = keepRating(
      disk({ declared: 3, method: "confirmed" }, 1, 900619),
      fresh,
      links([]),
    );

    expect(kept?.complexity).toEqual({ declared: 3, method: "confirmed", issues: 1 });
    expect(kept?.issue).toEqual(fresh.issue);
  });

  test("takes a new confirmed rating over an old one", () => {
    const fresh = next({ declared: 6, method: "confirmed", issues: 2 });

    expect(keepRating(disk({ declared: 3, method: "confirmed" }), fresh, links([2, 3]))).toBe(
      fresh,
    );
  });

  test("counts the tracker issues a tracker-only sum covers", () => {
    const noIssue = {
      ...disk({ declared: 3, method: "manual" }),
      issue: { number: null, type: null, labels: [] },
    };

    expect(
      keepRating(
        noIssue,
        next({ declared: null, method: "not-fetched", issues: 0 }, null),
        links([], [], [900619, 900620, 900621]),
      ),
    ).toBeNull();
  });

  // Leaving a card as it is would keep a tracker number and its labels that a
  // rebuild strips, so a card whose issue this run does not link is rebuilt.
  test("rebuilds rather than leave a card naming an issue this run does not link here", () => {
    const fresh = next({ declared: null, method: "not-fetched", issues: 0 }, null);
    const tracked = {
      pr: { number: 1 },
      issue: { number: 900619, type: "Bug", labels: ["severity:high", "complexity:3"] },
      complexity: { declared: 3, method: "manual" },
    };

    expect(keepRating(tracked, fresh, links([], [], [900619, 900620]))).toBe(fresh);
  });

  test("rebuilds rather than leave a card carrying labels with no issue", () => {
    const fresh = next({ declared: null, method: "not-fetched", issues: 0 }, null);
    const labelled = {
      pr: { number: 1 },
      issue: { number: null, type: null, labels: ["severity:high", "complexity:3"] },
      complexity: { declared: 1, method: "manual" },
    };

    expect(keepRating(labelled, fresh, links([], [], [900619, 900620]))).toBe(fresh);
  });

  test("ignores a card on disk with no rating or for another pull request", () => {
    const fresh = next({ declared: null, method: "none", issues: 0 });

    expect(keepRating({ pr: { number: 1 } }, fresh, links([]))).toBe(fresh);
    expect(keepRating(disk({ declared: 3, method: "confirmed" }, 9), fresh, links([]))).toBe(fresh);
    expect(keepRating(null, fresh, links([]))).toBe(fresh);
  });
});
