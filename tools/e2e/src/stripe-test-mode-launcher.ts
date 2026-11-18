/**
 * `bun run test:e2e:stripe`: the guest's gift to a cash fund against Stripe's
 * real test mode, the nightly `E2E Stripe test mode` workflow's run
 * (`.github/workflows/e2e-stripe-test-mode.yml`). The pull request suite
 * stays on the Stripe stand-in.
 *
 * `--preflight` is the workflow's first step, run before anything installs:
 *  - no `STRIPE_TEST_SECRET_KEY`: writes `run=false`, a notice and a line in the
 *    job summary, and succeeds, so the job skips its other steps;
 *  - a key that is not a test-mode one, or no well-formed
 *    `STRIPE_TEST_CONNECTED_ACCOUNT`: fails, naming the variable;
 *  - otherwise reads the `stripe-test-mode` Environment from GitHub and fails
 *    unless only the `main` branch may deploy from it, so no other branch's
 *    workflow can read the key; then writes `run=true`.
 *
 * With no flag it runs:
 *  1. The same key and account check; a refusal stops it before any port
 *     check or process.
 *  2. The suite clock starts at the real now: `E2E_STRIPE_CLOCK_T0` is set
 *     before `config.ts` first loads, and the run refuses to go on unless the
 *     loaded clock agrees. Stripe refuses a Checkout session that closes
 *     before real now plus 30 minutes, and cire-api an event signed more than
 *     five minutes from its own now.
 *  3. `launch` boots osn-api, cire-api and the two cire sites. Before them it
 *     starts `stripe listen`, which forwards the connected accounts'
 *     `checkout.session.completed` events, signed by Stripe, to cire-api's
 *     Connect webhook, and gives cire-api the test key and the signing secret
 *     it printed. No public address is needed: the CLI holds a connection to
 *     Stripe open.
 *  4. Playwright runs `tests/stripe-test-mode/` alone.
 *
 * `stripe listen`'s output goes to `e2e-artifacts/logs/stripe-listen.log`
 * with every secret redacted and any other account's events left out. The
 * key reaches cire-api, `stripe listen` and the Playwright runner, and no
 * other process (`baseEnv` in `stack.ts`).
 *
 * Its imports up front are node built-ins and `./stripe-test-mode` alone:
 * anything that reaches `config.ts` would fix the clock before step 2.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { LaunchOptions } from "./launcher";
import type { Started } from "./processes";
import type { StripeTestModeSettings } from "./stack";
import {
  ACCOUNT_VAR,
  SECRET_KEY_VAR,
  STRIPE_TEST_ENVIRONMENT,
  branchPolicyRefusal,
  type JsonValue,
  listenLine,
  stripeTestMode,
  webhookSecretIn,
} from "./stripe-test-mode";

type Env = Readonly<Record<string, string | undefined>>;

/** The apps the flow needs: the organiser's sign-in, cire-api, the portal and the guest site. */
const APPS = ["osnApi", "cireApi", "cireHost", "cireInvites"] as const;

/** How long `stripe listen` may take to print its signing secret. */
const LISTEN_READY_MS = 30_000;

/** How far the loaded suite clock may sit from the real now. */
const CLOCK_SLACK_MS = 5_000;

const say = (line: string): void => {
  process.stderr.write(`e2e: ${line}\n`);
};

/** Appends one `name=value` line to a GitHub Actions file named by `variable`, when it is set. */
function appendTo(env: Env, variable: string, text: string): void {
  const path = env[variable];
  if (path) appendFileSync(path, text);
}

/** GitHub's answer for one of the Environment's endpoints, or null when it could not be read. */
async function readEnvironment(env: Env, suffix: string): Promise<JsonValue> {
  const api = env["GITHUB_API_URL"] ?? "https://api.github.com";
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  });
  const token = env["GITHUB_TOKEN"];
  if (token) headers.set("authorization", `Bearer ${token}`);
  try {
    const response = await fetch(
      `${api}/repos/${env["GITHUB_REPOSITORY"]}/environments/${STRIPE_TEST_ENVIRONMENT}${suffix}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    return response.ok ? ((await response.json()) as JsonValue) : null;
  } catch {
    return null;
  }
}

async function preflight(env: Env): Promise<number> {
  const decision = stripeTestMode(env);
  if (decision.kind === "absent") {
    const words = `The ${STRIPE_TEST_ENVIRONMENT} Environment has no ${SECRET_KEY_VAR} secret, so the gift was not run against Stripe's test mode. Nothing failed.`;
    process.stdout.write(`::notice title=Stripe test mode skipped::${words}\n`);
    appendTo(env, "GITHUB_STEP_SUMMARY", `### Stripe test mode: skipped\n\n${words}\n`);
    appendTo(env, "GITHUB_OUTPUT", "run=false\n");
    return 0;
  }
  const refusal =
    decision.kind === "refused"
      ? decision.reason
      : env["GITHUB_REPOSITORY"]
        ? branchPolicyRefusal(
            await readEnvironment(env, ""),
            await readEnvironment(env, "/deployment-branch-policies"),
          )
        : "GITHUB_REPOSITORY is not set: the preflight reads the Environment from GitHub Actions";
  if (refusal !== null) {
    process.stdout.write(`::error title=Stripe test mode refused::${refusal}\n`);
    appendTo(env, "GITHUB_STEP_SUMMARY", `### Stripe test mode: refused\n\n${refusal}\n`);
    appendTo(env, "GITHUB_OUTPUT", "run=false\n");
    return 1;
  }
  appendTo(env, "GITHUB_OUTPUT", "run=true\n");
  return 0;
}

