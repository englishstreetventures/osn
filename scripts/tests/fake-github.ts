// A fake api.github.com for the release planner's tests: Deployment records,
// their statuses, and the runs and jobs the statuses link, served the way the
// REST API serves them. release-plan.test.ts calls it as an injected `fetch`;
// release-plan.cli.test.ts serves it over HTTP to the real script.

import {
  PRODUCTION_SURFACES,
  SURFACES,
  surface,
  type SurfaceKey,
  WORKFLOW_FILE,
} from "../deploy-surfaces";

export const REPO = "englishstreetventures/osn";
export const API = "https://api.github.com";
export const TOKEN = "test-token";

/** One job's Deployment record as GitHub keeps it. `states` newest first. */
export interface FixtureRecord {
  /** `production-records` holds the records of the sites a production stack deploys. */
  readonly environment: "production" | "production-records" | "dev";
  readonly sha: string;
  readonly job: string;
  readonly states: readonly string[];
  /** Runs are grouped by this number; job ids are derived from the record. */
  readonly run: number;
  /** The run attempt that made the record. Default 1. */
  readonly attempt?: number;
  /** The job's conclusion. Default `success` when a state is, else `failure`. */
  readonly conclusion?: string | null;
  /** The commit the job ran on. Default the record's own `sha`. */
  readonly jobSha?: string;
}

/** Overrides for one run's origin. */
export interface FixtureOrigin {
  readonly path?: string;
  readonly branch?: string | null;
  readonly headRepository?: string | null;
}

export interface FakeGitHub {
  readonly fetch: typeof fetch;
  /** Every request's path and query, in order. */
  readonly calls: string[];
}

/**
 * Serve `records` (newest first, per environment): paged deployment lists, one
 * statuses list per record, a run per `run` number, and its jobs. A run's
 * workflow is deploy.yml when it made a dev record and production-release.yml
 * otherwise, on `main` in this repository, unless `origins` says otherwise.
 * `goneRuns` answer 404, as a run past log retention does. The jobs list
 * honours `filter`: without `filter=all` it holds only the latest attempt.
 */
export function fakeGitHub(
  records: readonly FixtureRecord[],
  options: {
    readonly goneRuns?: readonly number[];
    readonly origins?: Readonly<Record<number, FixtureOrigin>>;
  } = {},
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
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? (input instanceof URL ? input.href : String(input)));
    calls.push(`${url.pathname}${url.search}`);
    const headers = new Headers(init?.headers ?? request?.headers);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`)
      return json({ message: "Bad credentials" }, 401);

    const prefix = `/repos/${REPO}`;
    if (!url.pathname.startsWith(prefix)) return json({ message: "Not Found" }, 404);
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
      const inRun = withIds.filter((r) => r.run === run);
      const latest = Math.max(1, ...inRun.map((r) => r.attempt ?? 1));
      const list = inRun
        .filter((r) => url.searchParams.get("filter") === "all" || (r.attempt ?? 1) === latest)
        .map((r) => ({
          id: r.jobId,
          name: r.job,
          head_sha: r.jobSha ?? r.sha,
          conclusion:
            r.conclusion === undefined
              ? r.states.includes("success")
                ? "success"
                : "failure"
              : r.conclusion,
        }));
      return json({
        total_count: list.length,
        jobs: list.slice((page - 1) * perPage, page * perPage),
      });
    }
    const runPath = /^\/actions\/runs\/(\d+)$/.exec(path);
    if (runPath) {
      const run = Number(runPath[1]);
      if (options.goneRuns?.includes(run)) return json({ message: "Not Found" }, 404);
      const origin = options.origins?.[run] ?? {};
      const deploysDev = withIds.some((r) => r.run === run && r.environment === "dev");
      const headRepository = origin.headRepository === undefined ? REPO : origin.headRepository;
      return json({
        id: run,
        path: origin.path ?? (deploysDev ? WORKFLOW_FILE.dev : WORKFLOW_FILE.production),
        head_branch: origin.branch === undefined ? "main" : origin.branch,
        head_repository: headRepository === null ? null : { full_name: headRepository },
        repository: { full_name: REPO },
      });
    }
    return json({ message: `unrouted ${path}` }, 500);
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

export const prod = (key: SurfaceKey): string => {
  const job = surface(key).production;
  if (!job) throw new Error(`${key} has no production job`);
  return job.name;
};

export const dev = (key: SurfaceKey): string => surface(key).dev.name;

/** The Environment a surface's production record is in: its own job's, or its stack's record job's. */
export const productionEnvironment = (key: SurfaceKey): "production" | "production-records" =>
  surface(key).production?.kind === "stack" ? "production-records" : "production";

/**
 * Added to a run number for the `production-records` records of a full
 * production run. In a release they share the stack job's run; here they get
 * a run of their own, so a test that gives a dev run and a production run
 * the same number still finds each record's run in the right workflow
 * (only production-release.yml writes `production-records`).
 */
export const RECORD_RUN_OFFSET = 500_000;

/** Every production (or dev) job of one run, all successful, each record in its own Environment. */
export function fullRun(tier: "production" | "dev", sha: string, run: number): FixtureRecord[] {
  const surfaces = tier === "production" ? PRODUCTION_SURFACES : SURFACES;
  return surfaces.map((s) => {
    const environment = tier === "production" ? productionEnvironment(s.key) : "dev";
    return {
      environment,
      sha,
      run: environment === "production-records" ? run + RECORD_RUN_OFFSET : run,
      job: tier === "production" ? prod(s.key) : dev(s.key),
      states: ["success", "in_progress", "queued", "waiting"],
    };
  });
}
