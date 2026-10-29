// The guest route comparison's reference side for real (NEW-FEAT.md PF34,
// PF35): scripts/guest-route-parity-reference.js under Node, loading the
// wrangler cire/invites resolves and starting it with `unstable_startWorker`
// on the fixture Worker under fixtures/parity-worker, with the relay from
// scripts/guest-route-parity.ts in this process. It is the only test of the
// path a Worker's subrequest takes through workerd, Miniflare's outbound
// service, Node's fetch and the relay to cire-api.
//
// It also holds the relay's one test that must wait out seconds (PF44, 13 s):
// `bun run test:scripts` runs its files one after another, so that wait there
// would hold up every script test.
//
// Named `.e2e.ts` so `bun test ./scripts/` (the Scripts job, which installs
// nothing) skips it; `bun run test:scripts:wrangler` runs it in CI's Build &
// Test job, which has the install and Node. It fails, never skips, when
// either is missing. It ends by writing what the fake origins saw to
// test-artifacts/guest-route-parity-wrangler.json, ports and paths
// normalised, so a rerun writes the same file.

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { referenceEnv, startRelay, type RelayedCall } from "../guest-route-parity";
import { RELAY_TOKEN_HEADER } from "../guest-route-parity-reference.js";
import { CI_USER_AGENT } from "../smoke-check";

const ROOT = join(import.meta.dir, "..", "..");
const CHILD = join(ROOT, "scripts", "guest-route-parity-reference.js");
const INVITES = join(ROOT, "cire", "invites");
const FIXTURE = join(import.meta.dir, "fixtures", "parity-worker", "worker");
const ARTIFACT = join(ROOT, "test-artifacts", "guest-route-parity-wrangler.json");

/** Each test pays esbuild, workerd's start and Miniflare's first fetch of its `cf` data. */
const TEST_MS = 60_000;
/** How long the child has to serve, or to exit. */
const START_MS = 45_000;

/** What one fake origin was sent: the headers this test checks, never every value. */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly userAgent: string | null;
  readonly contentType: string | null;
  readonly fixture: string | null;
  readonly cfWorker: boolean;
  readonly parityHeaders: readonly string[];
}

const artifact: Record<string, unknown> = {};
const scratches: string[] = [];
const stops: (() => void)[] = [];

const scrub = (text: string): string => {
  let out = text.replaceAll(/(127\.0\.0\.1|localhost):\d+/g, "$1:<port>");
  for (const dir of scratches) out = out.replaceAll(dir, "<scratch>");
  return out;
};

afterAll(() => {
  for (const stop of stops) stop();
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, `${scrub(JSON.stringify(artifact, null, 2))}\n`);
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

function origin(answer: (request: Request, body: string) => Response): {
  readonly origin: string;
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
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
        userAgent: request.headers.get("user-agent"),
        contentType: request.headers.get("content-type"),
        fixture: request.headers.get("x-fixture"),
        cfWorker: request.headers.has("cf-worker"),
        parityHeaders: [...request.headers.keys()].filter((name) => name.startsWith("x-parity-")),
      });
      return answer(request, body);
    },
  });
  stops.push(() => void server.stop(true));
  return { origin: `http://127.0.0.1:${server.port}`, seen };
}

function freePort(): Promise<number> {
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

/** A copy of the fixture Worker in a directory of its own, its config rewritten by `edit`. */
function fixture(edit: (config: Record<string, unknown>) => Record<string, unknown>): {
  readonly scratch: string;
  readonly config: string;
} {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "guest-route-parity-e2e-")));
  scratches.push(scratch);
  cpSync(FIXTURE, join(scratch, "worker"), { recursive: true });
  const config = join(scratch, "worker", "wrangler.json");
  const parsed = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
  writeFileSync(config, JSON.stringify(edit(parsed), null, 2));
  mkdirSync(join(scratch, "home"));
  writeFileSync(join(scratch, "empty.env"), "");
  return { scratch, config };
}