/**
 * Starts `stripe listen` and resolves with the signing secret it prints. Its
 * process joins `procs` at once, so the run stops it whatever happens next.
 * It runs with a home of its own, so a developer's own Stripe login is never
 * read or written.
 */
function startListen(options: {
  readonly cli: string;
  readonly secretKey: string;
  readonly account: string;
  readonly forwardTo: string;
  readonly logPath: string;
  readonly procs: Started[];
}): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "osn-e2e-stripe-"));
  const child = spawn(
    options.cli,
    [
      "listen",
      "--skip-update",
      "--color",
      "off",
      "--events",
      "checkout.session.completed",
      "--events-from",
      "@accounts",
      "--forward-connect-to",
      options.forwardTo,
      "--format",
      "JSON",
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        STRIPE_API_KEY: options.secretKey,
        STRIPE_DEVICE_NAME: "osn-e2e-stripe-test-mode",
        STRIPE_CLI_TELEMETRY_OPTOUT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let resolveExited: (code: number) => void = () => undefined;
  const started: Started = {
    name: "stripe listen",
    logPath: options.logPath,
    child,
    exit: null,
    exited: new Promise<number>((done) => (resolveExited = done)),
  };
  options.procs.push(started);

  return new Promise<string>((resolveSecret, reject) => {
    let secret: string | null = null;
    const timer = setTimeout(() => {
      reject(
        new Error(
          `stripe listen printed no signing secret in ${LISTEN_READY_MS / 1000}s; see ${options.logPath}`,
        ),
      );
    }, LISTEN_READY_MS);
    const onLine = (line: string): void => {
      if (secret === null) {
        const found = webhookSecretIn(line);
        if (found !== null) {
          secret = found;
          clearTimeout(timer);
          resolveSecret(found);
        }
      }
      const kept = listenLine(line, options.account);
      if (kept !== null) appendFileSync(options.logPath, `${kept}\n`);
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine);
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(`stripe listen did not start (${error.message}); is ${options.cli} installed?`),
      );
    });
    child.once("exit", (code, signal) => {
      started.exit = signal ?? `code ${code}`;
      resolveExited(code ?? 1);
      appendFileSync(options.logPath, `stripe listen exited (${started.exit})\n`);
      if (secret === null) {
        clearTimeout(timer);
        reject(
          new Error(
            `stripe listen exited (${started.exit}) before it was ready; see ${options.logPath}`,
          ),
        );
      }
    });
  });
}

async function run(env: Env): Promise<number> {
  const decision = stripeTestMode(env);
  if (decision.kind === "absent") {
    say(`${SECRET_KEY_VAR} and ${ACCOUNT_VAR} are not set: there is nothing to run against`);
    return 1;
  }
  if (decision.kind === "refused") {
    say(decision.reason);
    return 1;
  }

  const realStart = Date.now();
  process.env["E2E_STRIPE_CLOCK_T0"] = String(realStart);
  const config = await import("./config");
  if (Math.abs(config.CLOCK_T0 - Date.now()) > CLOCK_SLACK_MS) {
    say(
      "the suite clock did not start at the real now; config.ts was loaded before the clock was set",
    );
    return 1;
  }
  const { launch } = await import("./launcher");
  const beforeApps = async (procs: Started[]): Promise<StripeTestModeSettings> => {
    say("starting stripe listen");
    const webhookSecret = await startListen({
      cli: env["STRIPE_CLI"] || "stripe",
      secretKey: decision.secretKey,
      account: decision.account,
      forwardTo: `http://127.0.0.1:${config.PORTS.cireApi}/api/stripe/webhook`,
      logPath: resolve(config.LOG_DIR, "stripe-listen.log"),
      procs,
    });
    say("stripe listen is forwarding Connect events to cire-api");
    return { secretKey: decision.secretKey, webhookSecret };
  };
  const options: LaunchOptions = {
    realStart,
    playwrightArgs: ["--config", "playwright.stripe-test-mode.config.ts"],
    apps: new Set(APPS),
    beforeApps,
  };
  return launch(options);
}

if (import.meta.main) {
  process.exitCode = process.argv.includes("--preflight")
    ? await preflight(process.env)
    : await run(process.env);
}
