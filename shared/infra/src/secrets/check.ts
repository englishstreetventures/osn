import type { Tier } from "../stage";
import {
  formatDiffs,
  githubDiff,
  isClean,
  liveDiff,
  liveExpectations,
  parseWranglerSecretList,
  redactAccountIds,
  type NameDiff,
} from "./compare";

/** What one run of an outside tool (`wrangler`, `gh`) left behind. */
export interface ToolRun {
  /** Exit status; null when the tool did not start. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the tool did not start. */
  readonly startError?: string;
}

/** What a check script prints and the code it exits with. */
export interface CheckOutcome {
  /** 0 nothing wrong, 1 a difference that fails the check, 2 a tool failed or printed something unreadable. */
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const toolFailure = (command: string, run: ToolRun): CheckOutcome => ({
  exitCode: 2,
  stdout: "",
  stderr: redactAccountIds(
    run.status === null
      ? `${command} did not run: ${run.startError ?? "unknown error"}\n`
      : `${command} exited ${run.status}\n${run.stderr}`,
  ),
});

/**
 * Lists every live Worker of `tier` with `listSecrets` and compares each with
 * the inventory. The first call runs alone, so a login whose access token has
 * expired refreshes it once; the rest then run together. Output stays in
 * inventory order, and a tool failure names the first failing Worker in that
 * order. Exits 1 on any missing, unexpected or forbidden name.
 */
export async function checkLive(
  tier: Tier,
  listSecrets: (scriptName: string) => Promise<ToolRun>,
): Promise<CheckOutcome> {
  const expectations = liveExpectations(tier);
  const [first, ...rest] = expectations;
  if (first === undefined) return { exitCode: 0, stdout: "", stderr: "" };
  const listed = async (expected: (typeof expectations)[number]) => ({
    expected,
    run: await listSecrets(expected.scriptName),
  });
  const firstResult = await listed(first);
  const results =
    firstResult.run.status === 0
      ? [firstResult, ...(await Promise.all(rest.map(listed)))]
      : [firstResult];
  const diffs: NameDiff[] = [];
  for (const { expected, run } of results) {
    const command = `wrangler secret list --name ${expected.scriptName}`;
    if (run.status !== 0) return toolFailure(command, run);
    let names: string[];
    try {
      names = parseWranglerSecretList(run.stdout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 2,
        stdout: "",
        stderr: redactAccountIds(`${command} printed output this check cannot read: ${reason}\n`),
      };
    }
    diffs.push(liveDiff(expected, names));
  }
  return { exitCode: diffs.every(isClean) ? 0 : 1, stdout: formatDiffs(diffs), stderr: "" };
}

/** The `gh` arguments that print one Environment's secret names, one per line. */
export const githubSecretNamesArgs = (tier: Tier): readonly string[] => [
  "api",
  "--paginate",
  `repos/{owner}/{repo}/environments/${tier}/secrets`,
  "--jq",
  ".secrets[].name",
];

/**
 * Compares the names `listNames` prints (one per line) with what `tier`'s
 * GitHub Environment must hold (`githubExpectations`). A missing name or a
 * forbidden credential (`forbiddenCredentials`) exits 1; a name the inventory
 * does not know is printed and exits 0.
 */
export async function checkGithub(
  tier: Tier,
  listNames: () => Promise<ToolRun>,
): Promise<CheckOutcome> {
  const run = await listNames();
  if (run.status !== 0) return toolFailure(`gh ${githubSecretNamesArgs(tier).join(" ")}`, run);
  const diff = githubDiff(
    tier,
    run.stdout.split("\n").filter((name) => name !== ""),
  );
  return {
    exitCode: diff.missing.length === 0 && diff.forbidden.length === 0 ? 0 : 1,
    stdout: formatDiffs([diff]),
    stderr: "",
  };
}
