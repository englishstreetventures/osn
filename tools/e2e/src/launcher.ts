/**
 * `bun run test:e2e`: boots the stack, runs the flows, tears everything down.
 *
 *  1. Refuse to start if any fixed port is taken, leaving the last run's artifacts.
 *  2. Clear `e2e-artifacts/` — no state or artifact survives from a previous run.
 *  3. Prove the shared clock reaches a Bun and a Node child.
 *  4. Seed fresh databases.
 *  5. Start the mail stand-in, then every app: osn-api before pulse-api, the
 *     rest alongside them.
 *  6. Run Playwright, which writes traces, screenshots and `results.json`.
 *  7. Stop every process group, the runner's included, whatever happened above
 *     and on SIGINT or SIGTERM.
 *
 * Exits with Playwright's code, or 1 when the stack never came up.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  ARTIFACT_DIR,
  CLOCK_T0,
  DB_FILES,
  LOG_DIR,
  PORTS,
  SCREENSHOT_DIR,
  STATE_DIR,
  TRACE_DIR,
} from "./config";
import { startMailServer, type MailServer } from "./mail";
import { takenPorts } from "./ports";
import {
  httpAnswers,
  startProcess,
  stopAll,
  stopOnSignal,
  waitUntilReady,
  type Started,
} from "./processes";
import { seedOsn, seedPulse } from "./seed";
import { API_COMMAND, appDir, appSpecs, baseEnv } from "./stack";

const PACKAGE_DIR = resolve(import.meta.dirname, "..");
const READY_TIMEOUT_MS = 120_000;

const say = (line: string): void => {
  process.stderr.write(`e2e: ${line}\n`);
};

/**
 * What a child reports about its clock: `Date.now()`, `new Date()`, `Date()`,
 * whether `new Date()` is still a `Date`, and whether an explicit date is left
 * alone. One line per trap in `clock.mjs`.
 */
const CLOCK_PROBE = [
  "const d = new Date();",
  "process.stdout.write(JSON.stringify({",
  "now: Date.now(), constructed: d.getTime(), called: Date.parse(Date()),",
  "isDate: d instanceof Date, explicit: new Date(0).getTime() }));",
].join(" ");

interface ClockReport {
  readonly now: number;
  readonly constructed: number;
  readonly called: number;
  readonly isDate: boolean;
  readonly explicit: number;
}

/** Within a minute of the suite's start instant: the clock ticks from the launcher's start. */
const onSuiteClock = (ms: number): boolean => ms >= CLOCK_T0 - 1000 && ms < CLOCK_T0 + 60_000;

/**
 * Runs the probe the way the stack runs its children — Bun with the API flags,
 * Node with the children's `NODE_OPTIONS` — and names every trap that did not
 * hold. A clock that fails to load otherwise shows up only as a closed RSVP or
 * a "start time is in the past", and only once the real date moves on.
 */
export function clockReaches(env: Record<string, string>): string[] {
  const failures: string[] = [];
  for (const [runtime, args] of [
    ["bun", [...API_COMMAND.slice(1, -1), "-e", CLOCK_PROBE]],
    ["node", ["-e", CLOCK_PROBE]],
  ] as const) {
    const out = spawnSync(runtime, args, { env, encoding: "utf8" });
    let report: ClockReport;
    try {
      report = JSON.parse(out.stdout) as ClockReport;
    } catch {
      failures.push(`${runtime}: no clock report (${out.stderr.trim()})`);
      continue;
    }
    if (!onSuiteClock(report.now)) failures.push(`${runtime}: Date.now() is ${report.now}`);
    if (!onSuiteClock(report.constructed)) {
      failures.push(`${runtime}: new Date() is ${report.constructed}`);
    }
    // `Date()` has whole-second resolution.
    if (!onSuiteClock(report.called)) failures.push(`${runtime}: Date() is ${report.called}`);
    if (!report.isDate) failures.push(`${runtime}: new Date() is not instanceof Date`);
    if (report.explicit !== 0) failures.push(`${runtime}: new Date(0) is ${report.explicit}`);
  }
  return failures;
}

/**
 * Checks the ports, then clears the artifact directory — in that order, so a
 * refused run leaves the previous run's traces and logs (usually the reason
 * the ports are still held) and never unlinks a live run's databases.
 * Returns the ports in use; empty means the directory is fresh.
 */