interface Child {
  readonly port: number;
  readonly exited: Promise<number | null>;
  /** Whether the child has exited yet. */
  readonly gone: () => boolean;
  readonly stderr: () => string;
}

/** The reference child, started from cire/invites as scripts/guest-route-parity.ts starts it. */
async function child(
  scratch: string,
  config: string,
  relay: { readonly port: number; readonly token: string },
  apiOrigin: string,
): Promise<Child> {
  const port = await freePort();
  const proc: ChildProcess = spawn(
    "node",
    [
      CHILD,
      "--config",
      config,
      "--port",
      String(port),
      "--relay-port",
      String(relay.port),
      "--api-origin",
      apiOrigin,
      "--persist",
      join(scratch, "state"),
      "--env-file",
      join(scratch, "empty.env"),
    ],
    {
      cwd: INVITES,
      env: referenceEnv(process.env, join(scratch, "home"), relay.token),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let gone = false;
  const exited = new Promise<number | null>((resolveExit) => {
    proc.on("exit", (code) => {
      gone = true;
      resolveExit(code);
    });
    proc.on("error", () => {
      gone = true;
      resolveExit(-1);
    });
  });
  stops.push(() => {
    if (proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  return { port, exited, gone: () => gone, stderr: () => stderr };
}

/** Whether the child serves `/robots.txt` from the fixture's assets before it exits or time runs out. */
async function serving(one: Child): Promise<boolean> {
  const by = Date.now() + START_MS;
  while (Date.now() < by && !one.gone()) {
    try {
      // Polled one try at a time until the child serves.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`http://127.0.0.1:${one.port}/robots.txt`, {
        signal: AbortSignal.timeout(2_000),
      });
      // eslint-disable-next-line no-await-in-loop
      await response.arrayBuffer();
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(250);
  }
  return false;
}

describe("the reference on real Wrangler", () => {
  test(
    "PF34: the Worker's calls to cire-api arrive as the CI agent, with their method, body and query, and none of the relay's headers; a call elsewhere keeps the Worker's own; a compressed answer reads as JSON",
    async () => {
      const api = origin((request) => {
        const slug = new URL(request.url).pathname.endsWith("/resolve") ? "resolved" : "by-path";
        return new Response(Bun.gzipSync(JSON.stringify({ slug })), {
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        });
      });
      const other = origin(() => new Response("elsewhere"));
      const { scratch, config } = fixture((parsed) => ({
        ...parsed,
        vars: { API_ORIGIN: api.origin, OTHER_ORIGIN: other.origin },
      }));
      const relayed: RelayedCall[] = [];
      const token = randomBytes(24).toString("hex");
      const relay = startRelay(
        api.origin,
        token,
        (url, init) => fetch(url, init),
        () => (call) => relayed.push(call),
      );
      stops.push(relay.stop);
      const hadWrangler = existsSync(join(INVITES, ".wrangler"));
      const reference = await child(scratch, config, { port: relay.port, token }, api.origin);
      const ready = await serving(reference);
      artifact.pf34 = { ready, api: api.seen, other: other.seen, relayed };
      expect({ ready, log: ready ? "" : reference.stderr() }).toEqual({ ready: true, log: "" });

      const response = await fetch(`http://127.0.0.1:${reference.port}/subrequests`, {
        signal: AbortSignal.timeout(20_000),
      });
      const worker = (await response.json()) as unknown;
      artifact.pf34 = { ready, worker, api: api.seen, other: other.seen, relayed };
      expect(response.status).toBe(200);
      expect(worker).toEqual({
        get: { status: 200, body: { slug: "by-path" } },
        post: { status: 200, body: { slug: "resolved" } },
        other: { status: 200, body: "elsewhere" },
      });

      expect(api.seen.map((one) => `${one.method} ${one.path}`)).toEqual([
        "GET /api/invite/cire-wedding?from=get",
        "POST /api/invite/resolve?from=post",
      ]);
      for (const one of api.seen) {
        expect(one.userAgent).toBe(CI_USER_AGENT);
        expect(one.parityHeaders).toEqual([]);
        expect(one.cfWorker).toBe(false);
      }
      expect(api.seen[1]).toMatchObject({
        body: JSON.stringify({ slug: "cire-wedding" }),
        contentType: "application/json",
        fixture: "post",
      });
      expect(other.seen).toHaveLength(1);
      expect(other.seen[0]).toMatchObject({ method: "GET", path: "/other?from=worker" });
      expect(other.seen[0]?.fixture).toBe("other");
      expect(other.seen[0]?.parityHeaders).toEqual([]);
      expect(other.seen[0]?.userAgent).not.toBe(CI_USER_AGENT);
      expect(relayed.map((one) => `${one.method} ${one.path} ${one.status}`)).toEqual([
        "GET /api/invite/cire-wedding?from=get 200",
        "POST /api/invite/resolve?from=post 200",
      ]);
      // The Worker's GET sets no user agent and its POST sets one: workerd's
      // own requests, as Miniflare hands them to the child.
      expect(relayed.map((one) => one.workerUserAgent)).toEqual(["absent", "present"]);
      expect(existsSync(join(INVITES, ".wrangler"))).toBe(hadWrangler);
    },
    TEST_MS,
  );

  test(
    "PF35: a config whose main names a missing file ends the child with exit 3 and Wrangler's message, well before the readiness timeout",
    async () => {
      const api = origin(() => new Response("unused"));
      const { scratch, config } = fixture((parsed) => ({ ...parsed, main: "missing.js" }));
      const token = randomBytes(24).toString("hex");
      const relay = startRelay(
        api.origin,
        token,
        (url, init) => fetch(url, init),
        () => () => {},
      );
      stops.push(relay.stop);
      const reference = await child(scratch, config, { port: relay.port, token }, api.origin);
      const started = Date.now();
      const code = await Promise.race([
        reference.exited,
        Bun.sleep(START_MS).then(() => "timeout"),
      ]);
      const message = reference
        .stderr()
        .split("\n")
        .filter((line) => line.startsWith("guest-route-parity-reference:"));
      artifact.pf35 = { code, message };
      expect(code).toBe(3);
      expect(Date.now() - started).toBeLessThan(START_MS);
      expect(message.join("\n")).toContain("missing.js");
      expect(api.seen).toEqual([]);
    },
    TEST_MS,
  );
});

/**
 * How long cire-api takes to answer in PF44: past the 12 s by which Bun's
 * default idle timeout (10 s, counted in 4 s ticks) has cut a connection with
 * no answer yet, and short of the 28 s before the relay's own can.
 */
const SLOW_ANSWER_MS = 13_000;

describe("the relay, over the time Bun's default idle timeout allows", () => {
  test(
    "PF44: a cire-api answer that takes longer than Bun's default idle timeout still reaches the Worker, and is recorded",
    async () => {
      const relayed: RelayedCall[] = [];
      const token = randomBytes(24).toString("hex");
      const relay = startRelay(
        "https://api.cire.example.test",
        token,
        async () => {
          await Bun.sleep(SLOW_ANSWER_MS);
          return Response.json({ slug: "cire-wedding" });
        },
        () => (call) => relayed.push(call),
        // The relay's own limit, out of the way: only its idle timeout is under test.
        SLOW_ANSWER_MS + 7_000,
      );
      stops.push(relay.stop);
      const response = await fetch(`http://127.0.0.1:${relay.port}/api/invite/cire-wedding`, {
        headers: { [RELAY_TOKEN_HEADER]: token },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ slug: "cire-wedding" });
      expect(relayed).toEqual([
        {
          method: "GET",
          path: "/api/invite/cire-wedding",
          status: 200,
          workerUserAgent: "absent",
        },
      ]);
    },
    SLOW_ANSWER_MS + 17_000,
  );
});
