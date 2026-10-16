/**
 * `bun run test:e2e`: boots the stack, runs the flows, tears everything down.
 *
 *  1. Clear `e2e-artifacts/` — no state or artifact survives from a previous run.
 *  2. Refuse to start if any fixed port is taken.
 *  3. Prove the shared clock reaches a Bun and a Node child.
 *  4. Seed fresh databases.
 *  5. Start the mail stand-in, then each app in order, waiting for each.
 *  6. Run Playwright, which writes traces, screenshots and `results.json`.
 *  7. Stop every process group, whatever happened above.
 *
 * Exits with Playwright's code, or 1 when the stack never came up.
 */

import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
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
import { httpAnswers, startProcess, stopAll, waitUntilReady, type Started } from "./processes";
import { seedOsn, seedPulse } from "./seed";
import { API_COMMAND, appDir, appSpecs, baseEnv } from "./stack";

const PACKAGE_DIR = resolve(import.meta.dirname, "..");
const READY_TIMEOUT_MS = 120_000;

const say = (line: string): void => {
  process.stderr.write(`e2e: ${line}\n`);
};

/**
 * Runs one line of code the way the stack runs its children — Bun with the API
 * flags, Node with the children's `NODE_OPTIONS` — and checks the date each
 * reports. A clock that fails to load otherwise shows up only as a closed RSVP
 * or a "start time is in the past", and only once the real date moves on.
 */
export function clockReaches(env: Record<string, string>): string[] {
  const failures: string[] = [];
  const script = "process.stdout.write(String(Date.now()))";
  for (const [runtime, args] of [
    ["bun", [...API_COMMAND.slice(1, -1), "-e", script]],
    ["node", ["-e", script]],
  ] as const) {
    const out = spawnSync(runtime, args, { env, encoding: "utf8" });
    const reported = Number(out.stdout);
    // Within a minute of the suite's start instant: the clock ticks from the launcher's start.
    if (!(reported >= CLOCK_T0 && reported < CLOCK_T0 + 60_000)) {
      failures.push(
        `${runtime} reported ${out.stdout || out.stderr.trim()} (expected ~${CLOCK_T0})`,
      );
    }
  }
  return failures;
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
  const apis = specs.filter((s) => s.name.endsWith("Api"));
  const webs = specs.filter((s) => !s.name.endsWith("Api"));

  const start = (spec: (typeof specs)[number]): Started => {
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

  // APIs one at a time: pulse-api registers its service key with osn-api once,
  // at boot, so osn-api must already be answering.
  const bootInOrder = async (remaining: typeof apis): Promise<void> => {
    const [spec, ...rest] = remaining;
    if (!spec) return;
    const proc = start(spec);
    say(`starting ${spec.name}`);
    await waitUntilReady(proc, () => httpAnswers(spec.readyUrl), READY_TIMEOUT_MS);
    if (spec.name === "pulseApi") {
      await waitUntilReady(proc, async () => pulseKeyRegistered(), READY_TIMEOUT_MS);
    }
    await bootInOrder(rest);
  };
  await bootInOrder(apis);

  // Frontends together; the probe fetches each root page, which also makes the
  // dev server compile it before the first flow navigates there.
  say(`starting ${webs.map((s) => s.name).join(", ")}`);
  await Promise.all(
    webs.map((spec) =>
      waitUntilReady(start(spec), () => httpAnswers(spec.readyUrl), READY_TIMEOUT_MS),
    ),
  );
}

async function main(): Promise<number> {
  const realStart = Date.now();
  rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  for (const dir of [STATE_DIR, LOG_DIR, SCREENSHOT_DIR, TRACE_DIR])
    mkdirSync(dir, { recursive: true });

  const taken = await takenPorts(PORTS);
  if (taken.length > 0) {
    for (const { name, port } of taken) say(`port ${port} (${name}) is already in use`);
    say("stop whatever holds it (a dev server, another run) and try again");
    return 1;
  }

  const procs: Started[] = [];
  let mail: MailServer | null = null;
  const teardown = async (): Promise<void> => {
    await stopAll(procs);
    await mail?.stop();
  };
  const onSignal = (): void => {
    void teardown().then(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    mail = startMailServer(PORTS.mail);
    await bootStack(realStart, procs);
    say("stack ready; running flows");
    // Not spawnSync: the mail stand-in runs in this process and has to keep
    // answering osn-api while the flows run.
    const playwright = spawn("bunx", ["playwright", "test", ...process.argv.slice(2)], {
      cwd: PACKAGE_DIR,
      // The runner keeps the real clock (its own timeouts run on it); each
      // browser context is put on the suite's clock by the fixtures.
      env: { ...process.env, E2E_CLOCK_R0: String(realStart), NODE_OPTIONS: "" },
      stdio: "inherit",
    });
    return await new Promise<number>((done) => playwright.once("exit", (code) => done(code ?? 1)));
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await teardown();
    say(`artifacts in ${ARTIFACT_DIR}`);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
