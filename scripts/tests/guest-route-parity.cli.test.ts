// The `import.meta.main` block of scripts/guest-route-parity.ts: what reaches
// `wrangler dev`, what each side is asked, what the report says and the exit
// code (NEW-FEAT.md PF12–PF16).
//
// Each test copies the script, and the smoke check it takes `judge()` from,
// byte for byte into a temporary tree shaped like this repository, so it
// finds a stand-in for cire/invites' wrangler where it looks for the real
// one. The stand-in logs its working directory, arguments and environment,
// leaves a `.wrangler` beside the config as `wrangler dev` does, then serves
// the answers the test wrote, on the port it was given. The dev host is a
// server in this process. The real `wrangler dev` runs in the cire stack job
// on dev, after each deploy.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run, SEEDED_PROBES } from "../guest-route-parity";
import { CI_USER_AGENT } from "../smoke-check";

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

let root: string;

/** Every process a test starts, stopped after the file even when a test times out. */
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
  port: Number(process.env.STANDIN_PORT ?? 0),
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
if (portFile) writeFileSync(portFile, String(server.port));
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
    readonly exitAtOnce?: boolean;
    /** The stand-in starts and never serves. */
    readonly neverServe?: boolean;
  } = {},
): Tree {
  const dir = mkdtempSync(join(root, "tree-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of ["guest-route-parity.ts", "smoke-check.ts"]) {
    copyFileSync(join(SCRIPTS, file), join(dir, "scripts", file));
  }
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
  }
  const state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "server.ts"), SERVER);
  const bin = join(invites, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "wrangler");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
