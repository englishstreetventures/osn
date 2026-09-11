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

import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ChangedFile, numstatFromApi } from "../backfill";
import { parseNumstat } from "../index";

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
    expect(calls).toContain(`repos/xchromo/osn/pulls/${PR}/files`);
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

// `wiki/observability/session-metrics.md` §Backfilling states this rule and
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

    // `pr list`, one `api graphql`, one `/files` for the single carded PR.
    expect(calls).toHaveLength(3);
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
    printf '%s' '[{"number":5001,"headRefName":"${branchA}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","closingIssuesReferences":[{"id":"I_test_970","number":970,"repository":{"name":"osn","owner":{"login":"xchromo"}}}]},{"number":5002,"headRefName":"${branchB}","mergedAt":"2026-09-09T13:00:00Z","baseRefOid":"ccc","headRefOid":"ddd","closingIssuesReferences":[{"id":"I_test_200","number":200,"repository":{"name":"osn","owner":{"login":"xchromo"}}}]}]' ;;
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

// `wiki/observability/session-metrics.md` §Backfilling: a linked issue outside
// this repository — chiefly the private `xchromo/osn-tracker`, which closes
// most of this repository's pull requests — is never fetched at all, because
// its labels can carry a severity/area pair that must not reach a card
// committed here. `method: "not-fetched"` says so, distinct from `"none"`.
test("a linked issue outside this repository is never fetched", async () => {
  const f = await fixture({ withTranscript: false });
  try {
    const branch = "feat/tracker-linked";
    const slug = "feat-tracker-linked";

    await writeFile(
      join(f.binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$*" in
  *"pr list"*)
    printf '%s' '[{"number":6001,"headRefName":"${branch}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","closingIssuesReferences":[{"id":"I_test_tracker_619","number":619,"repository":{"name":"osn-tracker","owner":{"login":"xchromo"}}}]}]' ;;
  *"nodes(ids:"*)
    printf '%s' 'SHOULD NOT BE CALLED' ;;
  *"api graphql"*)
    printf '%s' '{"data":{"repository":{"p6001":{"commits":{"totalCount":1}}}}}' ;;
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
      join(project, "sess-tracker.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-tracker",
        gitBranch: branch,
        requestId: "req-tracker",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 50 } },
      })}\n`,
    );

    const run = await runBackfill(f);
    expect(run.exitCode).toBe(0);

    // The filter excludes it before any fetch — not merely fails softly.
    const calls = await readFile(f.log, "utf8");
    expect(calls).not.toContain("nodes(ids:");

    const card = JSON.parse(await readFile(join(f.dir, "cards", `${slug}.json`), "utf8")) as {
      issue: { number: number | null; labels: string[] };
      complexity: { declared: number | null; method: string };
    };
    expect(card.issue.number).toBe(619);
    expect(card.issue.labels).toEqual([]);
    expect(card.complexity.declared).toBeNull();
    expect(card.complexity.method).toBe("not-fetched");
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
    printf '%s' '[{"number":7001,"headRefName":"${branch}","mergedAt":"2026-09-09T12:00:00Z","baseRefOid":"aaa","headRefOid":"bbb","closingIssuesReferences":[{"id":"I_test_vanished","number":444,"repository":{"name":"osn","owner":{"login":"xchromo"}}}]}]' ;;
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
