// The `import.meta.main` block of scripts/guest-route-parity.ts: what reaches
// the reference child, what each side is asked, what the report says and the
// exit code (NEW-FEAT.md PF10–PF16, PF21–PF28, PF33, PF38–PF40, PF46, PF47).
//
// Each test copies the script, the smoke check it takes `judge()` from and the
// Node child that starts the reference, byte for byte, into a temporary tree
// shaped like this repository, with a `package.json` that makes Node load the
// child as an ES module. Where the child loads cire/invites' wrangler, the tree
// holds a stand-in module: its `unstable_startWorker` logs the options, the
// environment, the working directory and the pid it was started with, leaves a
// `.wrangler` beside the config as Wrangler does, then serves the answers the
// test wrote on the port it was given. For each probe the guest site answers by
// asking cire-api, it calls the child's `outboundService` first, the way the
// guest site's `fetchInvite` does, and serves the built-in shell when cire-api
// does not answer as it should. The dev host is a Bun process; the fake cire-api
// is a server in this process that answers only the CI user agent, as Bot Fight
// Mode does. Real Wrangler runs in guest-route-parity-wrangler.e2e.ts.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run, SEEDED_PROBES, UNKNOWN_SLUG_PROBES } from "../guest-route-parity";
import { CI_USER_AGENT } from "../smoke-check";

// Each test starts Bun, Node and two servers; under `bun test ./scripts/`
// they share the machine with every other script test.
setDefaultTimeout(30_000);

const SCRIPTS = join(import.meta.dir, "..");
const INVITES = join(SCRIPTS, "..", "cire", "invites");

interface Answer {
  readonly status?: number;
  /** How long the server waits before it answers. */
  readonly delayMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
type Answers = Readonly<Record<string, Answer>>;

const SEEDED_PAGE: Answer = {
  headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
  body: '<!doctype html><html lang="en"><head><title>Ada &amp; Kit — You&#39;re Invited</title></head><body></body></html>',
};

/** What a working guest site answers, by path; every other path is a plain 404. */
const ANSWERS: Answers = {
  "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\n" },
  "/": { status: 302, headers: { location: "https://cire.example.test" } },
  "/cire-wedding": SEEDED_PAGE,
  "/cire-wedding/registry": SEEDED_PAGE,
  "/cire/invite?slug=cire-wedding": SEEDED_PAGE,
  "/cire/registry?slug=cire-wedding": SEEDED_PAGE,
  "/privacy": { status: 307, headers: { location: "/privacy/" } },
  "/privacy/": {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy-report-only": "default-src 'self'",
    },
    body: "<html><head><title>Privacy</title></head><body><h1>Privacy</h1></body></html>",
  },
};

/** The manifest an Astro build of the guest site writes: its pages and the two routes Astro adds. */
const MANIFEST = [
  "/",
  "/[slug]",
  "/[slug]/registry",
  "/_image",
  "/_server-islands/[name]",
  "/cire/invite",
  "/cire/registry",
  "/privacy",
  "/terms",
]
  .map((route) => `{"route":"${route}"}`)
  .join(",");

/** A loopback cire-api origin for the tests that never reach it. */
const UNUSED_API = "http://127.0.0.1:9";

let root: string;

/** Every process and server a test starts, stopped after the file even when a test times out. */
const started: { kill: () => void }[] = [];

beforeAll(() => {
  // Real path, so it matches the working directory the stand-in reports.
  root = realpathSync(mkdtempSync(join(tmpdir(), "guest-route-parity-cli-")));
});

afterAll(() => {
  for (const proc of started) proc.kill();
  rmSync(root, { recursive: true, force: true });
});

/** Serves `answers` in Bun, recording each request's path, Access client id and user agent. */
const SERVER = `
const [answersFile, portFile, logFile] = process.argv.slice(2);
const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const answers = JSON.parse(readFileSync(answersFile, "utf8"));
    const seen = Number((globalThis.seen ??= {})[path] ?? 0);
    globalThis.seen[path] = seen + 1;
    appendFileSync(logFile, JSON.stringify({ path, id: request.headers.get("cf-access-client-id"), ua: request.headers.get("user-agent") }) + "\\n");
    const answer = answers[path + "#" + seen] ?? answers[path];
    if (answer === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    const extra = JSON.parse(process.env.EXTRA_HEADERS ?? "{}");
    const respond = () => new Response(answer.body ?? null, { status: answer.status ?? 200, headers: { ...extra, ...(answer.headers ?? {}) } });
    return answer.delayMs === undefined ? respond() : Bun.sleep(answer.delayMs).then(respond);
  },
});
writeFileSync(portFile, String(server.port));
`;

/** How the stand-in wrangler behaves once the child loads it. */
type StandIn =
  /** Serves, asking cire-api through the child for the probes the guest site does. */
  | "serve"
  /** Serves the stored answers and never asks cire-api. */
  | "serve-without-cire-api"
  /** Serves, asking cire-api, and its DevEnv emits an error event once it is ready. */
  | "error-after-ready"
  /** `unstable_startWorker` throws, as Wrangler does for a config it refuses. */
  | "throw"
  /** `ready` rejects. */
  | "reject"
  /** The DevEnv emits an error event and `ready` never settles. */
  | "error-event"
  /** Starts and never serves. */
  | "never-serve"
  /** No wrangler under cire/invites at all. */
  | "missing";

