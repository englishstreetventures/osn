import type { EngineInterface } from "claude-code";

import type { ChangesetVerdict, Snapshot } from "../types";
import { parsePlan } from "./plan";
import type { Plan } from "./plan";
import { MAIN, git, printable } from "./spawn";

// NEW-FEAT.md is read only as a regular file of at most this many bytes.
const PLAN_LIMIT = 256 * 1024;

// The last changeset verdict and what it was worked out from: the changed
// files and the script's text.
export type ChangesetMemo = { key: string | null; verdict: ChangesetVerdict };

export type IssueRef = { ref: string; repo: string; number: string };

const linesOf = (text: string) => text.split("\n").filter(Boolean);

// A short digest of `git status --porcelain`, enough to tell that the
// working tree changed between two reads.
const digest = (text: string) => {
  let hash = 0x81_1c_9d_c5;
  for (const char of text) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  }
  return hash.toString(16);
};

async function readPlan($: EngineInterface, root: string): Promise<Plan | null> {
  const path = `${root}/NEW-FEAT.md`;
  try {
    const found = await $.fs.stat(path);
    if (found.kind !== "file" || found.isLink || found.size > PLAN_LIMIT) return null;
    return parsePlan(await $.fs.read(path));
  } catch {
    return null;
  }
}

// The first issue the `Issue:` line names, when it is `#<n>` or
// `<owner>/<repo>#<n>`.
export const issueRefOf = (issue: string | null): IssueRef | null => {
  const ref = issue?.split(",")[0]?.trim() ?? "";
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref);
  if (!match?.[2]) return null;
  return { ref, repo: match[1] ?? "englishstreetventures/osn", number: match[2] };
};

// The issue's `complexity:<digit>` label, with "(unconfirmed)" when that
// label is on it too; null when gh cannot say.
export async function lookupComplexity(
  $: EngineInterface,
  root: string,
  issue: IssueRef,
): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(
      [
        "gh",
        "issue",
        "view",
        issue.number,
        "--repo",
        issue.repo,
        "--json",
        "labels",
        "-q",
        ".labels[].name",
      ],
      { cwd: root, timeoutMs: 10_000 },
    );
    const labels = exitCode === 0 ? linesOf(stdout) : [];
    const digit = labels.map((name) => /^complexity:(\d)$/.exec(name)?.[1]).find(Boolean);
    if (!digit) return null;
    return labels.includes("complexity:unconfirmed") ? `${digit} (unconfirmed)` : digit;
  } catch {
    return null;
  }
}

// The changeset script of the worktree the mods load from: the folder that
// holds `.claude/mods/<mod>`. That is the copy the person chose to trust by
// loading the mods, and no ref of the session's repository stands in for it.
async function readScript($: EngineInterface) {
  const at = $.plugin.root.lastIndexOf("/.claude/mods/");
  if (at < 0) return null;
  try {
    return await $.fs.read(`${$.plugin.root.slice(0, at)}/scripts/changeset-required.sh`);
  } catch {
    return null;
  }
}

async function changesetOf(
  $: EngineInterface,
  root: string,
  diff: readonly string[] | null,
  memo: ChangesetMemo,
): Promise<ChangesetVerdict> {
  if (diff === null) return "unknown";
  if (diff.some((file) => /^\.changeset\/(?!README).*\.md$/.test(file))) return "present";
  if (diff.length === 0) return "not-needed";

  const script = await readScript($);
  if (script === null) return "unknown";
  const key = JSON.stringify([diff, script]);
  if (memo.key === key) return memo.verdict;

  let verdict: ChangesetVerdict = "unknown";
  try {
    const { exitCode, stdout } = await $.process.run(["bash", "-c", script], {
      cwd: root,
      stdin: `${diff.join("\n")}\n`,
      timeoutMs: 10_000,
    });
    const word = stdout.trim();
    if (exitCode === 0 && word === "required") verdict = "missing";
    if (exitCode === 0 && word === "skip") verdict = "not-needed";
  } catch {
    verdict = "unknown";
  }
  memo.key = key;
  memo.verdict = verdict;
  return verdict;
}

// One automatic refresh of the pinned root: four git reads at once and
// NEW-FEAT.md, never a script from the checkout. The complexity comes from
// what is already known; the caller fills it in when gh answers.
export async function measure(
  $: EngineInterface,
  root: string,
  complexities: ReadonlyMap<string, string | null>,
  memo: ChangesetMemo,
): Promise<Snapshot> {
  const [refs, ahead, diffText, status, plan] = await Promise.all([
    git($, root, "rev-parse", "HEAD", "--abbrev-ref", "HEAD"),
    git($, root, "rev-list", "--count", `${MAIN}..HEAD`),
    git($, root, "diff", "--name-only", `${MAIN}...HEAD`),
    git($, root, "--no-optional-locks", "status", "--porcelain"),
    readPlan($, root),
  ]);
  const [head = null, name = null] = refs === null ? [] : linesOf(refs);
  const branch =
    name === null
      ? "unknown branch"
      : name === "HEAD"
        ? `detached ${head?.slice(0, 7)}`
        : printable(name);
  const diff = diffText === null ? null : linesOf(diffText);
  const issue = plan?.issue ?? null;
  const ref = issueRefOf(issue);

  return {
    root,
    branch,
    head,
    statusMark: status === null ? null : digest(status),
    issue,
    complexity: ref === null ? null : (complexities.get(ref.ref) ?? null),
    hasPlan: plan !== null,
    gates: plan?.gates ?? [],
    ahead: ahead === null || diff === null ? null : Number(ahead),
    changedFiles: ahead === null || diff === null ? null : diff.length,
    dirtyFiles: status === null ? null : linesOf(status).length,
    changeset: await changesetOf($, root, diff, memo),
    refreshedAt: await $.clock.now(),
  };
}
