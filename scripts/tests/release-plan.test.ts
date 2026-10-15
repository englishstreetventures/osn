// scripts/release-plan.ts decides what a production release ships. These drive
// it with a fake GitHub (fixture Deployment records, statuses and job names
// served through an injected `fetch`) and, where git matters, real
// repositories built in a temp directory.
//
// The case the planner exists for is the first `describe`: a surface whose
// production deploy never ran, followed by a push that touched a different
// surface. The event diff deploy.yml used to compute missed it for good.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { changedFiles, deployReason, surface, SURFACES, type SurfaceKey } from "../deploy-surfaces";
import {
  apiAheadOfHost,
  applyDevGate,
  changedSurfaces,
  type DeploymentReader,
  devGateWanted,
  findDeployed,
  lastDeployed,
  outputLines,
  parseRequest,
  type PlanDecision,
  renderSummary,
  restReader,
  runReleasePlan,
  sameContent,
} from "../release-plan";

// ── fixtures ────────────────────────────────────────────────────────────────

const REPO = "englishstreetventures/osn";
const API = "https://api.github.com";

/** One job's Deployment record as GitHub keeps it. `states` newest first. */
interface FixtureRecord {
  readonly environment: "production" | "dev";
  readonly sha: string;
  readonly job: string;
  readonly states: readonly string[];
  /** Runs are grouped by this number; job ids are derived from it. */
  readonly run: number;
}

interface FakeGitHub {
  readonly fetch: typeof fetch;
  readonly calls: string[];
}

/**
 * A fake api.github.com serving `records` (newest first, per environment) the
 * way the REST API does: paged deployment lists, one statuses list per record,
 * and one jobs list per run. `goneRuns` answer 404, as a run past log
 * retention does.
 */