/** A CommonJS stand-in for wrangler's package, run inside the Node child. */
const standInModule = (state: string, mode: StandIn): string => `"use strict";
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const { createServer } = require("node:http");
const { dirname, join, resolve } = require("node:path");

const state = ${JSON.stringify(state)};
const mode = ${JSON.stringify(mode)};

/** The probes the guest site answers by asking cire-api, and what it asks. */
const ASKS = {
  "/cire-wedding": ["GET", "cire-wedding"],
  "/cire-wedding/registry": ["GET", "cire-wedding"],
  "/cire/invite?slug=cire-wedding": ["POST", "cire-wedding"],
  "/cire/registry?slug=cire-wedding": ["POST", "cire-wedding"],
  "/route-parity-no-such-wedding": ["GET", "route-parity-no-such-wedding"],
  "/_headers": ["GET", "_headers"],
  "/wrangler.json": ["GET", "wrangler.json"],
  "/.dev.vars": ["GET", ".dev.vars"],
  "/.assetsignore": ["GET", ".assetsignore"],
};

/** What the guest site renders when cire-api fails it. */
const SHELL = { headers: { "content-type": "text/html" }, body: "<html><head><title>You&#39;re Invited</title></head></html>" };

const idle = () => setTimeout(() => {}, 30_000);

exports.unstable_startWorker = async (options) => {
  const logged = JSON.parse(JSON.stringify(options, (_key, value) => (typeof value === "function" ? "[function]" : value)));
  writeFileSync(join(state, "call.json"), JSON.stringify({ cwd: process.cwd(), pid: process.pid, argv: process.argv, options: logged, env: process.env }));
  writeFileSync(join(state, "reference.pid"), String(process.pid));
  writeFileSync(join(state, "env-file.txt"), readFileSync(options.envFiles[0], "utf8"));
  const raw = new EventEmitter();
  if (mode === "throw") throw new Error("stand-in refused the config");
  if (mode === "reject") {
    return { raw, ready: new Promise((_, reject) => setTimeout(() => reject(new Error("stand-in never became ready")), 50)) };
  }
  if (mode === "error-event") {
    idle();
    setTimeout(() => raw.emit("error", { type: "error", source: "StandInController", reason: "stand-in runtime failed to start" }), 50);
    return { raw, ready: new Promise(() => {}) };
  }
  if (mode === "never-serve") {
    idle();
    return { raw, ready: new Promise(() => {}) };
  }
  const configDir = dirname(resolve(options.config));
  mkdirSync(join(configDir, ".wrangler", "tmp"), { recursive: true });
  const apiOrigin = /API_URL = "([^"]+)"/.exec(readFileSync(join(configDir, "entry.mjs"), "utf8"))[1];
  const seen = {};
  const ask = async ([method, slug]) => {
    const request = method === "POST"
      ? new Request(apiOrigin + "/api/invite/resolve", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ slug }) })
      : new Request(apiOrigin + "/api/invite/" + encodeURIComponent(slug));
    try {
      const response = await options.dev.outboundService(request);
      await response.arrayBuffer();
      return response.status;
    } catch {
      return 0;
    }
  };
  const answer = async (req, res) => {
    const path = req.url;
    appendFileSync(join(state, "reference.log"), JSON.stringify({ path, id: req.headers["cf-access-client-id"] ?? null, ua: req.headers["user-agent"] ?? null }) + "\\n");
    const answers = JSON.parse(readFileSync(join(state, "reference.json"), "utf8"));
    const count = seen[path] ?? 0;
    seen[path] = count + 1;
    let chosen = answers[path + "#" + count] ?? answers[path];
    const asks = ASKS[path];
    if ((mode === "serve" || mode === "error-after-ready") && asks !== undefined) {
      const seeded = asks[1] === "cire-wedding";
      const status = await ask(asks);
      if (status !== (seeded ? 200 : 404)) chosen = seeded ? SHELL : { status: 500, headers: { "content-type": "text/plain" }, body: "cire-api failed" };
    }
    if (chosen === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const send = () => {
      res.writeHead(chosen.status ?? 200, chosen.headers ?? {});
      res.end(chosen.body ?? "");
    };
    if (chosen.delayMs === undefined) send();
    else setTimeout(send, chosen.delayMs);
  };
  const server = createServer((req, res) => void answer(req, res));
  await new Promise((done) => server.listen(options.dev.server.port, options.dev.server.hostname, done));
  if (mode === "error-after-ready") {
    setTimeout(() => raw.emit("error", { type: "error", source: "StandInController", reason: "stand-in runtime hiccup" }), 20);
  }
  return { raw, ready: Promise.resolve() };
};
`;

interface Tree {
  readonly dir: string;
  readonly state: string;
  readonly script: string;
}

