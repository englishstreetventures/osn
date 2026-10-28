#!/usr/bin/env bun
/**
 * Summarises one Alchemy run's plan from its log:
 * `bun run plan-summary -- --stack <stack> [--expect-no-change] <log file>`.
 * Appends `### <stack>: <summary>` to `$GITHUB_STEP_SUMMARY` (stdout when
 * unset): counts only, never a line of the log, which can carry
 * account-level values. Without `--expect-no-change` it exits 0 whatever the
 * plan, warning when the log holds no plan line, so it never fails a deploy
 * that did not ask for the check. With it, it exits 1 unless the plan is
 * `no changes`. Exits 2 on bad arguments.
 *
 * It also reads the plan as the production plan guard does and warns, still
 * exiting 0, at each fault the guard would refuse in its text alone (a line
 * it cannot read, lines that disagree with the Plan line's counts), so a dev
 * deploy after an Alchemy upgrade that changed the plan's format says so
 * before a production release refuses its plan.
 */
import { appendFileSync, readFileSync } from "node:fs";

import { parsePlan, planTextFaults } from "../src/plan-guard";
import { describePlan, summarisePlan } from "../src/plan-summary";
import { STACK_KEYS, type StackKey } from "../src/stacks";

interface Arguments {
  readonly stack: StackKey;
  readonly expectNoChange: boolean;
  readonly log: string;
}

function parseArguments(argv: readonly string[]): Arguments {
  const args = argv.filter((arg) => arg !== "--");
  const at = args.indexOf("--stack");
  const stack = STACK_KEYS.find((key) => key === args[at + 1]);
  const rest = args.filter(
    (arg, index) => index !== at && index !== at + 1 && arg !== "--expect-no-change",
  );
  if (at === -1 || stack === undefined || rest.length !== 1 || rest[0].startsWith("--")) {
    throw new Error(
      `pass --stack <${STACK_KEYS.join("|")}>, optionally --expect-no-change, and the log file`,
    );
  }
  return { stack, expectNoChange: args.includes("--expect-no-change"), log: rest[0] };
}

let input: Arguments;
try {
  input = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

let log = "";
try {
  log = readFileSync(input.log, "utf8");
} catch {
  // An unreadable log holds no plan line, which the check below reports.
}

const summary = summarisePlan(log);
const described = describePlan(summary);
const heading = `### ${input.stack}: ${described}\n`;
const summaryFile = process.env.GITHUB_STEP_SUMMARY ?? "";
if (summaryFile === "") process.stdout.write(heading);
else appendFileSync(summaryFile, heading);

if (summary.kind === "missing") {
  process.stdout.write(`::warning::${input.stack}: ${described}.\n`);
}
// Each fault is a fixed phrase and at most a resource's logical id, as the
// guard prints it in a production run.
for (const fault of planTextFaults(parsePlan(log))) {
  process.stdout.write(
    `::warning::${input.stack}: the production plan guard would refuse this plan's text: ${fault}. If Alchemy's output changed, fix parsePlan (shared/infra/src/plan-guard.ts) before a production release plans this stack.\n`,
  );
}
if (input.expectNoChange && summary.kind !== "no-changes") {
  process.stdout.write(
    `::error::${input.stack}: expected 'Plan: no changes', got ${described}. A second deploy of the same commit must plan no change.\n`,
  );
  process.exit(1);
}
