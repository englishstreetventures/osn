// Runs scripts/dev-deploy-order.ts the way each dev stack job in
// .github/workflows/deploy.yml runs it, just before its deploy: a real
// process, a real git checkout with full history and an `origin/main` ref,
// and GitHub's API served over HTTP by the fake in ./fake-github. The step's
// products are the `deploy=` line it appends to $GITHUB_OUTPUT, the line it
// appends to $GITHUB_STEP_SUMMARY when it refuses, and its exit code: a
// `deploy=false` that should have been `true` leaves dev stale with every job
// green, and a `true` that should have been `false` puts older code back.
//
// The history every test builds: base ← older ← head ← newer on main, and an
// orphan commit no branch reaches. The job under test runs at `head`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type StackKey, SURFACES } from "../deploy-surfaces";
import {
  dev,
  fakeGitHub,
  type FakeGitHub,
  type FixtureRecord,
  REPO,
  stackJob,
  TOKEN,
} from "./fake-github";

const SCRIPT = new URL("../dev-deploy-order.ts", import.meta.url).pathname;
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

let github: FakeGitHub = fakeGitHub([]);
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: (request) => github.fetch(request) });
});

afterAll(async () => {
  await server.stop(true);
});

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await run(
    ["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    cwd,
  );
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(repo: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}

interface History {
  readonly repo: string;
  readonly older: string;
  readonly head: string;
  readonly newer: string;
  readonly orphan: string;
  readonly output: string;
  readonly summary: string;
}

/**
 * base ← older ← head ← newer on main, `origin/main` at `newer` unless
 * `mainAt` says otherwise, and an orphan commit no branch reaches.
 */
async function withHistory(
  body: (history: History) => Promise<void>,
  options: { readonly mainAt?: "head" | "newer" | "none" } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dev-deploy-order-cli-"));
  try {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await git(repo, "init", "--initial-branch=main", ".");
    await commit(repo, { "cire/api/src/index.ts": "base" });
    const older = await commit(repo, { "cire/api/src/index.ts": "older" });
    const head = await commit(repo, { "cire/api/src/index.ts": "head" });
    const newer = await commit(repo, { "cire/api/src/index.ts": "newer" });
    await git(repo, "checkout", "--orphan", "elsewhere");
    const orphan = await commit(repo, { "cire/api/src/index.ts": "orphan" });
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "elsewhere");
    const mainAt = options.mainAt ?? "newer";
    if (mainAt !== "none") {
      await git(repo, "update-ref", "refs/remotes/origin/main", mainAt === "head" ? head : newer);
    }
    await git(repo, "checkout", "--detach", head);
    await body({
      repo,
      older,
      head,
      newer,
      orphan,
      output: join(dir, "output"),
      summary: join(dir, "summary"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readOr = async (path: string) => readFile(path, "utf8").catch(() => "");

/** Run the order check for `stack` at `head`, as the stack job does. */
async function check(
  history: History,
  stack: StackKey = "cire",
  extra: Record<string, string> = {},
) {
  return run(["bun", "run", SCRIPT, "--stack", stack], history.repo, {
    GITHUB_SHA: history.head,
    GITHUB_REPOSITORY: REPO,
    GITHUB_TOKEN: TOKEN,
    GITHUB_API_URL: server.url.origin,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_OUTPUT: history.output,
    GITHUB_STEP_SUMMARY: history.summary,
    ...extra,
  });
}

const cireSurfaces = SURFACES.filter((s) => s.stack === "cire").map((s) => s.key);

/** The cire stack job's own dev record, in run `runId`. */
const stackRecord = (
  sha: string,
  runId: number,
  extra: Partial<FixtureRecord> = {},
): FixtureRecord => ({
  environment: "dev",
  sha,
  run: runId,
  job: stackJob("cire", "dev"),
  states: ["success", "in_progress", "queued", "waiting"],
  ...extra,
});

/** Each cire surface's record job's dev record, in run `runId`. */
const surfaceRecords = (sha: string, runId: number, keys = cireSurfaces): FixtureRecord[] =>
  keys.map((key) => ({ environment: "dev", sha, run: runId, job: dev(key), states: ["success"] }));

const statusReads = () => github.calls.filter((call) => call.includes("/statuses")).length;
const listReads = () => github.calls.filter((call) => /\/deployments\?/.test(call));

describe("refuses only a commit older than one the stack already passed on dev", () => {
  test("F1: the stack job passed at a commit this one is a strict ancestor of: no deploy, a summary naming both, exit 0", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([stackRecord(h.newer, 2), stackRecord(h.older, 1)]);

      const { exitCode, stdout } = await check(h);

      expect(exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=false\n");
      const summary = await readFile(h.summary, "utf8");
      expect(summary).toContain("cire stack");
      expect(summary).toContain(
        `[\`${h.head.slice(0, 7)}\`](https://github.com/${REPO}/commit/${h.head})`,
      );
      expect(summary).toContain(
        `[\`${h.newer.slice(0, 7)}\`](https://github.com/${REPO}/commit/${h.newer})`,
      );
      expect(stdout).toContain("::notice");
    });
  });

  test("F2: the stack passed at this very commit: deploys (a re-run, or the expect_no_change proof)", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([stackRecord(h.head, 2), ...surfaceRecords(h.head, 2)]);

      const { exitCode } = await check(h);

      expect(exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
      expect(await readOr(h.summary)).toBe("");
    });
  });

  test("F3: the stack passed at an older commit: deploys", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([stackRecord(h.older, 1), ...surfaceRecords(h.older, 1)]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
    });
  });

  test("F4: the stack passed at a commit git cannot place: deploys", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([stackRecord(h.orphan, 3), ...surfaceRecords(h.orphan, 3)]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
    });
  });

  test("F5: no dev record at all: deploys", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
    });
  });

  test("F6: the stack job failed after every surface passed at a newer commit (the guest route comparison): no deploy", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([
        ...surfaceRecords(h.newer, 2),
        stackRecord(h.newer, 2, { states: ["failure", "in_progress"] }),
      ]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=false\n");
      expect(await readFile(h.summary, "utf8")).toContain(h.newer.slice(0, 7));
    });
  });

  test("F16: only some surfaces passed at the newer commit (a partial rollback): deploys", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([
        ...surfaceRecords(h.newer, 2, cireSurfaces.slice(1)),
        stackRecord(h.newer, 2, { states: ["failure", "in_progress"] }),
      ]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
    });
  });

  test("F7: another stack passed at a newer commit: deploys", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([
        {
          environment: "dev",
          sha: h.newer,
          run: 2,
          job: stackJob("zap", "dev"),
          states: ["success"],
        },
        { environment: "dev", sha: h.newer, run: 2, job: dev("zap_api"), states: ["success"] },
      ]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
    });
  });

  test("F8: a newer stack job that succeeded without running its deploy step (it refused, too) is no evidence: deploys", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([stackRecord(h.newer, 2, { deployStep: "skipped" })]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
    });
  });

  test("F9: a newer stack job that failed, or whose record never succeeded: deploys", async () => {
    for (const record of [
      stackRecord("", 2, { states: ["failure", "in_progress"] }),
      stackRecord("", 2, { states: ["in_progress", "queued", "waiting"], conclusion: null }),
      stackRecord("", 2, { conclusion: "failure" }),
    ]) {
      await withHistory(async (h) => {
        github = fakeGitHub([{ ...record, sha: h.newer }]);

        expect((await check(h)).exitCode).toBe(0);
        expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
      });
    }
  });

  test("F10: a forged newer record, linking another branch's, workflow's or fork's run, is no evidence: deploys", async () => {
    for (const origin of [
      { branch: "feature" },
      { path: ".github/workflows/ci.yml" },
      { headRepository: "someone/osn" },
    ]) {
      await withHistory(async (h) => {
        github = fakeGitHub([stackRecord(h.newer, 9)], { origins: { 9: origin } });

        expect((await check(h)).exitCode).toBe(0);
        expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
      });
    }
  });

  test("F15: a newer run whose other jobs are still running (steps with no conclusion yet) still counts: no deploy", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([
        {
          environment: "dev",
          sha: h.newer,
          run: 2,
          job: stackJob("musubi", "dev"),
          states: ["in_progress"],
          conclusion: null,
        },
        stackRecord(h.newer, 2),
      ]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=false\n");
    });
  });
});