function tree(
  options: {
    readonly manifest?: string;
    readonly build?: boolean;
    /** The cire-api origin the build calls. */
    readonly apiOrigin?: string;
    readonly standIn?: StandIn;
    /** What the build's dist/client/.assetsignore holds; no file when undefined. */
    readonly assetsIgnore?: string;
  } = {},
): Tree {
  const dir = mkdtempSync(join(root, "tree-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of [
    "guest-route-parity.ts",
    "smoke-check.ts",
    "guest-route-parity-reference.js",
  ]) {
    copyFileSync(join(SCRIPTS, file), join(dir, "scripts", file));
  }
  // As the repository's root package.json does: Node loads the child as an ES module.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const invites = join(dir, "cire", "invites");
  mkdirSync(join(invites, "src"), { recursive: true });
  symlinkSync(join(INVITES, "src", "pages"), join(invites, "src", "pages"));
  symlinkSync(join(INVITES, "public"), join(invites, "public"));
  if (options.build !== false) {
    mkdirSync(join(invites, "dist", "server", "chunks"), { recursive: true });
    mkdirSync(join(invites, "dist", "client"), { recursive: true });
    writeFileSync(join(invites, "dist", "server", "wrangler.json"), "{}");
    writeFileSync(
      join(invites, "dist", "server", "chunks", "entrypoints.mjs"),
      `const m=[${options.manifest ?? MANIFEST}];`,
    );
    writeFileSync(
      join(invites, "dist", "server", "entry.mjs"),
      `export const API_URL = ${JSON.stringify(options.apiOrigin ?? UNUSED_API)};\n`,
    );
    if (options.assetsIgnore !== undefined) {
      writeFileSync(join(invites, "dist", "client", ".assetsignore"), options.assetsIgnore);
    }
  }
  const state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "server.ts"), SERVER);
  const mode = options.standIn ?? "serve";
  if (mode !== "missing") {
    const wrangler = join(invites, "node_modules", "wrangler");
    mkdirSync(wrangler, { recursive: true });
    writeFileSync(
      join(wrangler, "package.json"),
      JSON.stringify({ name: "wrangler", main: "index.js" }),
    );
    writeFileSync(join(wrangler, "index.js"), standInModule(state, mode));
  }
  return { dir, state, script: join(dir, "scripts", "guest-route-parity.ts") };
}

/** Starts the stand-in dev host, answering `answers`, each answer with `extraHeaders` too. */
async function devHost(
  t: Tree,
  answers: Answers,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ readonly origin: string; readonly stop: () => void }> {
  writeFileSync(join(t.state, "dev.json"), JSON.stringify(answers));
  const portFile = join(t.state, "dev.port");
  const proc = Bun.spawn(
    [
      process.execPath,
      join(t.state, "server.ts"),
      join(t.state, "dev.json"),
      portFile,
      join(t.state, "dev.log"),
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: { ...Bun.env, EXTRA_HEADERS: JSON.stringify(extraHeaders) },
    },
  );
  started.push(proc);
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await Bun.sleep(25);
  await Bun.sleep(25);
  return { origin: `http://127.0.0.1:${readFileSync(portFile, "utf8")}`, stop: () => proc.kill() };
}

/** One request the fake cire-api was sent. */
interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A fake cire-api: the seeded wedding by its path and by the query route's
 * POST, 404 for any other slug, and Bot Fight Mode's challenge for any request
 * without the CI user agent — or for every request, when `challenge` is set.
 * `busy` answers 503 to the CI-agent requests for its path whose count, from
 * 1, it lists; the first such request for the seeded wedding's path is the
 * control pair's.
 *
 * `holdOwn` holds the answer to each request without the CI agent — only the
 * control pair's first sends none, since the relay always sets it — until
 * `referenceStarted()` is true and either a CI-agent request arrives or
 * HOLD_MS pass, at most HOLD_CAP_MS; it then answers as usual if the
 * reference had started, and 503 if not. `held` records, for each, whether
 * the reference had started and whether a CI-agent request arrived while it
 * waited.
 */
