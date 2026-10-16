/**
 * Starting, watching and stopping the stack's processes.
 *
 * Each child runs in its own process group with its output in a log file, never
 * a pipe: a pipe nobody drains fills up and blocks the server mid-request, and
 * a group can be killed whole, so `bun run` → `dev-env` → `vite` leaves no
 * grandchild holding a port for the next run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface Started {
  readonly name: string;
  /** Where its output goes, or null when it writes to the launcher's own terminal. */
  readonly logPath: string | null;
  readonly child: ChildProcess;
  /** Set once the process has exited, with its code or signal. */
  exit: string | null;
  /** Resolves with the exit code once the process exits; 1 when a signal ended it. */
  readonly exited: Promise<number>;
}

export function startProcess(options: {
  readonly name: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Omitted: the process shares the launcher's terminal (the Playwright runner). */
  readonly logPath?: string;
}): Started {
  const [file, ...args] = options.command;
  if (!file) throw new Error(`${options.name}: empty command`);
  const log = options.logPath === undefined ? null : openSync(options.logPath, "a");
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: log === null ? "inherit" : ["ignore", log, log],
    detached: true,
  });
  if (log !== null) closeSync(log);
  let resolveExited: (code: number) => void = () => undefined;
  const exited = new Promise<number>((done) => (resolveExited = done));
  const started: Started = {
    name: options.name,
    logPath: options.logPath ?? null,
    child,
    exit: null,
    exited,
  };
  child.once("exit", (code, signal) => {
    started.exit = signal ?? `code ${code}`;
    resolveExited(code ?? 1);
  });
  return started;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Resolves once `check` returns true, checking every `intervalMs`; resolves
 * false instead when `deadline` (epoch ms) passes first.
 */
async function pollUntil(
  check: () => Promise<boolean> | boolean,
  deadline: number,
  intervalMs: number,
): Promise<boolean> {
  if (await check()) return true;
  if (Date.now() >= deadline) return false;
  await pause(intervalMs);
  return pollUntil(check, deadline, intervalMs);
}

/**
 * Polls `probe` until it returns true. Fails early, naming the log, when the
 * process exits first — a server that crashed at boot otherwise looks exactly
 * like one that is slow to start, until the deadline.
 */
export async function waitUntilReady(
  proc: Started,
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  let exited = false;
  const ready = await pollUntil(
    async () => {
      exited = proc.exit !== null;
      return exited || (await probe().catch(() => false));
    },
    Date.now() + timeoutMs,
    250,
  );
  if (exited) {
    throw new Error(
      `${proc.name} exited (${proc.exit}) before it was ready; see ${proc.logPath ?? "its output above"}`,
    );
  }
  if (!ready) {
    throw new Error(
      `${proc.name} was not ready after ${timeoutMs / 1000}s; see ${proc.logPath ?? "its output above"}`,
    );
  }
}

/** True when `url` answers with any status below 500. */
export async function httpAnswers(url: string): Promise<boolean> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  return response.status < 500;
}

function signalGroup(proc: Started, signal: NodeJS.Signals): void {
  const pid = proc.child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Stops every group: SIGTERM, then SIGKILL after `graceMs` or once the leader
 * has gone. The SIGKILL goes to the whole group either way, because a leader
 * that exits on SIGTERM can leave a grandchild (`vite` under `bun run`) alive.
 */
export async function stopAll(procs: readonly Started[], graceMs = 5000): Promise<void> {
  for (const proc of procs) signalGroup(proc, "SIGTERM");
  const allExited = () => procs.every((p) => p.exit !== null);
  await pollUntil(allExited, Date.now() + graceMs, 100);
  for (const proc of procs) signalGroup(proc, "SIGKILL");
  await pollUntil(allExited, Number.POSITIVE_INFINITY, 50);
}

/**
 * On SIGINT or SIGTERM to this process, stops every group in `procs` (the
 * Playwright runner included) and anything else `teardown` names, then exits
 * 130. A signal sent to the launcher alone — `kill <pid>`, a `timeout` wrapper —
 * reaches no child, because each runs in its own process group.
 */
export function stopOnSignal(procs: readonly Started[], teardown: () => Promise<void>): void {
  const onSignal = (): void => {
    void stopAll(procs)
      .then(teardown)
      .then(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}
