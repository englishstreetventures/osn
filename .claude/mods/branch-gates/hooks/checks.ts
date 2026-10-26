import type { EngineInterface } from "claude-code";

import type { CheckRow } from "../types";
import { firstLine, spawn } from "./spawn";

// CI's lint job, as its steps run it, from the worktree root. Each runs the
// checkout's own scripts, so only `/gates`, typed by the person, starts them.
export const CHECKS = [
  {
    name: "lint",
    argv: ["bash", "-c", "bash scripts/verify-vendored-anti-slop.sh && bun run lint"],
    timeoutMs: 120_000,
  },
  { name: "fmt:check", argv: ["bun", "run", "fmt:check"], timeoutMs: 120_000 },
  {
    name: "lint-warning ceiling",
    argv: [
      "bash",
      "-c",
      'bash scripts/guard-lint-warnings.sh --base "$(git merge-base refs/remotes/origin/main HEAD)"',
    ],
    timeoutMs: 300_000,
  },
] as const;

export type Check = (typeof CHECKS)[number];

export async function runCheck($: EngineInterface, check: Check, root: string): Promise<CheckRow> {
  const { name } = check;
  const ran = await spawn($, check.argv, { cwd: root, timeoutMs: check.timeoutMs });
  if (ran.kind !== "exited") return { name, verdict: ran.kind, detail: null };
  if (ran.exitCode === 0) return { name, verdict: "pass", detail: null };
  const detail = firstLine(ran.stdout) || firstLine(ran.stderr) || `exit ${ran.exitCode}`;
  return { name, verdict: "fail", detail };
}
