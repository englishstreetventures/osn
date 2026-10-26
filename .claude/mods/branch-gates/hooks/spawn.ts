import type { EngineInterface } from "claude-code";

// Spelled in full: a tag or a local branch named `origin/main` would
// otherwise take precedence.
export const MAIN = "refs/remotes/origin/main";

// How a child run ended: exited with a code, or rejected, which is a timeout
// once at least its timeout has passed and a failed start before that.
export type Spawned =
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string }
  | { kind: "timed-out" }
  | { kind: "could-not-start" };

export type SpawnInit = { timeoutMs: number; cwd: string; stdin?: string };

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

// The text with every C0 and C1 control character removed, so nothing read
// from a checkout or a remote reaches a surface as a terminal sequence.
export const printable = (text: string) =>
  [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join("");

// The first line of a child's output that holds anything, printable and cut
// to 200 characters; empty when there is none.
export const firstLine = (text: string) =>
  printable(
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "",
  )
    .trim()
    .slice(0, 200);

// What git prints in `cwd`, trimmed, or null when it exits non-zero or
// cannot run.
export async function git($: EngineInterface, cwd: string, ...args: string[]) {
  try {
    const { exitCode, stdout } = await $.process.run(["git", ...args], { cwd, timeoutMs: 10_000 });
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}
