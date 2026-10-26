import type { EngineInterface } from "claude-code";

// How a child run ended: exited with a code, or rejected, which is a timeout
// once at least its timeout has passed and a failed start before that.
export type Spawned =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string }
  | { kind: "timed-out" }
  | { kind: "could-not-start" };

export type SpawnInit = { timeoutMs: number; cwd?: string; stdin?: string };

export async function spawn(
  $: EngineInterface,
  argv: readonly string[],
  init: SpawnInit,
): Promise<Spawned> {
  const startedAt = await $.clock.now();
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, init);
    return { kind: "exited", exitCode, stdout, stderr };
  } catch {
    const elapsed = (await $.clock.now()) - startedAt;
    return elapsed >= init.timeoutMs ? { kind: "timed-out" } : { kind: "could-not-start" };
  }
}

// The first line of a child's output that holds anything, cut to 200
// characters; empty when there is none.
export const firstLine = (text: string) =>
  (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  ).slice(0, 200);

// What git prints, trimmed, or null when it exits non-zero or cannot run.
export async function git($: EngineInterface, ...args: string[]) {
  try {
    const { exitCode, stdout } = await $.process.run(["git", ...args], { timeoutMs: 10_000 });
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}
