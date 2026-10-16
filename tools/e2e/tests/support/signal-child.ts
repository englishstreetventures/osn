/**
 * A launcher in miniature for `processes.test.ts`: starts `sleep` the way the
 * launcher starts the Playwright runner (own group, no log file), wires the
 * same signal teardown, writes the sleeper's pid to argv[2], and waits.
 */
import { writeFileSync } from "node:fs";

import { startProcess, stopOnSignal, type Started } from "../../src/processes";

const pidFile = process.argv[2] ?? "";
const procs: Started[] = [];
stopOnSignal(procs, async () => undefined);
const sleeper = startProcess({
  name: "runner",
  command: ["sleep", "30"],
  cwd: process.cwd(),
  env: { PATH: process.env["PATH"] ?? "" },
});
procs.push(sleeper);
writeFileSync(pidFile, String(sleeper.child.pid));
await sleeper.exited;
