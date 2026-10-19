// scripts/worker-deployments.ts runs on each side of a dev stack deploy: its
// `snapshot` records each Worker's newest deployment before the deploy, and its
// `compare` tells each smoke step which deployment the deploy made, or that it
// made none. These drive it with an injected fetch standing in for the
// Cloudflare API, and real files for the snapshot and $GITHUB_OUTPUT.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Deployment, rollbackMessage } from "../smoke-check";
import { runWorkerDeployments } from "../worker-deployments";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-for-worker-deployments-tests";
const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };

const deploymentsUrl = (worker: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}/deployments`;

// Deployment ids in the form the Cloudflare deployments API returns them.
const DEP_NEW = "0c9e2f4a-7b1d-4e3a-8c5f-6a2d9b1e0f73";
const DEP_SAME = "3a7d1e9c-2b4f-4a6e-9d0c-8e1f5b2a7c46";
const DEP_OLD = "6e4b2a1c-9d7f-4c3e-b8a5-1f0d2e3c4b59";
const DEP_PLAIN = "9b1f3c5e-4d2a-4e6b-a7c9-0d8e2f1a3b64";
const DEP_RESTORED = "d2a4c6e8-1b3f-4d5a-9c7e-2f4b6d8a0c18";

const deployment = (id: string, createdOn: string, message?: string): Deployment => ({
  id,
  created_on: createdOn,
  versions: [{ version_id: `v-${id}`, percentage: 100 }],
  ...(message === undefined ? {} : { annotations: { "workers/message": message } }),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const listing = (deployments: readonly Deployment[]) =>
  json({ success: true, errors: [], messages: [], result: { deployments } });
const apiError = (code: number, message: string, status = 400) =>
  json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);
const NOT_FOUND = () => apiError(10_007, "This Worker does not exist on your account.", 404);

type Answer = () => Response | Error;

/** Each Worker's deployments endpoint; any other URL is a test bug. */
function fakeApi(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const answer = Object.entries(answers).find(([worker]) => url === deploymentsUrl(worker));
    if (answer === undefined) throw new Error(`test fetched an unlisted URL: ${url}`);
    const value = answer[1]();
    if (value instanceof Error) throw value;
    return value;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

async function withFiles<T>(body: (files: { snapshot: string; output: string }) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "worker-deployments-"));
  try {
    return await body({ snapshot: join(dir, "deployments.json"), output: join(dir, "output") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(
  args: readonly string[],
  answers: Record<string, Answer>,
  env: Record<string, string | undefined>,
) {
  const api = fakeApi(answers);
  const lines: string[] = [];
  const sleeps: number[] = [];
  const code = await runWorkerDeployments({
    args,
    env: { ...CREDENTIALS, ...env },
    fetch: api.fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    out: (text: string) => lines.push(text),
  });
  return { code, calls: api.calls, sleeps, output: lines.join("") };
}

/** Each answer in turn, one per request, the last one repeating. */
function inTurn(...answers: readonly Answer[]): Answer {
  let call = 0;
  return () => {
    const answer = answers[Math.min(call, answers.length - 1)]!;
    call += 1;
    return answer();
  };
}

const readOr = async (path: string) => (existsSync(path) ? readFile(path, "utf8") : undefined);

describe("snapshot, then compare", () => {
  test("a Worker that does not exist yet snapshots as null, and compare names the deployment the deploy made", async () => {
    await withFiles(async ({ snapshot, output }) => {
      const before = await run(
        ["snapshot", snapshot, "osn_social"],
        { "osn-social-dev": NOT_FOUND },
        {
          GITHUB_OUTPUT: output,
        },
      );
      expect(before.code).toBe(0);
      expect(JSON.parse((await readOr(snapshot)) ?? "")).toEqual({ osn_social: null });

      const after = await run(
        ["compare", snapshot, "osn_social"],
        { "osn-social-dev": () => listing([deployment(DEP_NEW, "2026-10-17T09:00:00Z")]) },
        { GITHUB_OUTPUT: output },
      );
      expect(after.code).toBe(0);
      expect(await readOr(output)).toContain(`osn_social_deployment=${DEP_NEW}\n`);
    });
  });

  test("compare writes every surface's line, unknown for one it cannot read, then exits 1", async () => {
    await withFiles(async ({ snapshot, output }) => {
      const same = deployment(DEP_SAME, "2026-10-16T09:00:00Z");
      await writeFile(
        snapshot,
        JSON.stringify({ osn_api: DEP_SAME, osn_social: DEP_OLD, musubi_landing: null }),
      );
      const result = await run(
        ["compare", snapshot, "osn_api", "osn_social", "musubi_landing"],
        {
          "osn-api-dev": () => listing([same]),
          "osn-social-dev": () => apiError(10_000, "Internal error", 500),
          "musubi-landing-dev": () => listing([]),
        },
        { GITHUB_OUTPUT: output },
      );
      expect(result.code).toBe(1);
      expect(await readOr(output)).toBe(
        "osn_api_deployment=unchanged\nosn_social_deployment=unknown\nmusubi_landing_deployment=unknown\n",
      );
      expect(result.output).toContain("::error");
    });
  });
});

describe("snapshot", () => {
  test.each([
    ["Cloudflare refuses", () => apiError(10_000, "Authentication error", 403)],
    ["Cloudflare never answers", () => new TypeError("fetch failed")],
    [
      "an answer whose newest id is not a deployment id",
      () => listing([deployment("dep-plain", "2026-10-16T09:00:00Z")]),
    ],
    [
      "an answer whose newest id would write a line of its own",
      () => listing([deployment(`${DEP_PLAIN}\nforce=true`, "2026-10-16T09:00:00Z")]),
    ],
  ] as const)("exits 1 and writes nothing when %s", async (_, answer) => {
    await withFiles(async ({ snapshot, output }) => {
      const result = await run(
        ["snapshot", snapshot, "osn_api"],
        { "osn-api-dev": answer },
        {
          GITHUB_OUTPUT: output,
        },
      );
      expect(result.code).toBe(1);
      expect(await readOr(snapshot)).toBeUndefined();
      expect(await readOr(output)).toBeUndefined();
      expect(result.output).toContain("::error");
    });
  });

  test("writes force=true, naming the Worker, when a newest deployment is a smoke-check rollback", async () => {
    await withFiles(async ({ snapshot, output }) => {
      const restored = deployment(
        DEP_RESTORED,
        "2026-10-16T10:00:00Z",
        rollbackMessage({ GITHUB_REPOSITORY: "englishstreetventures/osn", GITHUB_RUN_ID: "7" }),
      );
      const plain = deployment(DEP_PLAIN, "2026-10-16T09:00:00Z", "Deployed by hand");
      const rolledBack = await run(
        ["snapshot", snapshot, "osn_api", "osn_social"],
        {
          "osn-api-dev": () => listing([plain]),
          "osn-social-dev": () => listing([plain, restored]),
        },
        { GITHUB_OUTPUT: output },
      );
      expect(rolledBack.code).toBe(0);
      expect(await readOr(output)).toBe("force=true\n");
      expect(rolledBack.output).toContain("osn-social-dev still serves a smoke check's rollback");
      expect(rolledBack.output).not.toContain("osn-api-dev still serves");

      await rm(output);
      const clean = await run(
        ["snapshot", snapshot, "osn_api", "osn_social"],
        { "osn-api-dev": () => listing([plain]), "osn-social-dev": () => listing([plain]) },
        { GITHUB_OUTPUT: output },
      );
      expect(clean.code).toBe(0);
      expect(await readOr(output)).toBe("force=false\n");
    });
  });

  test("never prints the account id or the token, even when Cloudflare echoes them", async () => {
    await withFiles(async ({ snapshot, output }) => {
      const echo = () =>
        apiError(
          10_000,
          `account ${ACCOUNT} rejected token ${TOKEN} for /accounts/${ACCOUNT}`,
          403,
        );
      const result = await run(
        ["snapshot", snapshot, "osn_api"],
        { "osn-api-dev": echo },
        {
          GITHUB_OUTPUT: output,
        },
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain("<account>");
      expect(result.output).not.toContain(ACCOUNT);
      expect(result.output).not.toContain(TOKEN);
    });
  });
});

describe("a deployments read retries a transient failure", () => {
  const LISTED = () => listing([deployment(DEP_PLAIN, "2026-10-16T09:00:00Z")]);
  const snapshotOf = (answer: Answer) =>
    withFiles(async ({ snapshot, output }) => {
      const result = await run(
        ["snapshot", snapshot, "osn_api"],
        { "osn-api-dev": answer },
        {
          GITHUB_OUTPUT: output,
        },
      );
      return { ...result, written: await readOr(snapshot) };
    });

  test("DR1: a 503 then a 200 succeeds on the second attempt, after one 1 s wait", async () => {
    const result = await snapshotOf(
      inTurn(() => apiError(10_000, "Service unavailable", 503), LISTED),
    );
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([deploymentsUrl("osn-api-dev"), deploymentsUrl("osn-api-dev")]);
    expect(result.sleeps).toEqual([1_000]);
    expect(JSON.parse(result.written ?? "")).toEqual({ osn_api: DEP_PLAIN });
  });

  test("DR2: three 5xx fail after three attempts, waiting 1 s then 2 s", async () => {
    const result = await snapshotOf(
      inTurn(
        () => apiError(10_000, "Internal error", 500),
        () => apiError(10_000, "Bad gateway", 502),
        () => apiError(10_000, "Service unavailable", 503),
        LISTED,
      ),
    );
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(3);
    expect(result.sleeps).toEqual([1_000, 2_000]);
    expect(result.written).toBeUndefined();
    expect(result.output).toContain("Service unavailable");
  });

  test.each([
    ["a 404", NOT_FOUND],
    ["a 403", () => apiError(10_000, "Authentication error", 403)],
    ["a 400", () => apiError(10_001, "Bad request", 400)],
  ] as const)("DR3: %s is answered once, never retried", async (_, answer) => {
    const result = await snapshotOf(inTurn(answer, LISTED));
    expect(result.calls).toHaveLength(1);
    expect(result.sleeps).toEqual([]);
  });

  test.each([
    ["a network error", () => new TypeError("fetch failed")],
    ["a timeout", () => new DOMException("The operation timed out.", "TimeoutError")],
    ["a 429", () => apiError(10_000, "Too many requests", 429)],
  ] as const)("DR4: %s is retried, and one answer after it is used", async (_, answer) => {
    const recovered = await snapshotOf(inTurn(answer, answer, LISTED));
    expect(recovered.code).toBe(0);
    expect(recovered.calls).toHaveLength(3);
    expect(recovered.sleeps).toEqual([1_000, 2_000]);

    const failed = await snapshotOf(inTurn(answer));
    expect(failed.code).toBe(1);
    expect(failed.calls).toHaveLength(3);
  });
});

describe("usage", () => {
  const SCRIPT = new URL("../worker-deployments.ts", import.meta.url).pathname;

  test.each([
    [[]],
    [["snapshot"]],
    [["snapshot", "deployments.json"]],
    [["snapshot", "deployments.json", "no_such_surface"]],
    [["compare", "deployments.json", "osn_api", "nope"]],
    [["rollback", "deployments.json", "osn_api"]],
  ])("%j exits 2 before any request", async (args) => {
    await withFiles(async ({ snapshot }) => {
      const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
        cwd: join(snapshot, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: join(snapshot, ".."), ...CREDENTIALS },
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain("::error::worker-deployments:");
      expect(existsSync(join(snapshot, "..", "deployments.json"))).toBe(false);
    });
  });
});
