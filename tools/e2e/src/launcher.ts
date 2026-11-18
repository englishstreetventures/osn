/**
 * `bun run test:e2e`: boots the stack, runs the flows, tears everything down.
 *
 *  1. Refuse to start if any fixed port is taken, leaving the last run's artifacts.
 *  2. Clear `e2e-artifacts/` — no state or artifact survives from a previous run.
 *  3. Prove the shared clock reaches a Bun and a Node child.
 *  4. Seed fresh databases.
 *  5. Start the mail, Stripe and issuer stand-ins, then every app: osn-api before
 *     pulse-api, the rest alongside them.
 *  6. Stop the run if any API answers at this machine's network address.
 *  7. Run Playwright, which writes traces, screenshots and `results.json`.
 *  8. Stop every process group, the runner's included, whatever happened above
 *     and on SIGINT or SIGTERM.
 *
 * Exits with Playwright's code, or 1 when the stack never came up or an API
 * listens beyond loopback.
 *
 * `launch` is also the run against Stripe's test mode
 * (`src/stripe-test-mode-launcher.ts`), which boots fewer apps, starts
 * `stripe listen` before them and gives cire-api its Stripe settings.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

import {
  ARTIFACT_DIR,
  CLOCK_T0,
  DB_FILES,
  LOG_DIR,
  PORTS,
  SCREENSHOT_DIR,
  STATE_DIR,
  STRIPE_CONNECT_WEBHOOK_SECRET,
  STRIPE_PLATFORM_WEBHOOK_SECRET,
  TRACE_DIR,
  type AppName,
} from "./config";
import { startIssuerServer, type IssuerServer } from "./issuer";
import { startMailServer, type MailServer } from "./mail";
import { answeringAt, networkAddress, takenPorts } from "./ports";
import {
  httpAnswers,
  startProcess,
  stopAll,
  stopOnSignal,
  waitUntilReady,
  type Started,
} from "./processes";
import { generateCireArcKey, seedOsn, seedPulse } from "./seed";
import { API_COMMAND, appDir, appSpecs, baseEnv, type StripeTestModeSettings } from "./stack";
import { startStripeServer, type StripeServer } from "./stripe";

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

/** How one run boots and what it runs. `bun run test:e2e` gives only `playwrightArgs`. */
export interface LaunchOptions {
  /** The real instant the suite clock reads `CLOCK_T0` at. Defaults to now. */
  readonly realStart?: number;
  /** Everything after `playwright test`. */
  readonly playwrightArgs: readonly string[];
  /** The apps to boot; every app when absent. osn-api must be among them. */
  readonly apps?: ReadonlySet<AppName>;
  /**
   * Runs after the clock check and the seeds, before any app starts. Its
   * process joins the ones the run stops, and its settings replace cire-api's
   * Stripe ones (`appSpecs`). The run against Stripe's test mode starts
   * `stripe listen` here.
   */
  readonly beforeApps?: (procs: Started[]) => Promise<StripeTestModeSettings>;
}