function fakeApi(
  options: {
    readonly challenge?: boolean;
    readonly busy?: { readonly path: string; readonly at: readonly number[] };
    readonly holdOwn?: { readonly referenceStarted: () => boolean };
  } = {},
): {
  readonly origin: string;
  readonly seen: ApiRequest[];
  readonly held: { readonly started: boolean; readonly overlapped: boolean }[];
  readonly stop: () => void;
} {
  const seen: ApiRequest[] = [];
  const held: { readonly started: boolean; readonly overlapped: boolean }[] = [];
  let busyCount = 0;
  let ciAgentCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        body,
        headers: Object.fromEntries(request.headers),
      });
      const ciAgent = request.headers.get("user-agent") === CI_USER_AGENT;
      if (ciAgent) ciAgentCalls += 1;
      if (options.holdOwn !== undefined && !ciAgent) {
        const { referenceStarted } = options.holdOwn;
        const callsBefore = ciAgentCalls;
        const from = Date.now();
        const overlapped = () => ciAgentCalls > callsBefore;
        while (
          Date.now() - from < HOLD_CAP_MS &&
          !(referenceStarted() && (overlapped() || Date.now() - from >= HOLD_MS))
        ) {
          // Polled until the hold ends.
          // eslint-disable-next-line no-await-in-loop
          await Bun.sleep(20);
        }
        held.push({ started: referenceStarted(), overlapped: overlapped() });
        if (!referenceStarted()) {
          return new Response("held: the reference never started", { status: 503 });
        }
      }
      if (options.challenge === true || !ciAgent) {
        return new Response("<html>challenge</html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
        });
      }
      if (options.busy !== undefined && url.pathname === options.busy.path) {
        busyCount += 1;
        if (options.busy.at.includes(busyCount)) {
          return new Response("busy", { status: 503, headers: { "content-type": "text/plain" } });
        }
      }
      const slug =
        url.pathname === "/api/invite/resolve"
          ? String((JSON.parse(body) as { readonly slug?: unknown }).slug)
          : decodeURIComponent(url.pathname.replace(/^\/api\/invite\//, ""));
      return slug === "cire-wedding"
        ? Response.json({ slug, heroTitle: "Ada & Kit" })
        : Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  const stop = () => void server.stop(true);
  started.push({ kill: stop });
  return { origin: `http://127.0.0.1:${server.port}`, seen, held, stop };
}

/**
 * How long `holdOwn` holds the control pair's first answer once the reference
 * has started: longer than the stand-in takes to serve and be probed, so a
 * probe that did not wait for the pair reaches cire-api within it.
 */
const HOLD_MS = 2_000;
/** The longest it holds: under the 12 s by which Bun's default idle timeout cuts a request with no answer. */
const HOLD_CAP_MS = 8_000;

/** The control pair, as the fake cire-api answers it: Bun's own agent challenged, the CI agent let through. */
const CONTROL_PAIR = [
  {
    userAgent: "Bun's own",
    status: 403,
    blocked: "Cloudflare answered 403 in the Worker's place (cf-mitigated: challenge)",
  },
  { userAgent: CI_USER_AGENT, status: 200 },
];

/** A loopback port nothing listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function runParity(
  t: Tree,
  env: Readonly<Record<string, string>>,
  args: readonly string[] = ["--out", join(t.state, "out", "report.json")],
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const proc = Bun.spawn([process.execPath, "run", t.script, ...args], {
    cwd: t.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "", TMPDIR: tmpdir(), ...env },
  });
  started.push(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout + stderr };
}

interface RelayedRecord {
  readonly probe: string;
  readonly try: number;
  readonly expected?: number;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly blocked?: string;
  readonly error?: string;
  readonly workerUserAgent: string;
}

interface WrittenReport {
  readonly result: string;
  readonly refusals: readonly string[];
  readonly probes: readonly { readonly path: string; readonly differences: readonly string[] }[];
  readonly cireApi: {
    readonly control: readonly {
      readonly userAgent: string;
      readonly status?: number;
      readonly blocked?: string;
      readonly error?: string;
    }[];
    readonly relayed: readonly RelayedRecord[];
  };
}

const reportPath = (t: Tree) => join(t.state, "out", "report.json");
const report = (t: Tree) => JSON.parse(readFileSync(reportPath(t), "utf8")) as WrittenReport;

interface Call {
  readonly cwd: string;
  readonly pid: number;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly options: {
    readonly config: string;
    readonly envFiles: readonly string[];
    readonly dev: Readonly<Record<string, unknown>> & {
      readonly server: { readonly hostname: string; readonly port: number };
      readonly origin: { readonly hostname: string };
      readonly persist: string;
    };
  };
}

const callOf = (t: Tree) => JSON.parse(readFileSync(join(t.state, "call.json"), "utf8")) as Call;

const ACCESS = { CF_ACCESS_CLIENT_ID: "access-id", CF_ACCESS_CLIENT_SECRET: "access-secret" };

/** The stand-in reference started, and the dev host, for a test that runs the whole comparison. */
async function working(
  answers: Answers = ANSWERS,
  options: {
    readonly challenge?: boolean;
    readonly busy?: { readonly path: string; readonly at: readonly number[] };
    readonly standIn?: StandIn;
    readonly devAnswers?: Answers;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } = {},
) {
  const api = fakeApi({ challenge: options.challenge, busy: options.busy });
  const t = tree({ apiOrigin: api.origin, standIn: options.standIn });
  writeFileSync(join(t.state, "reference.json"), JSON.stringify(answers));
  const host = await devHost(t, options.devAnswers ?? answers, options.extraHeaders);
  const env = { PARITY_ORIGIN: host.origin, PARITY_API_ORIGIN: api.origin };
  return { t, api, host, env };
}

/**
 * Whether the stand-in reference the run started is gone, its process group
 * killed: within two seconds, the time a killed child takes to be reaped. A
 * stand-in left running serves for 30 s or more.
 */
async function referenceGone(t: Tree): Promise<boolean> {
  const pid = Number(readFileSync(join(t.state, "reference.pid"), "utf8"));
  for (let waited = 0; waited < 2_000; waited += 50) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // Polled until the kill lands: each try waits out the one before.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(50);
  }
  return false;
}

/** The relay's port, as the run gave it to the reference child. */
function relayPortOf(t: Tree): number {
  const { argv } = callOf(t);
  return Number(argv[argv.indexOf("--relay-port") + 1]);
}

