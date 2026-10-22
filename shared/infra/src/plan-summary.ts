/**
 * What one Alchemy run's log says it planned. Alchemy prints no JSON plan and
 * no distinguishing exit code, only a `Plan:` line (alchemy
 * src/Cli/LoggingCli.ts:84-135), so this reads that line.
 */
export type PlanSummary =
  | { readonly kind: "no-changes" }
  | { readonly kind: "no-resources" }
  | { readonly kind: "changes"; readonly counts: Readonly<Record<string, number>> }
  | { readonly kind: "missing" };

/** Actions Alchemy counts as `<n> to <action>`, in its order. */
const ACTIONS: readonly string[] = ["create", "update", "adopted", "replace", "delete", "orphaned"];
/** Counts Alchemy prints as `<n> <name>`, after the actions. */
const TOTALS: readonly string[] = ["binding changes", "tasks"];
/** The name a part of the plan line takes when Alchemy is not known to print it. */
const UNRECOGNISED = "unrecognised";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const PLAN = /Plan:\s+(.+?)\s*$/;
const PART = new RegExp(`^(\\d+) (?:to (${ACTIONS.join("|")})|(${TOTALS.join("|")}))$`);

/**
 * The plan in `output`, a log of an Alchemy run: colour is stripped, then the
 * last line holding `Plan:` decides, because `deploy` prints the plan again
 * when it applies. A part of that line Alchemy is not known to print counts
 * as `unrecognised`, so an unexpected format never reads as no change.
 */
export function summarisePlan(output: string): PlanSummary {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  const last = lines.map((line) => PLAN.exec(line)?.[1]).findLast((text) => text !== undefined);
  if (last === undefined) return { kind: "missing" };
  if (last === "no changes") return { kind: "no-changes" };
  if (last === "no resources") return { kind: "no-resources" };
  const counts = new Map<string, number>();
  for (const part of last.split(", ")) {
    const match = PART.exec(part);
    const name = match === null ? UNRECOGNISED : (match[2] ?? match[3]);
    const count = match === null ? 1 : Number(match[1]);
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return { kind: "changes", counts: Object.fromEntries(counts) };
}

/** The summary in words: numbers and fixed phrases only, never text from the log. */
export function describePlan(summary: PlanSummary): string {
  switch (summary.kind) {
    case "no-changes":
      return "no changes";
    case "no-resources":
      return "no resources";
    case "missing":
      return "no plan line in the Alchemy log";
    case "changes":
      return [...ACTIONS, ...TOTALS, UNRECOGNISED]
        .filter((name) => summary.counts[name] !== undefined)
        .map((name) =>
          ACTIONS.includes(name)
            ? `${summary.counts[name]} to ${name}`
            : `${summary.counts[name]} ${name}`,
        )
        .join(", ");
  }
}
