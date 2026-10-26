import type { EngineInterface } from "claude-code";

import type { CheckRow } from "../types";
import { MAIN, firstLine, git, spawn } from "./spawn";

// CI's lint job, as its steps run it, from the pinned root. Each runs the
// checkout's own scripts, so only `/gates`, typed by the person, starts them.
export const CHECKS = [
  { name: "lint", timeoutMs: 120_000 },
  { name: "fmt:check", timeoutMs: 120_000 },
  { name: "lint-warning ceiling", timeoutMs: 300_000 },
] as const;

export type Check = (typeof CHECKS)[number];

// The command a check runs; null for the ceiling when the branch has no
// merge base with main to compare against.
async function argvOf($: EngineInterface, check: Check, root: string) {
  if (check.name === "lint") {
    return ["bash", "-c", "bash scripts/verify-vendored-anti-slop.sh && bun run lint"];
  }
  if (check.name === "fmt:check") return ["bun", "run", "fmt:check"];
  const base = await git($, root, "merge-base", MAIN, "HEAD");
  return base === null ? null : ["bash", "scripts/guard-lint-warnings.sh", "--base", base];
}

export async function runCheck($: EngineInterface, check: Check, root: string): Promise<CheckRow> {
  const { name } = check;
  const argv = await argvOf($, check, root);
  if (argv === null) return { name, verdict: "not-run", detail: `no merge base with ${MAIN}` };
  const ran = await spawn($, argv, { cwd: root, timeoutMs: check.timeoutMs });
  if (ran.kind !== "exited") return { name, verdict: ran.kind, detail: null };
  if (ran.exitCode === 0) return { name, verdict: "pass", detail: null };
  const detail = firstLine(ran.stdout) || firstLine(ran.stderr) || `exit ${ran.exitCode}`;
  return { name, verdict: "fail", detail };
}