describe("what the check costs", () => {
  test("F17: at main's newest commit it asks GitHub nothing, and deploys", async () => {
    await withHistory(
      async (h) => {
        github = fakeGitHub([stackRecord(h.newer, 2)]);

        expect((await check(h)).exitCode).toBe(0);
        expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
        expect(github.calls).toEqual([]);
      },
      { mainAt: "head" },
    );
  });

  test("F11: with newer commits on main but no newer record, it lists one page and reads no status", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([
        stackRecord(h.head, 2),
        ...surfaceRecords(h.head, 2),
        stackRecord(h.older, 1),
        ...surfaceRecords(h.older, 1),
      ]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
      expect(listReads()).toHaveLength(1);
      expect(statusReads()).toBe(0);
    });
  });

  test("F11b, F11c: it reads one page of records at most, so evidence behind 100 newer records of other stacks is not seen, and it deploys", async () => {
    await withHistory(async (h) => {
      const others = Array.from({ length: 100 }, (_, i): FixtureRecord => ({
        environment: "dev",
        sha: h.newer,
        run: 100 + i,
        job: dev("zap_api"),
        states: ["success"],
      }));
      github = fakeGitHub([...others, stackRecord(h.newer, 2)]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=true\n");
      expect(listReads()).toEqual([
        `/repos/${REPO}/deployments?environment=dev&per_page=100&page=1`,
      ]);
      expect(statusReads()).toBeLessThanOrEqual(100);
    });
  });

  test("it stops reading once the evidence is complete", async () => {
    await withHistory(async (h) => {
      const later = Array.from({ length: 60 }, (_, i): FixtureRecord => ({
        environment: "dev",
        sha: h.newer,
        run: 100 + i,
        job: dev("zap_api"),
        states: ["success"],
      }));
      github = fakeGitHub([stackRecord(h.newer, 2), ...later]);

      expect((await check(h)).exitCode).toBe(0);
      expect(await readFile(h.output, "utf8")).toBe("deploy=false\n");
      // The first batch of ten holds the evidence.
      expect(statusReads()).toBeLessThanOrEqual(10);
    });
  });
});