function fakeGitHub(
  records: readonly FixtureRecord[],
  options: { goneRuns?: readonly number[] } = {},
): FakeGitHub {
  const calls: string[] = [];
  const withIds = records.map((record, index) => ({
    ...record,
    id: 1000 + index,
    jobId: 50_000 + index,
  }));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(`${url.pathname}${url.search}`);
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer test-token")
      return json({ message: "Bad credentials" }, 401);

    const prefix = `/repos/${REPO}`;
    const path = url.pathname.slice(prefix.length);
    if (path === "/deployments") {
      const environment = url.searchParams.get("environment");
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      const list = withIds.filter((r) => r.environment === environment);
      return json(
        list.slice((page - 1) * perPage, page * perPage).map((r) => ({ id: r.id, sha: r.sha })),
      );
    }
    const statuses = /^\/deployments\/(\d+)\/statuses$/.exec(path);
    if (statuses) {
      const record = withIds.find((r) => r.id === Number(statuses[1]));
      if (!record) return json({ message: "Not Found" }, 404);
      return json(
        record.states.map((state) => ({
          state,
          log_url: `https://github.com/${REPO}/actions/runs/${record.run}/job/${record.jobId}`,
        })),
      );
    }
    const jobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (jobs) {
      const run = Number(jobs[1]);
      if (options.goneRuns?.includes(run)) return json({ message: "Not Found" }, 404);
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      const list = withIds.filter((r) => r.run === run).map((r) => ({ id: r.jobId, name: r.job }));
      return json({
        total_count: list.length,
        jobs: list.slice((page - 1) * perPage, page * perPage),
      });
    }
    return json({ message: `unrouted ${path}` }, 500);
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

function reader(github: FakeGitHub): DeploymentReader {
  return restReader({ fetch: github.fetch, token: "test-token", repository: REPO, apiUrl: API });
}

const prod = (key: SurfaceKey) => surface(key).production.name;
const dev = (key: SurfaceKey) => {
  const job = surface(key).dev;
  if (!job) throw new Error(`${key} has no dev job`);
  return job.name;
};

/** Every production (or dev) job of one run, all successful. */
function fullRun(environment: "production" | "dev", sha: string, run: number): FixtureRecord[] {
  return SURFACES.filter((s) => environment === "production" || s.dev !== undefined).map((s) => ({
    environment,
    sha,
    run,
    job: environment === "production" ? s.production.name : dev(s.key),
    states: ["success", "in_progress", "queued", "waiting"],
  }));
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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

async function withRepo(body: (repo: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "release-plan-"));
  try {
    await git(dir, "init", "--initial-branch=main", ".");
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseOutputs(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.split("=") as [string, string]),
  );
}

const env = (head: string, extra: Record<string, string> = {}) => ({
  GITHUB_SHA: head,
  GITHUB_REPOSITORY: REPO,
  GITHUB_TOKEN: "test-token",
  GITHUB_API_URL: API,
  GITHUB_SERVER_URL: "https://github.com",
  ...extra,
});

// ── the case this exists for ────────────────────────────────────────────────

describe("a surface whose production deploy never ran", () => {
  test("ships with the next release, even when the latest push touched another surface", async () => {
    await withRepo(async (repo) => {
      // A: everything deployed. B: cire/api changes, and its production job is
      // cancelled while it waits for approval. C: a push that touches only the
      // landing site, which does reach production.
      const a = await commit(repo, {
        "cire/api/src/index.ts": "1",
        "cire/landing/src/index.astro": "1",
        "osn/api/src/index.ts": "1",
      });
      const b = await commit(repo, { "cire/api/src/index.ts": "2" });
      const c = await commit(repo, { "cire/landing/src/index.astro": "2" });

      const github = fakeGitHub([
        {
          environment: "production",
          sha: c,
          run: 3,
          job: prod("cire_landing"),
          states: ["success", "waiting"],
        },
        {
          environment: "production",
          sha: b,
          run: 2,
          job: prod("cire_api"),
          states: ["error", "waiting"],
        },
        ...fullRun("production", a, 1),
        { environment: "dev", sha: c, run: 3, job: dev("cire_landing"), states: ["success"] },
        { environment: "dev", sha: b, run: 2, job: dev("cire_api"), states: ["success"] },
        ...fullRun("dev", a, 1),
      ]);

      // What deploy.yml's push diff for C saw: the landing site, nothing else.
      expect(
        deployReason(surface("cire_api"), changedFiles(b, c, repo) ?? [], "production"),
      ).toBeUndefined();

      const result = await runReleasePlan({ env: env(c), fetch: github.fetch, cwd: repo });
      const outputs = parseOutputs(result.outputs);

      expect(outputs.cire_api).toBe("true");
      expect(outputs.cire_landing).toBe("false");
      expect(outputs.osn_api).toBe("false");
      expect(outputs.zap_api).toBe("false");
      expect(outputs.any).toBe("true");
      expect(result.summary).toContain("cire/api/src/index.ts changed");
      expect(result.summary).toContain(`production already runs ${c.slice(0, 7)}`);
    });
  });

  test("a rejected release leaves nothing behind: the next one ships the same surfaces", async () => {
    await withRepo(async (repo) => {
      const a = await commit(repo, { "osn/api/src/index.ts": "1" });
      const b = await commit(repo, { "osn/api/src/index.ts": "2" });
      const c = await commit(repo, { "README.md": "docs" });

      // The release of B was rejected at the gate: its record never succeeded.
      const github = fakeGitHub([
        {
          environment: "production",
          sha: b,
          run: 2,
          job: prod("osn_api"),
          states: ["failure", "waiting"],
        },
        ...fullRun("production", a, 1),
        { environment: "dev", sha: b, run: 2, job: dev("osn_api"), states: ["success"] },
        ...fullRun("dev", a, 1),
      ]);

      const outputs = parseOutputs(
        (await runReleasePlan({ env: env(c), fetch: github.fetch, cwd: repo })).outputs,
      );
      expect(outputs.osn_api).toBe("true");
      expect(outputs.any).toBe("true");
    });
  });

  test("an older release planned again does not roll production back", async () => {
    await withRepo(async (repo) => {
      // Production already runs B. Re-running the whole release of A plans at
      // A, whose tree differs — shipping it would be a rollback. Zap has no
      // dev gate to catch that, so this rule is the only thing that does.
      const a = await commit(repo, { "zap/api/src/index.ts": "1", "osn/api/src/index.ts": "1" });
      const b = await commit(repo, { "zap/api/src/index.ts": "2", "osn/api/src/index.ts": "2" });
      const github = fakeGitHub([...fullRun("production", b, 2), ...fullRun("dev", b, 2)]);

      const result = await runReleasePlan({ env: env(a), fetch: github.fetch, cwd: repo });
      const outputs = parseOutputs(result.outputs);
      expect(outputs.zap_api).toBe("false");
      expect(outputs.osn_api).toBe("false");
      expect(outputs.any).toBe("false");
      expect(result.summary).toContain("production is newer");

      const forced = await runReleasePlan({
        env: env(a, { SURFACES: "zap_api", FORCE: "true" }),
        fetch: github.fetch,
        cwd: repo,
      });
      expect(parseOutputs(forced.outputs).zap_api).toBe("true");
    });
  });

  test("a release with nothing behind production ships nothing and asks for no approval", async () => {
    await withRepo(async (repo) => {
      const a = await commit(repo, { "osn/api/src/index.ts": "1" });
      const b = await commit(repo, { "README.md": "docs" });
      const github = fakeGitHub([...fullRun("production", a, 1), ...fullRun("dev", a, 1)]);

      const outputs = parseOutputs(
        (await runReleasePlan({ env: env(b), fetch: github.fetch, cwd: repo })).outputs,
      );
      expect(Object.values(outputs).every((value) => value === "false")).toBe(true);
      // Nothing ships, so no dev record is read.
      expect(github.calls.some((call) => call.includes("environment=dev"))).toBe(false);
    });
  });
});

// ── the dev gate ────────────────────────────────────────────────────────────

describe("dev still gates production", () => {
  test("a change dev has not deployed is held back, and ships once dev has it", async () => {
    await withRepo(async (repo) => {
      const a = await commit(repo, { "cire/host/src/App.tsx": "1" });
      const b = await commit(repo, { "cire/host/src/App.tsx": "2" });

      // Dev's deploy of B failed; dev still runs A.
      const failed = fakeGitHub([
        ...fullRun("production", a, 1),
        {
          environment: "dev",
          sha: b,
          run: 2,
          job: dev("cire_host"),
          states: ["failure", "in_progress"],
        },
        ...fullRun("dev", a, 1),
      ]);
      const held = await runReleasePlan({ env: env(b), fetch: failed.fetch, cwd: repo });
      expect(parseOutputs(held.outputs).cire_host).toBe("false");
      expect(parseOutputs(held.outputs).any).toBe("false");
      expect(held.summary).toContain("held back");
      expect(held.summary).toContain("cire/host/src/App.tsx");

      // Dev deploys B on a later push; the next release ships it.
      const fixed = fakeGitHub([
        ...fullRun("production", a, 1),
        { environment: "dev", sha: b, run: 3, job: dev("cire_host"), states: ["success"] },
        {
          environment: "dev",
          sha: b,
          run: 2,
          job: dev("cire_host"),
          states: ["failure", "in_progress"],
        },
        ...fullRun("dev", a, 1),
      ]);
      const shipped = await runReleasePlan({ env: env(b), fetch: fixed.fetch, cwd: repo });
      expect(parseOutputs(shipped.outputs).cire_host).toBe("true");
    });
  });

  test("a release waiting behind another still ships what dev ran, after dev has moved on", async () => {
    await withRepo(async (repo) => {
      // The release commit is B. By the time its plan runs, dev has already
      // deployed C, a later change to the same surface. Dev did run B's
      // content, in an earlier record, and that is enough.
      const a = await commit(repo, { "cire/host/src/App.tsx": "1" });
      const b = await commit(repo, { "cire/host/src/App.tsx": "2" });
      const c = await commit(repo, { "cire/host/src/App.tsx": "3" });
      const github = fakeGitHub([
        ...fullRun("production", a, 1),
        { environment: "dev", sha: c, run: 3, job: dev("cire_host"), states: ["success"] },
        { environment: "dev", sha: b, run: 2, job: dev("cire_host"), states: ["success"] },
        ...fullRun("dev", a, 1),
      ]);

      const result = await runReleasePlan({ env: env(b), fetch: github.fetch, cwd: repo });
      expect(parseOutputs(result.outputs).cire_host).toBe("true");
      expect(result.summary).toContain(`dev ran this content at ${b.slice(0, 7)}`);
    });
  });

  test("dev on an older commit with the same content for the surface is enough", async () => {
    await withRepo(async (repo) => {
      const a = await commit(repo, { "cire/host/src/App.tsx": "1", "osn/api/src/index.ts": "1" });
      const b = await commit(repo, { "cire/host/src/App.tsx": "2" });
      const c = await commit(repo, { "osn/api/src/index.ts": "2" });
      const github = fakeGitHub([
        ...fullRun("production", a, 1),
        { environment: "dev", sha: c, run: 3, job: dev("osn_api"), states: ["success"] },
        { environment: "dev", sha: b, run: 2, job: dev("cire_host"), states: ["success"] },
        ...fullRun("dev", a, 1),
      ]);

      const outputs = parseOutputs(
        (await runReleasePlan({ env: env(c), fetch: github.fetch, cwd: repo })).outputs,
      );
      expect(outputs.cire_host).toBe("true");
      expect(outputs.osn_api).toBe("true");
    });
  });

  test("zap has no dev tier and ships on its own diff", async () => {
    await withRepo(async (repo) => {
      const a = await commit(repo, { "zap/api/src/index.ts": "1" });
      const b = await commit(repo, { "zap/api/src/index.ts": "2" });
      const github = fakeGitHub([...fullRun("production", a, 1), ...fullRun("dev", a, 1)]);

      const outputs = parseOutputs(
        (await runReleasePlan({ env: env(b), fetch: github.fetch, cwd: repo })).outputs,
      );
      expect(outputs.zap_api).toBe("true");
    });
  });

  test("force ships what it names, whatever production and dev run", async () => {
    await withRepo(async (repo) => {
      const a = await commit(repo, { "cire/host/src/App.tsx": "1" });
      const github = fakeGitHub([...fullRun("production", a, 1)]);

      const result = await runReleasePlan({
        env: env(a, { SURFACES: "cire_host", FORCE: "true" }),
        fetch: github.fetch,
        cwd: repo,
      });
      const outputs = parseOutputs(result.outputs);
      expect(outputs.cire_host).toBe("true");
      expect(
        Object.entries(outputs)
          .filter(([, v]) => v === "true")
          .map(([k]) => k),
      ).toEqual(["cire_host", "any"]);
      expect(github.calls.some((call) => call.includes("environment=dev"))).toBe(false);
    });
  });
});

// ── reading Deployment records ──────────────────────────────────────────────

describe("lastDeployed", () => {
  test("takes the newest record with a success status, per surface", async () => {
    const github = fakeGitHub([
      { environment: "production", sha: "c3", run: 3, job: prod("osn_api"), states: ["error"] },
      {
        environment: "production",
        sha: "b2",
        run: 2,
        job: prod("osn_api"),
        states: ["success", "waiting"],
      },
      { environment: "production", sha: "a1", run: 1, job: prod("osn_api"), states: ["success"] },
      { environment: "production", sha: "a1", run: 1, job: prod("cire_api"), states: ["success"] },
    ]);
    const found = await lastDeployed(reader(github), "production", ["osn_api", "cire_api"]);
    expect(Object.fromEntries(found)).toEqual({ osn_api: "b2", cire_api: "a1" });
  });

  test("counts a success that a later status superseded", async () => {
    const github = fakeGitHub([
      {
        environment: "production",
        sha: "b2",
        run: 2,
        job: prod("osn_api"),
        states: ["inactive", "success"],
      },
    ]);
    expect(
      Object.fromEntries(await lastDeployed(reader(github), "production", ["osn_api"])),
    ).toEqual({
      osn_api: "b2",
    });
  });

  test("ignores records made by jobs that deploy no surface, and jobs of the other tier", async () => {
    const github = fakeGitHub([
      {
        environment: "production",
        sha: "x9",
        run: 9,
        job: "Build + deploy osn-landing",
        states: ["success"],
      },
      {
        environment: "production",
        sha: "x8",
        run: 8,
        job: "Set OSN_PAIRWISE_SALT on production",
        states: ["success"],
      },
      { environment: "production", sha: "x7", run: 7, job: dev("osn_api"), states: ["success"] },
      { environment: "production", sha: "a1", run: 1, job: prod("osn_api"), states: ["success"] },
    ]);
    expect(
      Object.fromEntries(await lastDeployed(reader(github), "production", ["osn_api"])),
    ).toEqual({
      osn_api: "a1",
    });
  });

  test("ignores a record whose run is gone", async () => {
    const github = fakeGitHub(
      [
        { environment: "production", sha: "b2", run: 2, job: prod("osn_api"), states: ["success"] },
        { environment: "production", sha: "a1", run: 1, job: prod("osn_api"), states: ["success"] },
      ],
      { goneRuns: [2] },
    );
    expect(
      Object.fromEntries(await lastDeployed(reader(github), "production", ["osn_api"])),
    ).toEqual({
      osn_api: "a1",
    });
  });

  test("stops reading once every wanted surface is found", async () => {
    const records: FixtureRecord[] = [
      { environment: "production", sha: "b2", run: 2, job: prod("osn_api"), states: ["success"] },
      ...Array.from({ length: 150 }, (_, i) => ({
        environment: "production" as const,
        sha: `old${i}`,
        run: 100 + i,
        job: prod("osn_api"),
        states: ["success"],
      })),
    ];
    const github = fakeGitHub(records);
    await lastDeployed(reader(github), "production", ["osn_api"], { batch: 1 });
    expect(github.calls.filter((call) => call.includes("/statuses"))).toHaveLength(1);
    expect(github.calls.filter((call) => call.includes("page=2"))).toHaveLength(0);
  });

  test("gives up after maxRecords and reports the surface as not found", async () => {
    const github = fakeGitHub(
      Array.from({ length: 250 }, (_, i) => ({
        environment: "production" as const,
        sha: `s${i}`,
        run: i + 1,
        job: prod("osn_api"),
        states: ["error"],
      })),
    );
    const found = await lastDeployed(reader(github), "production", ["osn_api"], {
      maxRecords: 120,
    });
    expect(found.size).toBe(0);
    expect(github.calls.filter((call) => call.includes("/statuses"))).toHaveLength(120);
    expect(github.calls.filter((call) => call.includes("page=3"))).toHaveLength(0);
  });

  test("reads each run's job names once", async () => {
    const github = fakeGitHub(fullRun("production", "a1", 1));
    const found = await lastDeployed(
      reader(github),
      "production",
      SURFACES.map((s) => s.key),
    );
    expect(found.size).toBe(8);
    expect(github.calls.filter((call) => call.includes("/jobs"))).toHaveLength(1);
  });

  test("findDeployed keeps walking past records accept refuses, and reports the newest it saw", async () => {
    const github = fakeGitHub([
      { environment: "dev", sha: "c3", run: 3, job: dev("cire_host"), states: ["success"] },
      { environment: "dev", sha: "b2", run: 2, job: dev("cire_host"), states: ["success"] },
      { environment: "dev", sha: "a1", run: 1, job: dev("cire_host"), states: ["success"] },
    ]);
    const found = await findDeployed(reader(github), "dev", ["cire_host"], {
      accept: (_, sha) => sha === "b2",
      batch: 1,
    });
    expect(Object.fromEntries(found.accepted)).toEqual({ cire_host: "b2" });
    expect(Object.fromEntries(found.newest)).toEqual({ cire_host: "c3" });
    // It stopped at b2: a1's statuses were never read.
    expect(github.calls.filter((call) => call.includes("/statuses"))).toHaveLength(2);
  });

  test("findDeployed with nothing acceptable still names the newest", async () => {
    const github = fakeGitHub([
      { environment: "dev", sha: "c3", run: 3, job: dev("cire_host"), states: ["success"] },
    ]);
    const found = await findDeployed(reader(github), "dev", ["cire_host"], { accept: () => false });
    expect(found.accepted.size).toBe(0);
    expect(found.newest.get("cire_host")).toBe("c3");
  });

  test("an empty wish list reads nothing", async () => {
    const github = fakeGitHub(fullRun("production", "a1", 1));
    expect((await lastDeployed(reader(github), "production", [])).size).toBe(0);
    expect(github.calls).toHaveLength(0);
  });
});

describe("restReader", () => {
  test("sends the token and the API version, and names the environment", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await restReader({ fetch: fetcher, token: "t0k", repository: REPO, apiUrl: API }).deployments(
      "production",
      2,
    );
    expect(seen[0]?.url).toBe(
      `${API}/repos/${REPO}/deployments?environment=production&per_page=100&page=2`,
    );
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer t0k");
    expect(seen[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  test("throws on an error answer, naming the status", async () => {
    const fetcher = (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const r = restReader({ fetch: fetcher, token: "t", repository: REPO, apiUrl: API });
    await expect(r.deployments("production", 1)).rejects.toThrow(/502/);
    await expect(r.statuses(1)).rejects.toThrow(/502/);
    await expect(r.jobNames(1)).rejects.toThrow(/502/);
  });

  test("reads every page of a run's jobs", async () => {
    const jobs = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, name: `job ${i + 1}` }));
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      return new Response(
        JSON.stringify({ total_count: 130, jobs: jobs.slice((page - 1) * 100, page * 100) }),
      );
    }) as unknown as typeof fetch;
    const names = await restReader({
      fetch: fetcher,
      token: "t",
      repository: REPO,
      apiUrl: API,
    }).jobNames(7);
    expect(names.size).toBe(130);
    expect(names.get(130)).toBe("job 130");
  });
});

