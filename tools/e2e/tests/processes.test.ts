import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startProcess, stopAll, waitUntilReady } from "../src/processes";

const logDir = mkdtempSync(join(tmpdir(), "e2e-processes-"));
const env = { PATH: process.env["PATH"] ?? "" };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("waitUntilReady", () => {
  test("fails at once, naming the log, when the process exits before it is ready", async () => {
    const proc = startProcess({
      name: "crasher",
      command: ["sh", "-c", "echo boom; exit 3"],
      cwd: logDir,
      env,
      logPath: join(logDir, "crasher.log"),
    });
    const started = Date.now();
    await expect(waitUntilReady(proc, async () => false, 30_000)).rejects.toThrow(
      /crasher exited \(code 3\) before it was ready; see .*crasher\.log/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(join(logDir, "crasher.log"), "utf8")).toContain("boom");
  });

  test("fails at the deadline when the process never becomes ready", async () => {
    const proc = startProcess({
      name: "sleeper",
      command: ["sleep", "30"],
      cwd: logDir,
      env,
      logPath: join(logDir, "sleeper.log"),
    });
    try {
      await expect(waitUntilReady(proc, async () => false, 500)).rejects.toThrow(
        /sleeper was not ready after 0\.5s/,
      );
    } finally {
      await stopAll([proc], 500);
    }
  });
});

describe("stopAll", () => {
  test("kills the whole process group, grandchildren included", async () => {
    const pidFile = join(logDir, "grandchild.pid");
    // The leader starts a grandchild that ignores SIGTERM, records its pid and waits.
    const proc = startProcess({
      name: "family",
      command: ["sh", "-c", `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 30' & wait`],
      cwd: logDir,
      env,
      logPath: join(logDir, "family.log"),
    });
    await waitUntilReady(
      proc,
      async () => readFileSync(pidFile, { encoding: "utf8", flag: "a+" }).trim() !== "",
      5000,
    );
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(grandchild)).toBe(true);

    await stopAll([proc], 500);

    expect(proc.exit).not.toBeNull();
    // SIGKILL is delivered at once, but the pid lingers until it is reaped.
    for (let i = 0; i < 40 && alive(grandchild); i++) await Bun.sleep(50);
    expect(alive(grandchild)).toBe(false);
  });
});

describe("stopOnSignal", () => {
  test("SIGTERM to the launcher alone stops the runner it started", async () => {
    const pidFile = join(logDir, "runner.pid");
    const launcher = Bun.spawn(
      ["bun", join(import.meta.dirname, "support/signal-child.ts"), pidFile],
      { stdout: "ignore", stderr: "ignore" },
    );
    const readPid = (): number =>
      Number(readFileSync(pidFile, { encoding: "utf8", flag: "a+" }).trim() || "0");
    for (let i = 0; i < 200 && readPid() === 0; i++) await Bun.sleep(50);
    const runner = readPid();
    expect(alive(runner)).toBe(true);

    launcher.kill("SIGTERM");
    expect(await launcher.exited).toBe(130);
    for (let i = 0; i < 40 && alive(runner); i++) await Bun.sleep(50);
    expect(alive(runner)).toBe(false);
  });
});