/** Whether anything accepts a connection on loopback `port`. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolveListening(true);
    });
    socket.once("error", () => resolveListening(false));
  });
}

describe.concurrent("guest-route-parity.ts", () => {
  test("PF23: a dev host answering as Wrangler does matches; the reference child gets the build's config, its own origin, no credential, no Access token and no telemetry, and leaves nothing in the build", async () => {
    const { t, api, host, env } = await working();
    let stdout = "";
    try {
      const result = await runParity(t, {
        ...env,
        ...ACCESS,
        CLOUDFLARE_API_TOKEN: "not-a-real-token",
        CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      });
      stdout = result.stdout;
      expect(stdout).toContain("guest route parity: match");
      expect(result.exitCode).toBe(0);
    } finally {
      host.stop();
      api.stop();
    }
    expect(report(t).result).toBe("match");
    const call = callOf(t);
    expect(call.cwd).toBe(join(t.dir, "cire", "invites"));
    const { config, envFiles, dev } = call.options;
    expect(config).toBe("dist/server/wrangler.json");
    const { port } = dev.server;
    expect(dev.server).toEqual({ hostname: "127.0.0.1", port });
    expect(dev.origin).toEqual({ hostname: `127.0.0.1:${port}` });
    expect(dev.persist).toContain("guest-route-parity-");
    expect(dev.inspector).toBe(false);
    expect(dev.remote).toBe(false);
    expect(dev.watch).toBe(false);
    expect("registry" in dev).toBe(false);
    expect(dev.outboundService).toBe("[function]");
    // An empty env file of the run's own: Wrangler loads no `.env` or `.dev.vars`.
    expect(envFiles).toHaveLength(1);
    expect(envFiles[0]).toContain("guest-route-parity-");
    expect(readFileSync(join(t.state, "env-file.txt"), "utf8")).toBe("");
    // A home of the run's own, so no `wrangler login` token is found.
    expect(call.env.HOME).toMatch(/guest-route-parity-.*\/home$/);
    expect(call.env.XDG_CONFIG_HOME).toMatch(/guest-route-parity-.*\/home$/);
    expect(Object.keys(call.env).filter((name) => /^(CLOUDFLARE_|CF_ACCESS_)/.test(name))).toEqual(
      [],
    );
    expect(call.env.DO_NOT_TRACK).toBe("1");
    expect(call.env.WRANGLER_SEND_METRICS).toBe("false");
    // The relay token reaches the child, and neither the report nor the log.
    const token = call.env.PARITY_RELAY_TOKEN ?? "";
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(reportPath(t), "utf8")).not.toContain(token);
    expect(stdout).not.toContain(token);
    expect(existsSync(join(t.dir, "cire", "invites", "dist", "server", ".wrangler"))).toBe(false);
    expect(await referenceGone(t)).toBe(true);
    // The Access token reaches the dev host and nothing else.
    const asked = readFileSync(join(t.state, "dev.log"), "utf8").trim().split("\n");
    expect(asked.every((line) => JSON.parse(line).id === "access-id")).toBe(true);
    const local = readFileSync(join(t.state, "reference.log"), "utf8").trim().split("\n");
    expect(local.every((line) => JSON.parse(line).id === null)).toBe(true);
    expect(api.seen.length).toBeGreaterThan(0);
    expect(api.seen.every((one) => one.headers["cf-access-client-id"] === undefined)).toBe(true);
  });

  test("every probe of the dev host sends the CI user agent beside the Access headers", async () => {
    const { t, api, host, env } = await working();
    try {
      const { exitCode } = await runParity(t, { ...env, ...ACCESS });
      expect(exitCode).toBe(0);
    } finally {
      host.stop();
      api.stop();
    }
    const asked = readFileSync(join(t.state, "dev.log"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { readonly id: string | null; readonly ua: string | null },
      );
    expect(asked.length).toBeGreaterThan(SEEDED_PROBES.length);
    expect(new Set(asked.map((one) => `${one.ua} ${one.id}`))).toEqual(
      new Set([`${CI_USER_AGENT} access-id`]),
    );
  });

  test("PF27: the report records the control pair and every relayed call, and is byte for byte the same on a second run", async () => {
    const { t, api, host, env } = await working();
    let first = "";
    let second = "";
    try {
      expect((await runParity(t, env)).exitCode).toBe(0);
      first = readFileSync(reportPath(t), "utf8");
      expect((await runParity(t, env)).exitCode).toBe(0);
      second = readFileSync(reportPath(t), "utf8");
    } finally {
      host.stop();
      api.stop();
    }
    expect(second).toBe(first);
    const { cireApi } = JSON.parse(first) as WrittenReport;
    expect(cireApi.control).toEqual(CONTROL_PAIR);
    const relayed = cireApi.relayed;
    expect(relayed.map((one) => one.probe)).toEqual([...SEEDED_PROBES, ...UNKNOWN_SLUG_PROBES]);
    for (const one of relayed) {
      expect(one.status).toBe(one.expected);
      expect(one.workerUserAgent).toBe("absent");
    }
    expect(relayed.every((one) => one.try === 1)).toBe(true);
    expect(relayed[0]).toEqual({
      probe: "/cire-wedding",
      try: 1,
      expected: 200,
      method: "GET",
      path: "/api/invite/cire-wedding",
      status: 200,
      workerUserAgent: "absent",
    });
    expect(relayed[2]).toMatchObject({ method: "POST", path: "/api/invite/resolve" });
    expect(JSON.stringify(cireApi)).not.toMatch(/127\.0\.0\.1:\d/);
    // Every relayed call reached cire-api as the CI agent, with the query route's body intact.
    const relayedSeen = api.seen.filter((one) => one.headers["user-agent"] === CI_USER_AGENT);
    expect(relayedSeen.filter((one) => one.method === "POST").map((one) => one.body)).toContain(
      JSON.stringify({ slug: "cire-wedding" }),
    );
    for (const one of api.seen) {
      expect(Object.keys(one.headers).filter((name) => name.startsWith("x-parity-"))).toEqual([]);
    }
  });

  test("PF22: cire-api challenging even the CI agent marks each relayed call blocked, and the seeded refusal names it", async () => {
    const { t, api, host, env } = await working(ANSWERS, { challenge: true });
    try {
      const { exitCode, stdout } = await runParity(t, env);
      expect(stdout).toContain("did not render on Wrangler");
      expect(stdout).toContain("cf-mitigated: challenge");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
      api.stop();
    }
    const written = report(t);
    expect(written.result).toBe("refused");
    const seededRefusal = written.refusals.find(
      (line) => line.startsWith("/cire-wedding: the seeded wedding") && line.includes("Wrangler"),
    );
    const challenged =
      "403 (Cloudflare answered 403 in the Worker's place (cf-mitigated: challenge))";
    expect(seededRefusal).toContain(
      `cire-api through the relay: try 1 ${challenged}, try 2 ${challenged}`,
    );
    const seeded = written.cireApi.relayed.filter((one) => one.expected === 200);
    expect(seeded.length).toBeGreaterThanOrEqual(SEEDED_PROBES.length);
    for (const one of written.cireApi.relayed) expect(one.blocked).toContain("cf-mitigated");
  });

  test("PF21: a cire-api nothing answers still refuses the run on the seeded wedding, naming the relay's error", async () => {
    const port = await closedPort();
    const apiOrigin = `http://127.0.0.1:${port}`;
    const t = tree({ apiOrigin });
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, ANSWERS);
    try {
      const { exitCode, stdout } = await runParity(t, {
        PARITY_ORIGIN: host.origin,
        PARITY_API_ORIGIN: apiOrigin,
      });
      expect(stdout).toContain("did not render on Wrangler");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
    }
    const written = report(t);
    expect(written.result).toBe("refused");
    expect(written.cireApi.relayed.length).toBeGreaterThan(0);
    for (const one of written.cireApi.relayed) {
      expect(one.error).toBeString();
      expect(one.status).toBeUndefined();
    }
    for (const one of written.cireApi.control) expect(one.error).toBeString();
    expect(JSON.stringify(written.cireApi)).not.toContain(String(port));
  });

  test("PF26: seeded probes that ran with nothing reaching the relay refuse the run", async () => {
    const { t, api, host, env } = await working(ANSWERS, { standIn: "serve-without-cire-api" });
    try {
      const { exitCode, stdout } = await runParity(t, env);
      expect(stdout).toContain("no call from the Wrangler side reached cire-api through the relay");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
      api.stop();
    }
    expect(report(t).result).toBe("refused");
    expect(report(t).cireApi.relayed).toEqual([]);
  });

  test("PF25: a build that does not call PARITY_API_ORIGIN refuses the run before the reference starts", async () => {
    const api = fakeApi();
    const t = tree({ apiOrigin: "https://api.cire.elsewhere.test" });
    try {
      const { exitCode, stdout } = await runParity(t, {
        PARITY_ORIGIN: "https://invite.cire.example.test",
        PARITY_API_ORIGIN: api.origin,
      });
      expect(stdout).toContain("does not hold PARITY_API_ORIGIN");
      expect(exitCode).toBe(1);
    } finally {
      api.stop();
    }
    expect(existsSync(join(t.state, "call.json"))).toBe(false);
    expect(report(t).result).toBe("refused");
    expect(api.seen).toEqual([]);
  });

  test("a header that differs on the dev host is reported, and the run exits 1", async () => {
    const { t, api, host, env } = await working(ANSWERS, {
      devAnswers: {
        ...ANSWERS,
        "/privacy/": {
          ...ANSWERS["/privacy/"],
          headers: {
            ...ANSWERS["/privacy/"]!.headers,
            "content-security-policy-report-only": "default-src *",
          },
        },
      },
    });
    try {
      const { exitCode, stdout } = await runParity(t, env);
      expect(stdout).toContain("/privacy/ content-security-policy-report-only: default-src *");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
      api.stop();
    }
    expect(report(t).result).toBe("differ");
    expect(await referenceGone(t)).toBe(true);
  });

  test("Access's session cookie and assertion, and the service token, reach neither the report nor the log", async () => {
    const { t, api, host, env } = await working(ANSWERS, {
      extraHeaders: {
        "set-cookie": "CF_Authorization=secret-session; Path=/; Secure; HttpOnly",
        "cf-access-jwt-assertion": "secret-assertion",
      },
    });
    let stdout = "";
    try {
      const result = await runParity(t, { ...env, ...ACCESS });
      stdout = result.stdout;
      expect(result.exitCode).toBe(0);
    } finally {
      host.stop();
      api.stop();
    }
    const written = readFileSync(reportPath(t), "utf8");
    for (const secret of ["secret-session", "secret-assertion", "access-id", "access-secret"]) {
      expect(written).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
  });

  test("PF15: a difference that does not hold when asked again is not reported", async () => {
    // The dev host's first answer for /privacy/ is a 503; the second is the page.
    const { t, api, host, env } = await working(ANSWERS, {
      devAnswers: { ...ANSWERS, "/privacy/#0": { status: 503, body: "busy" } },
    });
    try {
      const { exitCode } = await runParity(t, env);
      expect(exitCode).toBe(0);
    } finally {
      host.stop();
      api.stop();
    }
  });

  /** The relayed calls `written` holds for `probe`, as try, status and expected status. */
  const triesOf = (written: WrittenReport, probe: string) =>
    written.cireApi.relayed
      .filter((one) => one.probe === probe)
      .map((one) => ({ try: one.try, status: one.status, expected: one.expected }));

  test("PF38: a relayed call cire-api fails once and answers when the page is asked again does not refuse the run, and the report keeps both tries", async () => {
    // The control pair's CI-agent request is the first for this path; the
    // first relayed one, for /cire-wedding, is the second.
    const { t, api, host, env } = await working(ANSWERS, {
      busy: { path: "/api/invite/cire-wedding", at: [2] },
    });
    let stdout = "";
    try {
      const result = await runParity(t, env);
      stdout = result.stdout;
      expect(result.exitCode).toBe(0);
    } finally {
      host.stop();
      api.stop();
    }
    expect(stdout).toContain("guest route parity: match");
    const written = report(t);
    expect(written.result).toBe("match");
    expect(written.refusals).toEqual([]);
    expect(triesOf(written, "/cire-wedding")).toEqual([
      { try: 1, status: 503, expected: 200 },
      { try: 2, status: 200, expected: 200 },
    ]);
  });

  test("PF39: a relayed call cire-api fails on both tries refuses the run once, on the try kept, and the seeded refusal names both", async () => {
    const { t, api, host, env } = await working(ANSWERS, {
      busy: { path: "/api/invite/cire-wedding", at: [2, 3] },
    });
    try {
      const { exitCode } = await runParity(t, env);
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
      api.stop();
    }
    const written = report(t);
    expect(written.result).toBe("refused");
    expect(triesOf(written, "/cire-wedding")).toEqual([
      { try: 1, status: 503, expected: 200 },
      { try: 2, status: 503, expected: 200 },
    ]);
    expect(
      written.refusals.filter((line) => line.includes("cire-api answered the Wrangler side")),
    ).toEqual([
      "/cire-wedding: cire-api answered the Wrangler side 503 for GET /api/invite/cire-wedding; expected 200.",
    ]);
    const seeded = written.refusals.find(
      (line) => line.startsWith("/cire-wedding: the seeded wedding") && line.includes("Wrangler"),
    );
    expect(seeded).toContain("cire-api through the relay: try 1 503, try 2 503");
  });

  test("PF47: the control pair is asked while the reference starts, and answered before the first probe reaches cire-api", async () => {
    let state = "";
    const api = fakeApi({
      holdOwn: { referenceStarted: () => existsSync(join(state, "call.json")) },
    });
    const t = tree({ apiOrigin: api.origin });
    state = t.state;
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, ANSWERS);
    let exitCode: number | undefined;
    try {
      exitCode = (await runParity(t, { PARITY_ORIGIN: host.origin, PARITY_API_ORIGIN: api.origin }))
        .exitCode;
    } finally {
      host.stop();
      api.stop();
    }
    // Its first answer, held, came once the reference had started (the stand-in
    // writes call.json as it starts), and no relayed call reached cire-api while
    // it waited.
    expect(api.held).toEqual([{ started: true, overlapped: false }]);
    const written = report(t);
    expect(written.cireApi.control).toEqual(CONTROL_PAIR);
    expect(written.result).toBe("match");
    expect(exitCode).toBe(0);
  });

  test("PF40: an error event from the reference after it is ready is logged, and the reference keeps serving", async () => {
    const { t, api, host, env } = await working(ANSWERS, { standIn: "error-after-ready" });
    try {
      const { exitCode, stdout } = await runParity(t, env);
      expect(stdout).toContain("guest route parity: match");
      expect(exitCode).toBe(0);
    } finally {
      host.stop();
      api.stop();
    }
    expect(report(t).result).toBe("match");
  });

  test("PF46: a .assetsignore line the script does not read refuses the run before the reference starts, naming it", async () => {
    const t = tree({ assetsIgnore: "wrangler.json\n.dev.vars\n*.map\n" });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
      PARITY_API_ORIGIN: UNUSED_API,
    });
    expect(stdout).toContain("'*.map'");
    expect(stdout).toContain(".assetsignore");
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "call.json"))).toBe(false);
    expect(report(t).result).toBe("refused");
  });

  test("PF12: a seeded wedding that renders only the built-in shell on both sides refuses the run", async () => {
    const shell: Answer = {
      headers: { "content-type": "text/html" },
      body: "<html><head><title>You&#39;re Invited</title></head></html>",
    };
    const { t, api, host, env } = await working({
      ...ANSWERS,
      "/cire-wedding": shell,
      "/cire-wedding/registry": shell,
      "/cire/invite?slug=cire-wedding": shell,
      "/cire/registry?slug=cire-wedding": shell,
    });
    try {
      const { exitCode, stdout } = await runParity(t, env);
      expect(stdout).toContain("the seeded wedding");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
      api.stop();
    }
    expect(report(t).result).toBe("refused");
  });

  test("PF10: Cloudflare answering for the Worker on the dev host refuses the run, naming it", async () => {
    const { t, api, host, env } = await working(ANSWERS, {
      devAnswers: { ...ANSWERS, "/terms/": { status: 429 } },
    });
    try {
      const { exitCode, stdout } = await runParity(t, env);
      expect(stdout).toContain("/terms/: answered 429");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
      api.stop();
    }
  });

  test("PF1: a page route missing from the build's manifest refuses the run before the reference starts", async () => {
    const t = tree({ manifest: MANIFEST.replace(',{"route":"/[slug]/registry"}', "") });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
      PARITY_API_ORIGIN: UNUSED_API,
    });
    expect(stdout).toContain(
      "The page route /[slug]/registry is not in the build's route manifest",
    );
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "call.json"))).toBe(false);
    expect(report(t).result).toBe("refused");
  });

  test("PF33: a reference that never serves the build refuses the run once its time is up, and its process group is stopped", async () => {
    const api = fakeApi();
    const t = tree({ standIn: "never-serve", apiOrigin: api.origin });
    try {
      const result = await run(
        {
          origin: "https://invite.cire.example.test",
          apiOrigin: api.origin,
          access: {},
          out: join(t.state, "unused.json"),
        },
        { root: t.dir, deadlineMs: 20_000, readyMs: 1_500 },
      );
      expect(result.result).toBe("refused");
      expect(result.refusals[0]).toContain("the reference did not serve the build within 1.5 s");
      // The control pair, asked while the reference started, is in the report all the same.
      expect(result.cireApi.control).toEqual(CONTROL_PAIR);
    } finally {
      api.stop();
    }
    expect(await referenceGone(t)).toBe(true);
    // The relay the run started for the reference is closed with it.
    expect(await listening(relayPortOf(t))).toBe(false);
  });

  test("PF16: a run that passes its deadline stops probing and still returns a refused report", async () => {
    const { t, api, host } = await working(ANSWERS, {
      devAnswers: { ...ANSWERS, "/cire-wedding": { ...SEEDED_PAGE, delayMs: 5_000 } },
    });
    try {
      const result = await run(
        {
          origin: host.origin,
          apiOrigin: api.origin,
          access: {},
          out: join(t.state, "unused.json"),
        },
        { root: t.dir, deadlineMs: 4_000, readyMs: 3_000 },
      );
      expect(result.result).toBe("refused");
      expect(result.refusals.some((line) => line.includes("passed its 4 s deadline"))).toBe(true);
      expect(result.probes.length).toBeLessThan(5);
    } finally {
      host.stop();
      api.stop();
    }
    expect(await referenceGone(t)).toBe(true);
    expect(await listening(relayPortOf(t))).toBe(false);
  });

  test.each([
    ["no wrangler to load", "missing" as const, "cannot load wrangler"],
    ["unstable_startWorker throwing", "throw" as const, "stand-in refused the config"],
    ["ready rejecting", "reject" as const, "stand-in never became ready"],
    ["an error event", "error-event" as const, "stand-in runtime failed to start"],
  ])(
    "PF28: %s ends the child with exit 3, and the run writes a refused report naming why and exits 1",
    async (_, standIn, message) => {
      const api = fakeApi();
      const t = tree({ standIn, apiOrigin: api.origin });
      try {
        const { exitCode, stdout } = await runParity(t, {
          PARITY_ORIGIN: "https://invite.cire.example.test",
          PARITY_API_ORIGIN: api.origin,
        });
        expect(stdout).toContain("the reference exited (3) before it served the build");
        expect(stdout).toContain(message);
        expect(exitCode).toBe(1);
      } finally {
        api.stop();
      }
      expect(report(t).result).toBe("refused");
    },
  );

  test("PF1: a route in the build's manifest that no probe reaches refuses the run before the reference starts", async () => {
    const t = tree({ manifest: `${MANIFEST},{"route":"/brand-new/[thing]/deep"}` });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
      PARITY_API_ORIGIN: UNUSED_API,
    });
    expect(stdout).toContain("No probe reaches the route /brand-new/[thing]/deep");
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "call.json"))).toBe(false);
    expect(report(t).result).toBe("refused");
  });

  test("PF1: a manifest the script cannot read refuses the run before the reference starts", async () => {
    const t = tree({ manifest: '{route:"/"}' });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
      PARITY_API_ORIGIN: UNUSED_API,
    });
    expect(stdout).toContain("lists no route");
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "call.json"))).toBe(false);
  });

  const ORIGINS = {
    PARITY_ORIGIN: "https://invite.cire.example.test",
    PARITY_API_ORIGIN: UNUSED_API,
  };

  test.each([
    ["no PARITY_ORIGIN", { PARITY_API_ORIGIN: UNUSED_API }, undefined],
    [
      "an http origin off loopback",
      { ...ORIGINS, PARITY_ORIGIN: "http://invite.cire.example.test" },
      undefined,
    ],
    [
      "an origin with a path",
      { ...ORIGINS, PARITY_ORIGIN: "https://invite.cire.example.test/x" },
      undefined,
    ],
    [
      "a trailing slash",
      { ...ORIGINS, PARITY_ORIGIN: "https://invite.cire.example.test/" },
      undefined,
    ],
    ["one half of the Access token", { ...ORIGINS, CF_ACCESS_CLIENT_ID: "id" }, undefined],
    ["no --out", ORIGINS, [] as string[]],
    ["PF24: no PARITY_API_ORIGIN", { PARITY_ORIGIN: ORIGINS.PARITY_ORIGIN }, undefined],
    [
      "PF24: an http PARITY_API_ORIGIN off loopback",
      { ...ORIGINS, PARITY_API_ORIGIN: "http://api.cire.example.test" },
      undefined,
    ],
    [
      "PF24: a PARITY_API_ORIGIN with a path",
      { ...ORIGINS, PARITY_API_ORIGIN: "https://api.cire.example.test/api" },
      undefined,
    ],
  ] as const)(
    "PF14: %s is a usage error: exit 2, the reference never started",
    async (_, env, args) => {
      const t = tree();
      const { exitCode, stdout } = await runParity(t, env, args);
      expect(stdout).toContain("::error::");
      expect(exitCode).toBe(2);
      expect(existsSync(join(t.state, "call.json"))).toBe(false);
    },
  );

  test("PF14: no build is a usage error: exit 2, the reference never started", async () => {
    const t = tree({ build: false });
    const { exitCode, stdout } = await runParity(t, ORIGINS);
    expect(stdout).toContain("build cire/invites first");
    expect(exitCode).toBe(2);
    expect(existsSync(join(t.state, "call.json"))).toBe(false);
    expect(existsSync(dirname(reportPath(t)))).toBe(false);
  });
});
