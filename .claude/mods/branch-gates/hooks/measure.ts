import type { EngineInterface } from "claude-code";

import type { ChangesetVerdict, Snapshot } from "../types";
import { parsePlan } from "./plan";
import type { Plan } from "./plan";
import { git } from "./spawn";

// Spelled in full: a tag or a local branch named `origin/main` would
// otherwise take precedence.
const MAIN = "refs/remotes/origin/main";

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
  try {
    return parsePlan(await $.fs.read(`${root}/NEW-FEAT.md`));
  } catch {
    return null;
  }
}

// The issue's `complexity:<digit>` label, with "(unconfirmed)" when that label
// is on it too. Asked of `gh` once per issue per load, failures included.
async function complexityOf(
  $: EngineInterface,
  issue: string | null,
  known: Map<string, string | null>,
) {
  const ref = issue?.split(",")[0]?.trim() ?? "";
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref);
  if (!match) return null;
  const held = known.get(ref);
  if (held !== undefined) return held;

  let found: string | null = null;
  try {
    const repo = match[1] ?? "englishstreetventures/osn";
    const { exitCode, stdout } = await $.process.run(
      [
        "gh",
        "issue",
        "view",
        match[2] ?? "",
        "--repo",
        repo,
        "--json",
        "labels",
        "-q",
        ".labels[].name",
      ],
      { timeoutMs: 10_000 },
    );
    const labels = exitCode === 0 ? linesOf(stdout) : [];
    const digit = labels.map((name) => /^complexity:(\d)$/.exec(name)?.[1]).find(Boolean);
    if (digit) found = labels.includes("complexity:unconfirmed") ? `${digit} (unconfirmed)` : digit;
  } catch {
    found = null;
  }
  known.set(ref, found);
  return found;
}

// Main's copy of the script decides, run from its blob so no checkout code
// runs on an automatic refresh.
async function changesetOf(
  $: EngineInterface,
  root: string,
  diff: readonly string[] | null,
): Promise<ChangesetVerdict> {
  if (diff === null) return "unknown";
  if (diff.some((file) => /^\.changeset\/(?!README).*\.md$/.test(file))) return "present";
  if (diff.length === 0) return "not-needed";

  const script = await git($, "cat-file", "blob", `${MAIN}:scripts/changeset-required.sh`);
  if (script === null) return "unknown";
  try {
    const { exitCode, stdout } = await $.process.run(["bash", "-c", script], {
      cwd: root,
      stdin: `${diff.join("\n")}\n`,
      timeoutMs: 10_000,
    });
    const word = stdout.trim();
    if (exitCode === 0 && word === "required") return "missing";
    if (exitCode === 0 && word === "skip") return "not-needed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// One automatic refresh: git and NEW-FEAT.md only, never checkout code.
export async function measure(
  $: EngineInterface,
  complexities: Map<string, string | null>,
): Promise<Snapshot> {
  const [root = ".", head = null] = linesOf(
    (await git($, "rev-parse", "--show-toplevel", "HEAD")) ?? "",
  );
  const branch =
    (await git($, "branch", "--show-current")) || `detached ${head?.slice(0, 7) ?? "?"}`;
  const plan = await readPlan($, root);

  const hasBase = (await git($, "rev-parse", "--verify", "-q", MAIN)) !== null;
  const ahead = hasBase ? await git($, "rev-list", "--count", `${MAIN}..HEAD`) : null;
  const diffText = hasBase ? await git($, "diff", "--name-only", `${MAIN}...HEAD`) : null;
  const diff = diffText === null ? null : linesOf(diffText);
  const status = await git($, "status", "--porcelain");
  const issue = plan?.issue ?? null;

  return {
    root,
    branch,
    head,
    statusMark: status === null ? null : digest(status),
    issue,
    complexity: await complexityOf($, issue, complexities),
    hasPlan: plan !== null,
    gates: plan?.gates ?? [],
    ahead: ahead === null || diff === null ? null : Number(ahead),
    changedFiles: ahead === null || diff === null ? null : diff.length,
    dirtyFiles: status === null ? null : linesOf(status).length,
    changeset: await changesetOf($, root, diff),
    refreshedAt: await $.clock.now(),
  };
}