// ── the decision ────────────────────────────────────────────────────────────

describe("parseRequest", () => {
  test("empty means every surface, and force defaults off", () => {
    expect(parseRequest(undefined, undefined)).toEqual({
      surfaces: SURFACES.map((s) => s.key),
      force: false,
    });
    expect(parseRequest("", "")).toEqual({ surfaces: SURFACES.map((s) => s.key), force: false });
  });

  test("takes a comma or space separated list, once each", () => {
    expect(parseRequest("cire_host, cire_api cire_host", "false").surfaces).toEqual([
      "cire_host",
      "cire_api",
    ]);
  });

  test("refuses a name that is not a surface, listing the real ones", () => {
    expect(() => parseRequest("cire-api", "")).toThrow(/cire-api.*cire_api/s);
  });

  test("force is true or false, nothing else", () => {
    expect(parseRequest("", "true").force).toBe(true);
    expect(() => parseRequest("", "yes")).toThrow(/FORCE/);
  });
});

const head = "f".repeat(40);
const base = "a".repeat(40);

function decide(
  files: readonly string[] | undefined,
  options: {
    production?: Map<SurfaceKey, string>;
    surfaces?: SurfaceKey[];
    force?: boolean;
    productionIsNewer?: boolean;
  } = {},
): PlanDecision[] {
  return changedSurfaces({
    head,
    request: {
      surfaces: options.surfaces ?? SURFACES.map((s) => s.key),
      force: options.force ?? false,
    },
    production: options.production ?? new Map(SURFACES.map((s) => [s.key, base])),
    diff: () => files,
    productionIsNewer: () => options.productionIsNewer ?? false,
  });
}