describe("it fails, deploying nothing, when it cannot tell", () => {
  test("F12b: an API error that is not worth a retry fails the step with an annotation and writes no output", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([stackRecord(h.newer, 2)]);

      const { exitCode, stderr } = await check(h, "cire", { GITHUB_TOKEN: "wrong" });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("::error::dev-deploy-order: GitHub API answered 401");
      expect(await readOr(h.output)).toBe("");
      expect(await readOr(h.summary)).toBe("");
    });
  });

  test("F13: an unknown or missing --stack, or a GITHUB_SHA that is not a full commit id, fails before any call", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([]);
      const cases: [string[], Record<string, string>][] = [
        [["--stack", "cire-api"], {}],
        [[], {}],
        [["--stack", "cire"], { GITHUB_SHA: h.head.slice(0, 7) }],
        [["--stack", "cire"], { GITHUB_SHA: "" }],
      ];
      for (const [args, env] of cases) {
        const { exitCode, stderr } = await run(["bun", "run", SCRIPT, ...args], h.repo, {
          GITHUB_SHA: h.head,
          GITHUB_REPOSITORY: REPO,
          GITHUB_TOKEN: TOKEN,
          GITHUB_API_URL: server.url.origin,
          GITHUB_OUTPUT: h.output,
          ...env,
        });
        expect(exitCode).toBe(1);
        expect(stderr).toContain("::error::dev-deploy-order:");
      }
      expect(github.calls).toEqual([]);
      expect(await readOr(h.output)).toBe("");
    });
  });

  test("F14: a shallow checkout, a GITHUB_SHA the checkout lacks, or no origin/main fails the step rather than answer deploy", async () => {
    await withHistory(async (h) => {
      github = fakeGitHub([]);
      const shallow = `${h.repo}-shallow`;
      await git(dirname(h.repo), "clone", "--quiet", "--depth", "1", `file://${h.repo}`, shallow);
      const tip = await git(shallow, "rev-parse", "HEAD");
      await git(shallow, "update-ref", "refs/remotes/origin/main", tip);
      const fromShallow = await run(["bun", "run", SCRIPT, "--stack", "cire"], shallow, {
        GITHUB_SHA: tip,
        GITHUB_REPOSITORY: REPO,
        GITHUB_TOKEN: TOKEN,
        GITHUB_API_URL: server.url.origin,
        GITHUB_OUTPUT: h.output,
      });
      expect(fromShallow.exitCode).toBe(1);
      expect(fromShallow.stderr).toContain("shallow");

      const unknown = await check(h, "cire", {
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      });
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("::error::dev-deploy-order:");

      expect(github.calls).toEqual([]);
      expect(await readOr(h.output)).toBe("");
    });

    await withHistory(
      async (h) => {
        github = fakeGitHub([]);
        const { exitCode, stderr } = await check(h);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("origin/main");
        expect(await readOr(h.output)).toBe("");
      },
      { mainAt: "none" },
    );
  });
});