async function bootStack(
  realStart: number,
  procs: Started[],
  options: Pick<LaunchOptions, "apps" | "beforeApps">,
): Promise<void> {
  const env = baseEnv(process.env, realStart);

  const clockFailures = clockReaches(env);
  if (clockFailures.length > 0) throw new Error(`clock preload: ${clockFailures.join("; ")}`);

  const cireArc = await generateCireArcKey();
  seedOsn(DB_FILES.osn, cireArc);
  seedOsn(DB_FILES.osnEvt);
  seedPulse(DB_FILES.pulse);

  const stripeTestMode = options.beforeApps ? await options.beforeApps(procs) : undefined;
  const specs = appSpecs(cireArc, stripeTestMode).filter(
    (spec) => options.apps === undefined || options.apps.has(spec.name),
  );
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
  // A spec's build runs to the end before its server starts, logging where the
  // server will; a build that fails stops the run.
  const built = async (spec: (typeof specs)[number]): Promise<void> => {
    if (!spec.build) return;
    say(`building ${spec.name}`);
    const proc = startProcess({
      name: `${spec.name} build`,
      command: spec.build,
      cwd: appDir(spec),
      env: { ...env, ...spec.env },
      logPath: resolve(LOG_DIR, `${spec.name}.log`),
    });
    procs.push(proc);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`${spec.name}: build exited ${code}; see ${proc.logPath ?? "its output"}`);
    }
  };

  // One ordering matters: pulse-api registers its service key with osn-api
  // once, at boot, so it starts after osn-api answers and counts as ready only
  // once its key is in osn-api's database. Everything else boots alongside.
  // A run that boots no pulse-api waits on osn-api alone.
  const [osn, pulse] = [
    specs.find((s) => s.name === "osnApi"),
    specs.find((s) => s.name === "pulseApi"),
  ];
  if (!osn) throw new Error("stack: osnApi must be defined");
  const identityChain = async (): Promise<void> => {
    await ready(osn, start(osn));
    if (!pulse) return;
    const pulseProc = start(pulse);
    await ready(pulse, pulseProc);
    await waitUntilReady(pulseProc, async () => pulseKeyRegistered(), READY_TIMEOUT_MS);
  };
  // A frontend's readiness probe fetches its root page, so the dev server is up
  // and has compiled its client entry; a route the root redirects away from
  // (cire invites' `/<slug>`) still compiles on the flow's first visit.
  await Promise.all([
    identityChain(),
    ...specs
      .filter((s) => s !== osn && s !== pulse)
      .map(async (spec) => {
        await built(spec);
        await ready(spec, start(spec));
      }),
  ]);
}

/**
 * Every API the stack starts holds secrets committed to the repository as
 * placeholders, so each must listen on loopback alone (`API_HOSTNAME` in
 * `stack.ts`). Throws, naming each API that accepts a connection at this
 * machine's network address. A machine with no such address has nothing on
 * the network to refuse, and the check says it was skipped.
 */
async function apisOnLoopbackAlone(): Promise<void> {
  const address = networkAddress(networkInterfaces());
  if (address === null) {
    say(
      "no network address on this machine; skipped the check that the APIs listen on loopback alone",
    );
    return;
  }
  const apis = Object.fromEntries(
    appSpecs()
      .filter((spec) => spec.command === API_COMMAND)
      .map((spec) => [spec.name, PORTS[spec.name]]),
  );
  const open = await answeringAt(address, apis);
  if (open.length > 0) {
    const named = open.map(({ name, port }) => `${name} (port ${port})`).join(", ");
    throw new Error(`listening beyond loopback, at this machine's network address: ${named}`);
  }
  say(`all ${Object.keys(apis).length} APIs refuse a connection at this machine's network address`);
}

/** One run: steps 1 to 8 above. Resolves with the exit code. */
export async function launch(options: LaunchOptions): Promise<number> {
  const realStart = options.realStart ?? Date.now();
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
  let stripe: StripeServer | null = null;
  let issuer: IssuerServer | null = null;
  const stopMail = async (): Promise<void> => {
    await mail?.stop();
    await stripe?.stop();
    await issuer?.stop();
  };
  stopOnSignal(procs, stopMail);

  try {
    mail = startMailServer(PORTS.mail);
    stripe = startStripeServer(PORTS.stripe, {
      platformWebhookSecret: STRIPE_PLATFORM_WEBHOOK_SECRET,
      connectWebhookSecret: STRIPE_CONNECT_WEBHOOK_SECRET,
      // The suite clock, which cire-api checks an event's signature against.
      now: () => CLOCK_T0 + (Date.now() - realStart),
    });
    issuer = await startIssuerServer(PORTS.issuer, () => CLOCK_T0 + (Date.now() - realStart));
    await bootStack(realStart, procs, options);
    await apisOnLoopbackAlone();
    say("stack ready; running flows");
    // In `procs` like every server, so a signal or a failure stops it too.
    const runner = startProcess({
      name: "playwright",
      command: ["bunx", "playwright", "test", ...options.playwrightArgs],
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
  process.exitCode = await launch({ playwrightArgs: process.argv.slice(2) });
}