const shipping = (decisions: readonly PlanDecision[]) =>
  decisions.filter((d) => d.ship).map((d) => d.key);

describe("changedSurfaces", () => {
  test("ships what changed since each surface's production commit", () => {
    expect(shipping(decide(["osn/api/src/index.ts", "README.md"]))).toEqual(["osn_api"]);
  });

  test("a shared path ships everything", () => {
    expect(shipping(decide(["bun.lock"]))).toEqual(SURFACES.map((s) => s.key));
    expect(shipping(decide([".github/workflows/production-release.yml"]))).toEqual(
      SURFACES.map((s) => s.key),
    );
  });

  test("the dev workflow is not a production input", () => {
    expect(shipping(decide([".github/workflows/deploy.yml"]))).toEqual([]);
  });

  test("a surface with no production record ships", () => {
    const decisions = decide([], { production: new Map() });
    expect(shipping(decisions)).toEqual(SURFACES.map((s) => s.key));
    expect(decisions[0]?.reason).toContain("no successful production deployment");
  });

  test("a production commit git cannot compare ships the surface", () => {
    const decisions = decide(undefined);
    expect(shipping(decisions)).toEqual(SURFACES.map((s) => s.key));
    expect(decisions[0]?.reason).toContain("cannot compare");
  });

  test("production already on the release commit is unchanged, without a diff", () => {
    const decisions = decide(undefined, {
      production: new Map([["osn_api", head]]),
      surfaces: ["osn_api"],
    });
    expect(shipping(decisions)).toEqual([]);
    expect(decisions.find((d) => d.key === "osn_api")?.reason).toContain("production already runs");
  });

  test("production on a newer commit is not rolled back", () => {
    const decisions = decide(["osn/api/src/index.ts"], { productionIsNewer: true });
    expect(shipping(decisions)).toEqual([]);
    expect(decisions.find((d) => d.key === "osn_api")?.status).toBe("production is newer");
  });

  test("a surface left out of the request does not ship", () => {
    const decisions = decide(["bun.lock"], { surfaces: ["cire_api"] });
    expect(shipping(decisions)).toEqual(["cire_api"]);
    expect(decisions.find((d) => d.key === "osn_api")?.status).toBe("not requested");
  });

  test("force ships the request without looking at the diff, and may roll back", () => {
    expect(shipping(decide([], { force: true, surfaces: ["osn_api"] }))).toEqual(["osn_api"]);
    expect(
      shipping(decide([], { force: true, surfaces: ["osn_api"], productionIsNewer: true })),
    ).toEqual(["osn_api"]);
  });
});