state=${JSON.stringify(state)}
{ printf '%s\\n' "--- call" "$PWD" "$@" "--- env"; env | sort; } >> "$state/calls.log"
echo $$ > "$state/reference.pid"
prev=""; for arg in "$@"; do [ "$prev" = "--env-file" ] && cat "$arg" > "$state/env-file.txt"; prev="$arg"; done
${options.neverServe === true ? "exec sleep 30" : ""}
${options.exitAtOnce === true ? "echo 'stand-in refusing to start' >&2; exit 3" : ""}
mkdir -p dist/server/.wrangler/tmp
port=""
while [ $# -gt 0 ]; do [ "$1" = "--port" ] && port="$2"; shift; done
STANDIN_PORT="$port" exec ${JSON.stringify(process.execPath)} "$state/server.ts" "$state/reference.json" "" "$state/reference.log"
`,
  );
  chmodSync(stub, 0o755);
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

const report = (t: Tree) =>
  JSON.parse(readFileSync(join(t.state, "out", "report.json"), "utf8")) as {
    readonly result: string;
    readonly refusals: readonly string[];
    readonly probes: readonly { readonly path: string; readonly differences: readonly string[] }[];
  };

const ACCESS = { CF_ACCESS_CLIENT_ID: "access-id", CF_ACCESS_CLIENT_SECRET: "access-secret" };

/**
 * Whether the stand-in wrangler the run started is gone, its process group
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

describe.concurrent("guest-route-parity.ts", () => {
  test("a dev host answering as Wrangler does matches; wrangler dev gets the build's config, its own origin, no credential, no Access token and no telemetry, and leaves nothing in the build", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, ANSWERS);
    try {
      const { exitCode, stdout } = await runParity(t, {
        PARITY_ORIGIN: host.origin,
        ...ACCESS,
        CLOUDFLARE_API_TOKEN: "not-a-real-token",
        CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      });
      expect(stdout).toContain("guest route parity: match");
      expect(exitCode).toBe(0);
    } finally {
      host.stop();
    }
    expect(report(t).result).toBe("match");
    const calls = readFileSync(join(t.state, "calls.log"), "utf8");
    const [call, env] = calls.split("--- env\n") as [string, string];
    const args = call.split("\n");
    expect(args[1]).toBe(join(t.dir, "cire", "invites"));
    const port = args[args.indexOf("--port") + 1];
    expect(args).toContain("--config");
    expect(args[args.indexOf("--config") + 1]).toBe("dist/server/wrangler.json");
    expect(args[args.indexOf("--local-upstream") + 1]).toBe(`127.0.0.1:${port}`);
    expect(args).toContain("--persist-to");
    // An empty env file of the run's own: Wrangler loads no `.env` or `.dev.vars`.
    const envFile = args[args.indexOf("--env-file") + 1] ?? "";
    expect(envFile).toContain("guest-route-parity-");
    expect(readFileSync(join(t.state, "env-file.txt"), "utf8")).toBe("");
    // A home of the run's own, so no `wrangler login` token is found.
    expect(env).toMatch(/^HOME=.*guest-route-parity-.*\/home$/m);
    expect(env).toMatch(/^XDG_CONFIG_HOME=.*guest-route-parity-.*\/home$/m);
    expect(env).not.toMatch(/^CLOUDFLARE_/m);
    expect(env).not.toMatch(/^CF_ACCESS_/m);
    expect(env).toMatch(/^DO_NOT_TRACK=1$/m);
    expect(env).toMatch(/^WRANGLER_SEND_METRICS=false$/m);
    expect(existsSync(join(t.dir, "cire", "invites", "dist", "server", ".wrangler"))).toBe(false);
    expect(await referenceGone(t)).toBe(true);
    // The Access token reaches the dev host and nothing else.
    const asked = readFileSync(join(t.state, "dev.log"), "utf8").trim().split("\n");
    expect(asked.every((line) => JSON.parse(line).id === "access-id")).toBe(true);
    const local = readFileSync(join(t.state, "reference.log"), "utf8").trim().split("\n");
    expect(local.every((line) => JSON.parse(line).id === null)).toBe(true);
  });

  test("every probe of the dev host sends the CI user agent beside the Access headers", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, ANSWERS);
    try {
      const { exitCode } = await runParity(t, { PARITY_ORIGIN: host.origin, ...ACCESS });
      expect(exitCode).toBe(0);
    } finally {
      host.stop();
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

  test("a header that differs on the dev host is reported, and the run exits 1", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, {
      ...ANSWERS,
      "/privacy/": {
        ...ANSWERS["/privacy/"],
        headers: {
          ...ANSWERS["/privacy/"]!.headers,
          "content-security-policy-report-only": "default-src *",
        },
      },
    });
    try {
      const { exitCode, stdout } = await runParity(t, { PARITY_ORIGIN: host.origin });
      expect(stdout).toContain("/privacy/ content-security-policy-report-only: default-src *");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
    }
    expect(report(t).result).toBe("differ");
    expect(await referenceGone(t)).toBe(true);
  });

  test("Access's session cookie and assertion, and the service token, reach neither the report nor the log", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, ANSWERS, {
      "set-cookie": "CF_Authorization=secret-session; Path=/; Secure; HttpOnly",
      "cf-access-jwt-assertion": "secret-assertion",
    });
    let stdout = "";
    try {
      const result = await runParity(t, { PARITY_ORIGIN: host.origin, ...ACCESS });
      stdout = result.stdout;
      expect(result.exitCode).toBe(0);
    } finally {
      host.stop();
    }
    const written = readFileSync(join(t.state, "out", "report.json"), "utf8");
    for (const secret of ["secret-session", "secret-assertion", "access-id", "access-secret"]) {
      expect(written).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
  });

  test("PF15: a difference that does not hold when asked again is not reported", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    // The dev host's first answer for /privacy/ is a 503; the second is the page.
    const host = await devHost(t, { ...ANSWERS, "/privacy/#0": { status: 503, body: "busy" } });
    try {
      const { exitCode } = await runParity(t, { PARITY_ORIGIN: host.origin });
      expect(exitCode).toBe(0);
    } finally {
      host.stop();
    }
  });

  test("PF12: a seeded wedding that renders only the built-in shell on both sides refuses the run", async () => {
    const t = tree();
    const shell: Answer = {
      headers: { "content-type": "text/html" },
      body: "<html><head><title>You&#39;re Invited</title></head></html>",
    };
    const answers = {
      ...ANSWERS,
      "/cire-wedding": shell,
      "/cire-wedding/registry": shell,
      "/cire/invite?slug=cire-wedding": shell,
      "/cire/registry?slug=cire-wedding": shell,
    };
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(answers));
    const host = await devHost(t, answers);
    try {
      const { exitCode, stdout } = await runParity(t, { PARITY_ORIGIN: host.origin });
      expect(stdout).toContain("the seeded wedding");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
    }
    expect(report(t).result).toBe("refused");
  });

  test("PF10: Cloudflare answering for the Worker on the dev host refuses the run, naming it", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, { ...ANSWERS, "/terms/": { status: 429 } });
    try {
      const { exitCode, stdout } = await runParity(t, { PARITY_ORIGIN: host.origin });
      expect(stdout).toContain("/terms/: answered 429");
      expect(exitCode).toBe(1);
    } finally {
      host.stop();
    }
  });

  test("PF1: a page route missing from the build's manifest refuses the run before wrangler starts", async () => {
    const t = tree({ manifest: MANIFEST.replace(',{"route":"/[slug]/registry"}', "") });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
    });
    expect(stdout).toContain(
      "The page route /[slug]/registry is not in the build's route manifest",
    );
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "calls.log"))).toBe(false);
    expect(report(t).result).toBe("refused");
  });

  test("PF16: wrangler dev that never serves the build refuses the run once its time is up, and is stopped", async () => {
    const t = tree({ neverServe: true });
    const result = await run(
      { origin: "https://invite.cire.example.test", access: {}, out: join(t.state, "unused.json") },
      { root: t.dir, deadlineMs: 20_000, readyMs: 500 },
    );
    expect(result.result).toBe("refused");
    expect(result.refusals[0]).toContain("wrangler dev did not serve the build within 0.5 s");
    expect(await referenceGone(t)).toBe(true);
  });

  test("PF16: a run that passes its deadline stops probing and still returns a refused report", async () => {
    const t = tree();
    writeFileSync(join(t.state, "reference.json"), JSON.stringify(ANSWERS));
    const host = await devHost(t, {
      ...ANSWERS,
      "/cire-wedding": { ...SEEDED_PAGE, delayMs: 5_000 },
    });
    try {
      const result = await run(
        { origin: host.origin, access: {}, out: join(t.state, "unused.json") },
        { root: t.dir, deadlineMs: 1_500, readyMs: 10_000 },
      );
      expect(result.result).toBe("refused");
      expect(result.refusals.some((line) => line.includes("passed its 1.5 s deadline"))).toBe(true);
      expect(result.probes.length).toBeLessThan(5);
    } finally {
      host.stop();
    }
    expect(await referenceGone(t)).toBe(true);
  });

  test("PF16: wrangler dev failing to start still writes the report, refused, and exits 1", async () => {
    const t = tree({ exitAtOnce: true });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
    });
    expect(stdout).toContain("wrangler dev exited (3)");
    expect(exitCode).toBe(1);
    expect(report(t).result).toBe("refused");
  });

  test("PF1: a route in the build's manifest that no probe reaches refuses the run before wrangler starts", async () => {
    const t = tree({ manifest: `${MANIFEST},{"route":"/brand-new/[thing]/deep"}` });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
    });
    expect(stdout).toContain("No probe reaches the route /brand-new/[thing]/deep");
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "calls.log"))).toBe(false);
    expect(report(t).result).toBe("refused");
  });

  test("PF1: a manifest the script cannot read refuses the run before wrangler starts", async () => {
    const t = tree({ manifest: '{route:"/"}' });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
    });
    expect(stdout).toContain("lists no route");
    expect(exitCode).toBe(1);
    expect(existsSync(join(t.state, "calls.log"))).toBe(false);
  });

  test.each([
    ["no PARITY_ORIGIN", {}, undefined],
    [
      "an http origin off loopback",
      { PARITY_ORIGIN: "http://invite.cire.example.test" },
      undefined,
    ],
    ["an origin with a path", { PARITY_ORIGIN: "https://invite.cire.example.test/x" }, undefined],
    ["a trailing slash", { PARITY_ORIGIN: "https://invite.cire.example.test/" }, undefined],
    [
      "one half of the Access token",
      { PARITY_ORIGIN: "https://invite.cire.example.test", CF_ACCESS_CLIENT_ID: "id" },
      undefined,
    ],
    ["no --out", { PARITY_ORIGIN: "https://invite.cire.example.test" }, [] as string[]],
  ] as const)("PF14: %s is a usage error: exit 2, wrangler never started", async (_, env, args) => {
    const t = tree();
    const { exitCode, stdout } = await runParity(t, env, args);
    expect(stdout).toContain("::error::");
    expect(exitCode).toBe(2);
    expect(existsSync(join(t.state, "calls.log"))).toBe(false);
  });

  test("PF14: no build is a usage error: exit 2, wrangler never started", async () => {
    const t = tree({ build: false });
    const { exitCode, stdout } = await runParity(t, {
      PARITY_ORIGIN: "https://invite.cire.example.test",
    });
    expect(stdout).toContain("build cire/invites first");
    expect(exitCode).toBe(2);
    expect(existsSync(join(t.state, "calls.log"))).toBe(false);
    expect(existsSync(dirname(join(t.state, "out", "report.json")))).toBe(false);
  });
});
