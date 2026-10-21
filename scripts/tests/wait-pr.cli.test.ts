// Runs scripts/wait-pr.sh as a subprocess against a stub `gh` and a no-op
// `sleep` placed first on PATH, so every exit is reached without a network and
// without waiting. Each stub call answers from the next numbered file the test
// wrote (`api.1`, `api.2`, … then `api.default`), and a `.err` file beside one
// makes that call fail with its text on stderr.
//
// One case per decision the script makes:
//   merged or closed → 0 · DIRTY → 1 · a failed check → 1
//   no check pending, seen twice running → 0 (once is not enough)
//   pending, or no checks yet, at the deadline → 2
//   a pull request gh cannot resolve, or a rejected login → 3 at once
//   a rate limit → 2 at once · any other gh failure → wait on, then 2
//   a non-numeric argument → 3, and nothing in it is evaluated
//   WAIT_PR_REPO names the repository both calls ask about

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../wait-pr.sh", import.meta.url).pathname;

const GH_STUB = `#!/usr/bin/env bash
dir=$(dirname "$0")
case "$1" in api) kind=api ;; pr) kind=checks ;; *) exit 99 ;; esac
printf '%s\\n' "$*" >> "$dir/$kind.args"
n=$(( $(cat "$dir/$kind.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/$kind.count"
f="$dir/$kind.$n"; [ -f "$f" ] || [ -f "$f.err" ] || f="$dir/$kind.default"
if [ -f "$f.err" ]; then cat "$f.err" >&2; exit 1; fi
[ -f "$f" ] && cat "$f"
exit 0
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wait-pr-"));
  await writeFile(join(dir, "gh"), GH_STUB, { mode: 0o755 });
  await writeFile(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function answers(kind: "api" | "checks", ...lines: readonly string[]) {
  for (const [i, line] of lines.entries())
    await writeFile(join(dir, `${kind}.${i + 1}`), `${line}\n`);
}

async function fail(kind: "api" | "checks", n: number, stderr: string) {
  await writeFile(join(dir, `${kind}.${n}.err`), `${stderr}\n`);
}

async function calls(kind: "api" | "checks"): Promise<number> {
  return existsSync(join(dir, `${kind}.count`))
    ? Number(await readFile(join(dir, `${kind}.count`), "utf8"))
    : 0;
}

async function run(args: readonly string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, PATH: `${dir}:${Bun.env.PATH}`, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

test("a merged pull request ends the wait at once, exit 0, without reading checks", async () => {
  await answers("api", "MERGED UNKNOWN SUCCESS");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("terminal:");
  expect(r.stdout).toContain("MERGED");
  expect(await calls("checks")).toBe(0);
});

test("a closed pull request ends the wait, exit 0", async () => {
  await answers("api", "CLOSED UNKNOWN NONE");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("CLOSED");
});

test("a pull request that conflicts with its base ends the wait, exit 1", async () => {
  await answers("api", "OPEN DIRTY NONE");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("conflicts with its base");
});

test("a failed check ends the wait, exit 1, naming the buckets", async () => {
  await answers("api", "OPEN BLOCKED FAILURE");
  await answers("checks", "fail=1 pass=6 pending=2");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("a check failed");
  expect(r.stdout).toContain("fail=1");
});

test("no check pending must be seen on two polls running before it ends the wait", async () => {
  await answers("api", "OPEN CLEAN SUCCESS", "OPEN CLEAN SUCCESS");
  await answers("checks", "pass=8 skipping=1", "pass=8 skipping=1");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("no check pending");
  expect(await calls("api")).toBe(2);
});

test("a check that registers late resets the count, so the wait goes on", async () => {
  await answers("api", "OPEN CLEAN SUCCESS", "OPEN BLOCKED SUCCESS", "OPEN CLEAN SUCCESS");
  await answers("checks", "pass=7 skipping=1", "pass=8 skipping=1", "pass=8 skipping=1");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("pass=8");
  expect(await calls("api")).toBe(3);
});

test("cancelled checks with nothing pending end the wait, exit 0, and the line shows them", async () => {
  await answers("api", "OPEN BLOCKED FAILURE", "OPEN BLOCKED FAILURE");
  await answers("checks", "cancel=1 pass=7", "cancel=1 pass=7");
  const r = await run(["12", "1"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("cancel=1");
});

test("checks still pending at the deadline end the wait, exit 2, with the last state", async () => {
  await answers("api", "OPEN BLOCKED PENDING");
  const r = await run(["12", "0"]);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("timeout after 0 min");
  expect(r.stdout).toContain("PENDING");
  expect(await calls("checks")).toBe(0);
});

test("no checks registered yet is not terminal: the deadline ends it, exit 2", async () => {
  await answers("api", "OPEN BLOCKED NONE");
  const r = await run(["12", "0"]);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("timeout");
});

test("a pull request gh cannot resolve ends the wait after one call, exit 3", async () => {
  await fail("api", 1, "gh: Could not resolve to a PullRequest with the number of 999999.");
  const r = await run(["999999", "30"]);
  expect(r.exitCode).toBe(3);
  expect(r.stdout).toContain("Could not resolve");
  expect(await calls("api")).toBe(1);
});

test("a rejected login ends the wait after one call, exit 3", async () => {
  await fail("api", 1, "HTTP 401: Bad credentials (https://api.github.com/graphql)");
  const r = await run(["12", "30"]);
  expect(r.exitCode).toBe(3);
  expect(await calls("api")).toBe(1);
});

test("a rate limit ends the wait after one call, exit 2", async () => {
  await fail("api", 1, "GraphQL: API rate limit exceeded for user ID 1.");
  const r = await run(["12", "30"]);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("rate limit");
  expect(await calls("api")).toBe(1);
});

test("any other gh failure counts as no answer yet, and the deadline ends it, exit 2", async () => {
  await fail("api", 1, "error connecting to api.github.com");
  const r = await run(["12", "0"]);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("no answer from gh yet");
});

test("a non-numeric pull request or deadline is refused, exit 3, and never evaluated", async () => {
  expect((await run(["abc"])).exitCode).toBe(3);
  const marker = join(dir, "evaluated");
  const r = await run(["12", `a[$(touch ${marker})]`]);
  expect(r.exitCode).toBe(3);
  expect(existsSync(marker)).toBe(false);
  expect(await calls("api")).toBe(0);
});

test("WAIT_PR_REPO names the repository both calls ask about", async () => {
  await answers("api", "OPEN BLOCKED FAILURE");
  await answers("checks", "fail=1 pass=1");
  const r = await run(["12", "1"], { WAIT_PR_REPO: "someone/elsewhere" });
  expect(r.exitCode).toBe(1);
  expect(await readFile(join(dir, "api.args"), "utf8")).toContain("o=someone");
  expect(await readFile(join(dir, "api.args"), "utf8")).toContain("name=elsewhere");
  expect(await readFile(join(dir, "checks.args"), "utf8")).toContain("--repo someone/elsewhere");
});

// ── --until-merged: for a pull request handed to the merge queue ─────────────
// Each answer adds whether it sits in the queue and whether auto-merge is on.

test("--until-merged waits past green checks while queued, and ends at MERGED, exit 0", async () => {
  await answers(
    "api",
    "OPEN BLOCKED SUCCESS false true",
    "OPEN BLOCKED SUCCESS true true",
    "MERGED UNKNOWN SUCCESS false false",
  );
  const r = await run(["--until-merged", "12", "1"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("MERGED");
  expect(await calls("api")).toBe(3);
  expect(await calls("checks")).toBe(0);
});

test("--until-merged reports a pull request the queue ejected, exit 1", async () => {
  await answers("api", "OPEN BLOCKED SUCCESS true true", "OPEN BLOCKED FAILURE false false");
  const r = await run(["--until-merged", "12", "1"]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("left the merge queue without merging");
});

test("--until-merged reports a closed pull request as not merged, exit 1", async () => {
  await answers("api", "CLOSED UNKNOWN NONE false false");
  const r = await run(["--until-merged", "12", "1"]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("CLOSED");
});

test("--until-merged still stops at once on a conflict, exit 1", async () => {
  await answers("api", "OPEN DIRTY NONE false true");
  const r = await run(["--until-merged", "12", "1"]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("conflicts with its base");
});

test("--until-merged asks GitHub about the queue; the default wait does not", async () => {
  await answers("api", "MERGED UNKNOWN SUCCESS false false");
  await run(["--until-merged", "12", "1"]);
  expect(await readFile(join(dir, "api.args"), "utf8")).toContain("isInMergeQueue");
  await rm(join(dir, "api.args"));
  // The stub's answers are numbered across runs; this is the second call.
  await writeFile(join(dir, "api.2"), "MERGED UNKNOWN SUCCESS\n");
  await run(["12", "1"]);
  expect(await readFile(join(dir, "api.args"), "utf8")).not.toContain("isInMergeQueue");
});