describe("applyDevGate", () => {
  const files = new Map<string, readonly string[] | undefined>([
    ["same", ["README.md", ".github/workflows/deploy.yml"]],
    ["behind", ["cire/host/src/App.tsx"]],
    ["behind-shared", ["bun.lock"]],
  ]);
  const devRecords = (
    accepted: [SurfaceKey, string][],
    newest: [SurfaceKey, string][] = accepted,
  ) => ({
    accepted: new Map(accepted),
    newest: new Map(newest),
  });
  const gate = (decisions: PlanDecision[], commits: ReturnType<typeof devRecords>, force = false) =>
    applyDevGate({ decisions, dev: commits, diff: (from) => files.get(from), force });

  test("wants dev records only for shipping surfaces that have a dev tier", () => {
    const decisions = decide(["cire/host/src/App.tsx", "zap/api/x.ts"]);
    expect(devGateWanted(decisions, false)).toEqual(["cire_host"]);
    expect(devGateWanted(decisions, true)).toEqual([]);
  });

  test("passes a surface with a dev deployment built from the same content", () => {
    const out = gate(decide(["cire/host/src/App.tsx"]), devRecords([["cire_host", "same"]]));
    expect(shipping(out)).toEqual(["cire_host"]);
    expect(out.find((d) => d.key === "cire_host")?.reason).toContain(
      "dev ran this content at same",
    );
  });

  test("holds a surface no dev deployment matches, naming dev's newest and the way out", () => {
    for (const newest of ["behind", "behind-shared", "unknown"]) {
      const out = gate(decide(["cire/host/src/App.tsx"]), devRecords([], [["cire_host", newest]]));
      const host = out.find((d) => d.key === "cire_host");
      expect(host?.ship).toBe(false);
      expect(host?.status).toBe("held back");
      expect(host?.reason).toContain(`dev's newest`);
      expect(host?.reason).toContain("re-run the failed dev job or dispatch Deploy");
    }
    const none = gate(decide(["cire/host/src/App.tsx"]), devRecords([]));
    expect(none.find((d) => d.key === "cire_host")?.reason).toContain(
      "no successful dev deployment",
    );
  });

  test("force skips the gate", () => {
    const out = gate(decide([], { force: true, surfaces: ["cire_host"] }), devRecords([]), true);
    expect(shipping(out)).toEqual(["cire_host"]);
  });

  test("sameContent: only the surface's own and shared paths count, and an unknown diff never matches", () => {
    expect(sameContent(surface("cire_host"), ["README.md", ".github/workflows/deploy.yml"])).toBe(
      true,
    );
    expect(sameContent(surface("cire_host"), ["cire/ui/x.tsx"])).toBe(false);
    expect(sameContent(surface("cire_host"), ["bun.lock"])).toBe(false);
    expect(sameContent(surface("cire_host"), undefined)).toBe(false);
  });
});