export async function prepareRun(
  ports: Readonly<Record<string, number>>,
  artifactDir: string,
  subdirs: readonly string[],
): Promise<Array<{ name: string; port: number }>> {
  const taken = await takenPorts(ports);
  if (taken.length > 0) return taken;
  rmSync(artifactDir, { recursive: true, force: true });
  for (const dir of subdirs) mkdirSync(dir, { recursive: true });
  return [];
}

function pulseKeyRegistered(): boolean {
  const sqlite = new Database(DB_FILES.osn, { readonly: true });
  try {
    const row = sqlite
      .query("SELECT count(*) AS n FROM service_account_keys WHERE service_id = 'pulse-api'")
      .get() as { n: number };
    return row.n > 0;
  } finally {
    sqlite.close();
  }
}

async function bootStack(realStart: number, procs: Started[]): Promise<void> {
  const env = baseEnv(process.env, realStart);

  const clockFailures = clockReaches(env);
  if (clockFailures.length > 0) throw new Error(`clock preload: ${clockFailures.join("; ")}`);

  seedOsn(DB_FILES.osn);
  seedPulse(DB_FILES.pulse);

  const specs = appSpecs();
  const start = (spec: (typeof specs)[number]): Started => {
    say(`starting ${spec.name}`);
    const proc = startProcess({
      name: spec.name,
      command: spec.command,
      cwd: appDir(spec),
      env: { ...env, ...spec.env },
      logPath: resolve(LOG_DIR, `${spec.name}.log`),
    });
    procs.push(proc);
    return proc;
  };
  const ready = (spec: (typeof specs)[number], proc: Started) =>
    waitUntilReady(proc, () => httpAnswers(spec.readyUrl), READY_TIMEOUT_MS);

  // One ordering matters: pulse-api registers its service key with osn-api
  // once, at boot, so it starts after osn-api answers and counts as ready only
  // once its key is in osn-api's database. Everything else boots alongside.
  const [osn, pulse] = [
    specs.find((s) => s.name === "osnApi"),
    specs.find((s) => s.name === "pulseApi"),
  ];
  if (!osn || !pulse) throw new Error("stack: osnApi and pulseApi must both be defined");
  const identityChain = async (): Promise<void> => {
    await ready(osn, start(osn));
    const pulseProc = start(pulse);
    await ready(pulse, pulseProc);
    await waitUntilReady(pulseProc, async () => pulseKeyRegistered(), READY_TIMEOUT_MS);
  };
  // A frontend's readiness probe fetches its root page, so the dev server is up
  // and has compiled its client entry; a route the root redirects away from
  // (cire invites' `/<slug>`) still compiles on the flow's first visit.
  await Promise.all([
    identityChain(),
    ...specs.filter((s) => s !== osn && s !== pulse).map((spec) => ready(spec, start(spec))),
  ]);
}

async function main(): Promise<number> {
  const realStart = Date.now();
  const taken = await prepareRun(PORTS, ARTIFACT_DIR, [
    STATE_DIR,
    LOG_DIR,
    SCREENSHOT_DIR,
    TRACE_DIR,
  ]);
  if (taken.length > 0) {
    for (const { name, port } of taken) say(`port ${port} (${name}) is already in use`);
    say("stop whatever holds it (a dev server, another run) and try again");
    return 1;
  }

  const procs: Started[] = [];
  let mail: MailServer | null = null;
  const stopMail = async (): Promise<void> => {
    await mail?.stop();
  };
  stopOnSignal(procs, stopMail);

  try {
    mail = startMailServer(PORTS.mail);
    await bootStack(realStart, procs);
    say("stack ready; running flows");
    // In `procs` like every server, so a signal or a failure stops it too.
    const runner = startProcess({
      name: "playwright",
      command: ["bunx", "playwright", "test", ...process.argv.slice(2)],
      cwd: PACKAGE_DIR,
      // The runner keeps the real clock (its own timeouts run on it); each
      // browser context is put on the suite's clock by the fixtures.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        E2E_CLOCK_R0: String(realStart),
        NODE_OPTIONS: "",
      },
    });
    procs.push(runner);
    return await runner.exited;
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await stopAll(procs);
    await stopMail();
    say(`artifacts in ${ARTIFACT_DIR}`);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
