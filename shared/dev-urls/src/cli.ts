#!/usr/bin/env bun
/**
 * `dev-env` — run an app's dev server with its cross-app URLs filled in.
 *
 * Used as the front half of every app's `dev:app` script:
 *
 *     "dev": "portless",
 *     "dev:app": "dev-env astro dev"
 *
 * Portless gives each app a stable hostname and, in a linked git worktree, its
 * own branch-prefixed copy of it. So `@cire/host` cannot be told where
 * `@cire/api` lives in a committed `.env` — the answer depends on which
 * worktree it is running in. This wrapper reads the app's own `PORTLESS_URL`,
 * derives its siblings' origins from it (see `./index.ts`), and puts them in
 * the environment before handing over to the real dev command.
 *
 * Keeping it here rather than in each app's source means no app has to know
 * that portless exists; they keep reading the same env vars the deployed tiers
 * set. The values win over any `.env` file: under portless a `localhost:4321`
 * origin names a host nothing is listening on. Run `PORTLESS=0 bun run dev`
 * (or `dev:app` directly) to get the fixed-port devloop back.
 *
 * Everything worth testing lives in `./app-env.ts`; this file is the process
 * wrapper around it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildDevEnv, resolveSelfId } from "./app-env";

function packageName(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8")) as {
      name?: string;
    };
    return pkg.name;
  } catch {
    return undefined;
  }
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: dev-env <command> [args...]");
  process.exit(64);
}

let overrides: Record<string, string>;
let self: string;
try {
  const id = resolveSelfId(packageName());
  self = id;
  overrides = buildDevEnv(id);
} catch (error) {
  // A package the launcher does not know is one whose siblings it cannot
  // address. Say which, on stderr, rather than dumping a stack trace.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(78);
}

if (Object.keys(overrides).length > 0) {
  // stderr, not stdout: stdout belongs to the command being wrapped, and a
  // banner in the middle of it would corrupt any `dev:app` whose output is
  // piped or parsed. Turbo shows both streams either way.
  console.error(`dev-env: ${self} -> ${process.env.PORTLESS_URL}`);
}

// `execve` takes a complete environment, and `process.env` is typed as holding
// `undefined`s that it cannot carry. Copy the set ones, then let the derived
// values win.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
Object.assign(env, overrides);

// Hand the process over rather than supervising one. `execve` replaces this
// process image, so the dev server keeps this pid: portless and turbo signal it
// directly, and its exit status is reported natively. A wrapper that stayed
// resident would have to reimplement signal forwarding and the shell's
// 128+signal exit convention, and get both right for every signal.
const binary = Bun.which(command[0]!);
if (!binary) {
  console.error(`dev-env: ${command[0]} not found`);
  process.exit(127);
}

// `process.execve` arrived in Bun 1.3.14 — undefined in 1.3.13 and every
// version below it, checked one by one — and does not exist on Windows at all.
// `.bun-version` now pins 1.4.0, so the exec path is the one that runs here and
// in CI: replacing the process image means the dev server keeps this pid, so
// portless and turbo signal it directly and its exit status is the kernel's.
//
// The fallback below stays anyway. It is the difference between "your devloop
// is a little different" and "your devloop refuses to start" for anyone on
// Windows or an older Bun, and it costs a tested twenty lines.
// `DEV_ENV_NO_EXECVE` forces it, which is how a runtime that has execve still
// covers it.
if (process.execve && !process.env.DEV_ENV_NO_EXECVE) {
  process.execve(binary, command, env);
}

// Fallback: supervise a child and reproduce what execve would have given for
// free — pass signals down so the dev server is not orphaned holding portless's
// port, and report a signalled death the way a shell does.
const SIGNAL_NUMBERS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
} satisfies Partial<Record<NodeJS.Signals, number>>;

/** The signals named above; anything else lands in the 128+ range as 128. */
type Known = keyof typeof SIGNAL_NUMBERS;

const child = spawn(binary, command.slice(1), { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`dev-env: could not run ${command.join(" ")}:`, error.message);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  const number = signal && signal in SIGNAL_NUMBERS ? SIGNAL_NUMBERS[signal as Known] : 0;
  process.exit(signal ? 128 + number : (code ?? 0));
});