describe("what the plan job writes", () => {
  test("one line per surface, then any", () => {
    const lines = outputLines(decide(["osn/api/x.ts"]))
      .trim()
      .split("\n");
    expect(lines).toEqual([...SURFACES.map((s) => `${s.key}=${s.key === "osn_api"}`), "any=true"]);
    expect(outputLines(decide([])).trim().split("\n").at(-1)).toBe("any=false");
  });

  test("the summary warns when cire-api ships while the host portal is behind", () => {
    const context = { head, repository: REPO, serverUrl: "https://github.com" };
    expect(apiAheadOfHost(decide(["cire/dietary/x.ts"]))).toBe(true);
    expect(renderSummary(decide(["cire/dietary/x.ts"]), context)).toContain("[!WARNING]");
    expect(apiAheadOfHost(decide(["cire/api/x.ts"]))).toBe(false);
    expect(renderSummary(decide(["cire/api/x.ts"]), context)).not.toContain("[!WARNING]");
    const held = decide(["cire/dietary/x.ts"]);
    const host = held.findIndex((d) => d.key === "cire_host");
    held[host] = { ...held[host]!, ship: false, status: "held back" };
    expect(apiAheadOfHost(held)).toBe(true);
  });

  test("the summary lists every surface with its production commit and a compare link", () => {
    const summary = renderSummary(decide(["osn/api/x.ts"]), {
      head,
      repository: REPO,
      serverUrl: "https://github.com",
    });
    for (const s of SURFACES) expect(summary).toContain(`| \`${s.key}\``);
    expect(summary).toContain(`https://github.com/${REPO}/compare/${base}...${head}`);
    expect(summary).toContain("osn/api/x.ts changed");
  });
});

describe("runReleasePlan refuses a broken environment", () => {
  test("no token", async () => {
    const github = fakeGitHub([]);
    await expect(
      runReleasePlan({ env: { ...env(head), GITHUB_TOKEN: "" }, fetch: github.fetch, cwd: "." }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  test("a repository that is not owner/name", async () => {
    const github = fakeGitHub([]);
    await expect(
      runReleasePlan({
        env: { ...env(head), GITHUB_REPOSITORY: "../x" },
        fetch: github.fetch,
        cwd: ".",
      }),
    ).rejects.toThrow(/GITHUB_REPOSITORY/);
  });

  test("an API error fails the plan rather than shipping everything", async () => {
    const fetcher = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(runReleasePlan({ env: env(head), fetch: fetcher, cwd: "." })).rejects.toThrow(
      /503/,
    );
  });
});
