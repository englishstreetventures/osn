#!/usr/bin/env bun
/**
 * Decide what a production release ships.
 *
 * Run by the `plan` job of .github/workflows/production-release.yml. For each
 * production surface in scripts/deploy-surfaces.ts (PRODUCTION_SURFACES; a
 * surface with only a dev job never ships from here) it finds the commit
 * production last deployed, diffs that commit against the release commit, and
 * ships the surface when anything it builds from differs. The baseline is what
 * production runs, not what the previous run tried to ship, so a release that
 * was skipped, cancelled or rejected leaves nothing behind: the next one sees
 * the same gap.
 *
 * Where the baseline comes from. Every job that declares an environment
 * leaves a GitHub Deployment record for its commit, and the record gains a
 * `success` status when the job succeeds. The record does not say which
 * surface the job deployed, but its status links the job, and the job's name
 * does. So this reads the records newest first, keeps those with a `success`
 * status, and maps each job name back to a surface through the map. A
 * surface with its own job (`job`) is read from the `production` Environment;
 * a site its stack deploys (`stack`) from `production-records`, where the
 * record job after the stack job leaves it. The newest such record is what
 * production runs: every production job of one surface, and every run of one
 * stack, takes the same concurrency group without cancelling, so they run in
 * the order they were created, and a re-run makes a new record.
 *
 * A record is only a claim: anyone who can write Deployments can create one
 * and point its status at any job. So a record counts only when the job it
 * links succeeded at the record's own commit, in a run of a workflow that
 * deploys that tier (`DEPLOYING_WORKFLOWS`), on `main`, from this repository.
 *
 * Dev gates production. A changed surface ships only when a recent successful
 * dev deployment of it was built from the same content (its own paths and the
 * shared ones) as the release commit. Otherwise it is held back, and the next
 * release asks again.
 *
 * A release never rolls a surface back. When production already runs a commit
 * that contains the release commit — an older release re-run in full — the
 * surface is left alone unless the release is forced.
 *
 * A production stack deploys every site it declares at once, so it ships
 * only when one of its sites ships and none is held back or newer on
 * production; otherwise its `stack` sites wait with it, while a staged site's
 * own Pages job still ships. Asking for one of a stack's sites asks for all
 * of them.
 *
 * A flip release (FLIP names a site PRODUCTION_SITE_MODES serves from its
 * Worker) moves that site's domain and nothing else: SURFACES must name only
 * `stack` sites of the flip's stack, so no other job runs.
 *
 * Inputs, from the environment:
 *   GITHUB_TOKEN        read access to deployments and Actions runs and jobs
 *   GITHUB_REPOSITORY   owner/name
 *   GITHUB_SHA          the release commit (default: git rev-parse HEAD)
 *   GITHUB_API_URL, GITHUB_SERVER_URL   default to github.com's
 *   SURFACES            comma or space separated production surface keys;
 *                       empty = all
 *   FORCE               "true" ships the requested surfaces whatever the
 *                       diff and dev say — for a change no path rule sees
 *                       (a repo Variable, a hand-run wrangler deploy)
 *   FLIP                a site whose domain this release moves to its Worker;
 *                       empty for none
 * Writes `<key>=true|false` per surface, `stack_<stack>=true|false` per
 * production stack, `any`, `any_site` (a site build is needed), `any_stack`,
 * `stacks` (the shipping stacks, space separated) and `flip` to
 * $GITHUB_OUTPUT (stdout when unset), and a table of what ships and why to
 * $GITHUB_STEP_SUMMARY and stdout.
 *
 * Read-only against GitHub. Any API error fails the run: a planner that
 * shipped everything whenever it could not read the records would hide the
 * fault behind an approval.
 *
 * Dry run from a checkout:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=englishstreetventures/osn \
 *     bun run scripts/release-plan.ts
 */

import { appendFileSync } from "node:fs";

import type { SiteSurface } from "../shared/infra/src/production-sites";
import {
  changedFiles,
  changesContent,
  deployReason,
  isAncestor,
  type Job,
  PRODUCTION_STACKS,
  PRODUCTION_SURFACES,
  stackDeployed,
  type StackKey,
  surface,
  SURFACES,
  type Surface,
  type SurfaceKey,
  type Tier,
  WORKFLOW_FILE,
} from "./deploy-surfaces";

/**
 * Where Deployment records are read: each tier's Environment, and
 * `production-records`, which holds the records of the sites a production
 * stack deploys. It has no reviewer, so its record jobs run unapproved.
 */
export type Environment = Tier | "production-records";

// ── reading GitHub ──────────────────────────────────────────────────────────

export interface DeploymentRecord {
  readonly id: number;
  readonly sha: string;
}

export interface DeploymentStatus {
  readonly state: string;
  readonly log_url: string;
}

/** One job of a workflow run: what the planner checks a record against. */
export interface RunJob {
  readonly name: string;
  /** The commit the job ran on. */
  readonly headSha: string;
  /** `success`, `failure`, …; null while the job has not finished. */
  readonly conclusion: string | null;
}

/** Where a workflow run came from. */
export interface RunOrigin {
  /** The workflow file, as `.github/workflows/<name>.yml`. */
  readonly path: string;
  /** Empty when GitHub gives none. */
  readonly headBranch: string;
  /** owner/name of the repository the run's commit came from; empty when gone. */
  readonly headRepository: string;
  /** owner/name of the repository the run belongs to. */
  readonly repository: string;
}

/** The four REST reads the planner makes. A seam for the tests. */
export interface DeploymentReader {
  /** One page of an environment's Deployment records, newest first. */
  deployments(environment: Environment, page: number): Promise<readonly DeploymentRecord[]>;
  statuses(deploymentId: number): Promise<readonly DeploymentStatus[]>;
  /** Job id → job, for every attempt of a run; empty when the run is gone. */
  jobs(runId: number): Promise<ReadonlyMap<number, RunJob>>;
  /** Where a run came from; undefined when the run is gone. */
  origin(runId: number): Promise<RunOrigin | undefined>;
}

/**
 * The workflow files whose runs deploy each environment. Production's list
 * includes deploy.yml because its runs carried the production jobs before
 * production-release.yml did: one of their records is still what production
 * runs for a surface no release has shipped since. Only production-release.yml
 * has ever written `production-records`.
 */
export const DEPLOYING_WORKFLOWS = {
  production: [WORKFLOW_FILE.production, WORKFLOW_FILE.dev],
  "production-records": [WORKFLOW_FILE.production],
  dev: [WORKFLOW_FILE.dev],
} as const satisfies Record<Environment, readonly string[]>;

/** Whether a run is one that deploys `environment`: the workflow for it, on main, in this repository. */
export function deploysTier(origin: RunOrigin | undefined, environment: Environment): boolean {
  return (
    origin !== undefined &&
    DEPLOYING_WORKFLOWS[environment].some((path) => path === origin.path) &&
    origin.headBranch === "main" &&
    origin.repository !== "" &&
    origin.headRepository === origin.repository
  );
}

/** Records per page — the REST maximum. */
export const PAGE_SIZE = 100;

/**
 * Records one walk reads at most, per Environment. 300 on every one: a walk
 * of 1000 could spend the job token's hourly request budget in one run when
 * a surface has no record in the window, and a surface whose last record
 * falls out of it ships again (production) or is held back until dev deploys
 * it again (dev).
 */
export const MAX_RECORDS = 300;

function listOf(payload: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(payload)) throw new TypeError(`GitHub API: expected a list of ${what}`);
  return payload;
}

function parseDeployment(item: unknown): DeploymentRecord {
  const record = item as { id?: unknown; sha?: unknown } | null;
  if (typeof record?.id !== "number" || typeof record.sha !== "string") {
    throw new TypeError("GitHub API: a deployment has no numeric `id` or string `sha`");
  }
  return { id: record.id, sha: record.sha };
}

function parseStatus(item: unknown): DeploymentStatus {
  const status = item as { state?: unknown; log_url?: unknown } | null;
  if (typeof status?.state !== "string")
    throw new TypeError("GitHub API: a deployment status has no `state`");
  return { state: status.state, log_url: typeof status.log_url === "string" ? status.log_url : "" };
}

function parseJobs(payload: unknown): readonly (RunJob & { readonly id: number })[] {
  const body = payload as { jobs?: unknown } | null;
  return listOf(body?.jobs, "jobs").map((item) => {
    const job = item as {
      id?: unknown;
      name?: unknown;
      head_sha?: unknown;
      conclusion?: unknown;
    } | null;
    if (
      typeof job?.id !== "number" ||
      typeof job.name !== "string" ||
      typeof job.head_sha !== "string"
    ) {
      throw new TypeError("GitHub API: a job has no numeric `id`, string `name` or `head_sha`");
    }
    return {
      id: job.id,
      name: job.name,
      headSha: job.head_sha,
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
    };
  });
}

function fullName(value: unknown): string {
  const repository = value as { full_name?: unknown } | null;
  return typeof repository?.full_name === "string" ? repository.full_name : "";
}

function parseOrigin(payload: unknown): RunOrigin {
  const run = payload as {
    path?: unknown;
    head_branch?: unknown;
    head_repository?: unknown;
    repository?: unknown;
  } | null;
  if (typeof run?.path !== "string") throw new TypeError("GitHub API: a run has no `path`");
  return {
    path: run.path,
    headBranch: typeof run.head_branch === "string" ? run.head_branch : "",
    headRepository: fullName(run.head_repository),
    repository: fullName(run.repository),
  };
}

export function restReader(options: {
  readonly fetch: typeof fetch;
  readonly token: string;
  readonly repository: string;
  readonly apiUrl: string;
}): DeploymentReader {
  /** The response, or undefined for a 404 the caller allows. Throws on any other error. */
  async function request(path: string, notFound?: "allow"): Promise<Response | undefined> {
    const response = await options.fetch(`${options.apiUrl}/repos/${options.repository}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (notFound === "allow" && response.status === 404) return undefined;
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`GitHub API answered ${response.status} for ${path}: ${body}`);
    }
    return response;
  }

  async function required(path: string): Promise<Response> {
    const response = await request(path);
    if (response === undefined) throw new Error(`GitHub API answered nothing for ${path}`);
    return response;
  }

  return {
    async deployments(environment, page) {
      const query = `environment=${encodeURIComponent(environment)}&per_page=${PAGE_SIZE}&page=${page}`;
      const response = await required(`/deployments?${query}`);
      return listOf(await response.json(), "deployments").map(parseDeployment);
    },

    async statuses(deploymentId) {
      const response = await required(
        `/deployments/${deploymentId}/statuses?per_page=${PAGE_SIZE}`,
      );
      return listOf(await response.json(), "deployment statuses").map(parseStatus);
    },

    async jobs(runId) {
      const jobs = new Map<number, RunJob>();
      // `filter=all`: the default lists only the latest attempt's jobs, and a
      // record made by an earlier attempt links one of those. One page at a
      // time, each depending on the last one's length.
      const readFrom = async (page: number): Promise<ReadonlyMap<number, RunJob>> => {
        const response = await request(
          `/actions/runs/${runId}/jobs?filter=all&per_page=${PAGE_SIZE}&page=${page}`,
          "allow",
        );
        if (response === undefined) return jobs;
        const listed = parseJobs(await response.json());
        for (const { id, ...job } of listed) jobs.set(id, job);
        return listed.length < PAGE_SIZE ? jobs : readFrom(page + 1);
      };
      return readFrom(1);
    },

    async origin(runId) {
      const response = await request(`/actions/runs/${runId}`, "allow");
      return response === undefined ? undefined : parseOrigin(await response.json());
    },
  };
}

const JOB_LINK = /\/actions\/runs\/(\d+)\/job\/(\d+)/;

export interface DeployedCommits {
  /** Per surface, the commit of its newest trusted successful record. */
  readonly newest: ReadonlyMap<SurfaceKey, string>;
  /** Per surface, the commit of its newest trusted successful record that `accept` took. */
  readonly accepted: ReadonlyMap<SurfaceKey, string>;
}

/** The job whose Deployment records in `environment` say what `s` runs there. */
function recordJob(s: Surface, environment: Environment): Job | undefined {
  if (environment === "dev") return s.dev;
  const kind = environment === "production" ? "job" : "stack";
  return s.production?.kind === kind ? s.production : undefined;
}

/**
 * Walk `environment`'s Deployment records newest first, reading only those
 * with a `success` status that a wanted surface's job made, in a run that
 * deploys `environment` (`deploysTier`), at the commit the job ran on. Stops
 * once `accept` has taken a record for every wanted surface, or after
 * `maxRecords` records. Statuses are read `batch` records at a time, and the
 * jobs and origins of the runs in a batch together, each run once. Without
 * `accept`, the first such record per surface is taken.
 *
 * With `accept`, a record is skipped before its statuses are read once every
 * surface still open has a newest record and `accept` refuses the record's
 * commit for all of them: reading it could change neither answer. That keeps a
 * walk that finds no acceptable record — the dev gate holding a surface back —
 * from spending a status read on every record up to `maxRecords`.
 */
export async function findDeployed(
  reader: DeploymentReader,
  environment: Environment,
  wanted: readonly SurfaceKey[],
  options: {
    readonly accept?: (key: SurfaceKey, sha: string) => boolean;
    readonly maxRecords?: number;
    readonly batch?: number;
  } = {},
): Promise<DeployedCommits> {
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  const batch = options.batch ?? 10;
  const { accept } = options;
  const newest = new Map<SurfaceKey, string>();
  const accepted = new Map<SurfaceKey, string>();
  const want = new Set(wanted);
  if (want.size === 0) return { newest, accepted };

  const surfaceByJob = new Map<string, SurfaceKey>();
  for (const s of SURFACES) {
    const job = recordJob(s, environment);
    if (job !== undefined) surfaceByJob.set(job.name, s.key);
  }
  const jobsByRun = new Map<number, ReadonlyMap<number, RunJob>>();
  const origins = new Map<number, RunOrigin | undefined>();

  /** Read what `cache` lacks for `runIds`, all at once. */
  const fill = async <T>(
    cache: Map<number, T>,
    runIds: readonly number[],
    read: (runId: number) => Promise<T>,
  ): Promise<void> => {
    const unread = [...new Set(runIds)].filter((runId) => !cache.has(runId));
    const results = await Promise.all(unread.map(read));
    for (const [index, runId] of unread.entries()) cache.set(runId, results[index] as T);
  };

  const worthReading = (record: DeploymentRecord): boolean => {
    if (accept === undefined) return true;
    const open = [...want].filter((key) => !accepted.has(key));
    return open.some((key) => !newest.has(key) || accept(key, record.sha));
  };

  /** Read one batch; true once every wanted surface has an accepted record. */
  const readBatch = async (records: readonly DeploymentRecord[]): Promise<boolean> => {
    const read = records.filter(worthReading);
    const statuses = await Promise.all(read.map((record) => reader.statuses(record.id)));
    const links = read.flatMap((record, index) => {
      const success = statuses[index]?.find((status) => status.state === "success");
      const link = success === undefined ? null : JOB_LINK.exec(success.log_url);
      return link === null
        ? []
        : [{ sha: record.sha, runId: Number(link[1]), jobId: Number(link[2]) }];
    });
    await fill(
      jobsByRun,
      links.map((link) => link.runId),
      (runId) => reader.jobs(runId),
    );

    const candidates = links.flatMap((link) => {
      const job = jobsByRun.get(link.runId)?.get(link.jobId);
      const key = job === undefined ? undefined : surfaceByJob.get(job.name);
      if (key === undefined || !want.has(key) || accepted.has(key)) return [];
      if (job?.conclusion !== "success" || job.headSha !== link.sha) return [];
      return [{ ...link, key }];
    });
    await fill(
      origins,
      candidates.map((candidate) => candidate.runId),
      (runId) => reader.origin(runId),
    );

    for (const { key, sha, runId } of candidates) {
      if (accepted.has(key) || !deploysTier(origins.get(runId), environment)) continue;
      if (!newest.has(key)) newest.set(key, sha);
      if (accept !== undefined && !accept(key, sha)) continue;
      accepted.set(key, sha);
      if (accepted.size === want.size) return true;
    }
    return false;
  };

  /** Read pages until done; recursion keeps each page's read after the last. */
  const readFrom = async (page: number, scanned: number): Promise<void> => {
    if (scanned >= maxRecords) return;
    const records = (await reader.deployments(environment, page)).slice(0, maxRecords - scanned);
    const readBatches = async (start: number): Promise<boolean> =>
      start >= records.length
        ? false
        : (await readBatch(records.slice(start, start + batch))) || readBatches(start + batch);
    if (await readBatches(0)) return;
    if (records.length === PAGE_SIZE) await readFrom(page + 1, scanned + records.length);
  };

  await readFrom(1, 0);
  return { newest, accepted };
}

/**
 * The commit each wanted surface last deployed successfully on `tier`: its
 * newest successful record. On production a `job` surface's record is in the
 * `production` Environment and a `stack` surface's in `production-records`.
 * A surface missing from the answer has no such record among the newest
 * `maxRecords` of its Environment.
 */
export async function lastDeployed(
  reader: DeploymentReader,
  tier: Tier,
  wanted: readonly SurfaceKey[],
  options: { readonly maxRecords?: number; readonly batch?: number } = {},
): Promise<Map<SurfaceKey, string>> {
  if (tier === "dev") return new Map((await findDeployed(reader, "dev", wanted, options)).accepted);
  const ofKind = (kind: "job" | "stack") =>
    wanted.filter((key) => surface(key).production?.kind === kind);
  const own = await findDeployed(reader, "production", ofKind("job"), options);
  const stacked = await findDeployed(reader, "production-records", ofKind("stack"), options);
  return new Map([...own.accepted, ...stacked.accepted]);
}

// ── deciding ────────────────────────────────────────────────────────────────

export interface ReleaseRequest {
  readonly surfaces: readonly SurfaceKey[];
  readonly force: boolean;
  /** The site whose domain this release moves to its Worker, when one does. */
  readonly flip?: SiteSurface;
}

/** The sites a production stack deploys, `job` and `stack` kind both, in map order. */
const stackSites = (key: StackKey): readonly SurfaceKey[] =>
  PRODUCTION_SURFACES.filter((s) => s.stack === key && stackDeployed(s)).map((s) => s.key);

/** The flip a release asks for, checked against SURFACES. Throws on a bad value. */
function parseFlip(flip: string, names: readonly string[]): SiteSurface {
  const target = PRODUCTION_SURFACES.find((s) => s.key === flip);
  if (target?.production.kind !== "stack" || !stackDeployed(target)) {
    const sites = PRODUCTION_SURFACES.filter((s) => s.production.kind === "stack").map(
      (s) => s.key,
    );
    throw new Error(
      `FLIP names ${flip}, which is not a site PRODUCTION_SITE_MODES serves from its Worker. Use one of: ${sites.join(", ") || "none"}`,
    );
  }
  if (names.length === 0) {
    throw new Error(
      `A flip release ships the ${target.stack} stack alone: set SURFACES to ${flip}, so no other job runs.`,
    );
  }
  const others = names.filter((name) => {
    const s = PRODUCTION_SURFACES.find((candidate) => candidate.key === name);
    return s?.stack !== target.stack || s.production.kind !== "stack";
  });
  if (others.length > 0) {
    throw new Error(
      `A flip release ships the ${target.stack} stack alone, and SURFACES also names ${others.join(", ")}. Release those first, then flip with SURFACES set to ${flip}.`,
    );
  }
  return target.key as SiteSurface;
}

/**
 * The dispatch inputs, as the workflow passes them. Throws on a bad value.
 * Naming a site a production stack deploys asks for every site that stack
 * deploys, since the stack deploys them together; a flip release asks for
 * its own sites alone.
 */
export function parseRequest(
  surfaces: string | undefined,
  force: string | undefined,
  flip?: string,
): ReleaseRequest {
  const names = (surfaces ?? "").split(/[\s,]+/).filter((name) => name !== "");
  const keys = PRODUCTION_SURFACES.map((s) => s.key);
  const unknown = names.filter((name) => !keys.some((key) => key === name));
  if (unknown.length > 0) {
    throw new Error(
      `SURFACES names ${unknown.join(", ")}, which is not a production surface. Use any of: ${keys.join(", ")}`,
    );
  }
  const flag = force ?? "";
  if (flag !== "" && flag !== "true" && flag !== "false") {
    throw new Error(`FORCE must be true or false, not '${flag}'`);
  }
  const requested = [...new Set(names)] as SurfaceKey[];
  if (flip !== undefined && flip !== "") {
    return { surfaces: requested, force: flag === "true", flip: parseFlip(flip, requested) };
  }
  const expanded = new Set(
    requested.flatMap((key) =>
      stackDeployed(surface(key)) ? stackSites(surface(key).stack) : [key],
    ),
  );
  return {
    surfaces: requested.length > 0 ? keys.filter((key) => expanded.has(key)) : keys,
    force: flag === "true",
  };
}

export type PlanStatus =
  | "ships"
  | "unchanged"
  | "production is newer"
  | "held back"
  | "not requested";

export interface PlanDecision {
  readonly key: SurfaceKey;
  readonly ship: boolean;
  readonly status: PlanStatus;
  /** The commit production last deployed for this surface, when one was found. */
  readonly production?: string;
  readonly reason: string;
}

/** Files that differ between `from` and the release commit; undefined when git cannot say. */
export type Diff = (from: string) => readonly string[] | undefined;

const short = (sha: string) => sha.slice(0, 7);

/**
 * Which surfaces differ from what production runs. A surface whose production
 * commit descends from the release commit is left alone: shipping it would
 * roll production back, which only a forced release does. That is the case
 * when an older release is re-run in full.
 */
export function changedSurfaces(input: {
  readonly head: string;
  readonly request: ReleaseRequest;
  readonly production: ReadonlyMap<SurfaceKey, string>;
  readonly diff: Diff;
  /** Whether `production` descends from the release commit. */
  readonly productionIsNewer: (production: string) => boolean;
}): PlanDecision[] {
  return PRODUCTION_SURFACES.map((s): PlanDecision => {
    const production = input.production.get(s.key);
    const decision = (ship: boolean, status: PlanStatus, reason: string): PlanDecision =>
      production === undefined
        ? { key: s.key, ship, status, reason }
        : { key: s.key, ship, status, production, reason };

    if (!input.request.surfaces.includes(s.key))
      return decision(false, "not requested", "left out of SURFACES");
    if (input.request.force) return decision(true, "ships", "forced by the FORCE input");
    if (production === undefined) {
      return decision(
        true,
        "ships",
        "no successful production deployment found in the recent records",
      );
    }
    if (production === input.head)
      return decision(false, "unchanged", `production already runs ${short(production)}`);
    if (input.productionIsNewer(production)) {
      return decision(
        false,
        "production is newer",
        `production runs ${short(production)}, which already contains this commit; only a forced release rolls back`,
      );
    }
    const files = input.diff(production);
    if (files === undefined) {
      return decision(
        true,
        "ships",
        `cannot compare production's ${short(production)} with this commit`,
      );
    }
    const reason = deployReason(s, files, "production");
    return reason === undefined
      ? decision(false, "unchanged", `nothing it builds from changed since ${short(production)}`)
      : decision(true, "ships", reason);
  });
}

/** The surfaces whose dev deployments the gate has to read. */
export function devGateWanted(decisions: readonly PlanDecision[], force: boolean): SurfaceKey[] {
  if (force) return [];
  return decisions.filter((d) => d.ship).map((d) => d.key);
}

/**
 * Whether a commit whose files differ from the release commit's by `files`
 * builds `target` from the same content: none of its own paths and none of the
 * shared ones differ. False when git could not compare them.
 */
export function sameContent(target: Surface, files: readonly string[] | undefined): boolean {
  return files !== undefined && !files.some((file) => changesContent(target, file));
}

/**
 * Hold back a shipping surface that dev has not deployed from the same
 * content. `dev.accepted` holds, per surface, a successful dev deployment built
 * from the release commit's content — any one, not only the newest, since dev
 * moves on while a release waits. A forced release passes untouched.
 */
export function applyDevGate(input: {
  readonly decisions: readonly PlanDecision[];
  readonly dev: DeployedCommits;
  readonly diff: Diff;
  readonly force: boolean;
}): PlanDecision[] {
  return input.decisions.map((d): PlanDecision => {
    const target = surface(d.key);
    if (input.force || !d.ship) return d;
    const match = input.dev.accepted.get(d.key);
    if (match !== undefined)
      return { ...d, reason: `${d.reason}; dev ran this content at ${short(match)}` };
    const hold = (reason: string): PlanDecision => ({
      ...d,
      ship: false,
      status: "held back",
      reason: `${reason}; it ships once dev has deployed it — re-run the failed dev job or dispatch Deploy`,
    });
    const newest = input.dev.newest.get(d.key);
    if (newest === undefined)
      return hold("no successful dev deployment found in the recent records");
    const differs = input.diff(newest)?.find((file) => changesContent(target, file));
    return hold(
      differs === undefined
        ? `no recent dev deployment was built from this content (dev's newest is ${short(newest)})`
        : `no recent dev deployment was built from this content; dev's newest, ${short(newest)}, differs in ${differs}`,
    );
  });
}

export interface StackPlan {
  readonly key: StackKey;
  readonly ship: boolean;
  readonly reason: string;
}

/** What a release does: each surface's decision, each production stack's, and its flip. */
export interface ReleaseDecisions {
  readonly decisions: readonly PlanDecision[];
  readonly stacks: readonly StackPlan[];
  readonly flip?: SiteSurface;
}

/**
 * Which production stacks ship. A stack deploys every site it declares, so
 * it ships when one of them ships and none is held back or newer on
 * production (unless forced). A stack that waits holds its `stack` sites
 * back with it; a staged site's own Pages job ships regardless.
 */
export function stackPlans(decisions: readonly PlanDecision[], force: boolean): ReleaseDecisions {
  const held = new Map<SurfaceKey, string>();
  const stacks = PRODUCTION_STACKS.map((s): StackPlan => {
    const sites = decisions.filter((d) => stackSites(s.key).includes(d.key));
    const shipping = sites.filter((d) => d.ship);
    if (shipping.length === 0)
      return { key: s.key, ship: false, reason: "none of its sites ships" };
    const blocking = force
      ? []
      : sites.filter((d) => d.status === "held back" || d.status === "production is newer");
    if (blocking.length === 0) {
      return {
        key: s.key,
        ship: true,
        reason: `${shipping.map((d) => d.key).join(", ")} ${shipping.length === 1 ? "ships" : "ship"}`,
      };
    }
    const why = `${blocking.map((d) => `${d.key} is ${d.status}`).join(", ")}`;
    for (const d of shipping) {
      if (surface(d.key).production?.kind === "stack") held.set(d.key, why);
    }
    return { key: s.key, ship: false, reason: `it deploys every site at once, and ${why}` };
  });
  return {
    decisions: decisions.map((d): PlanDecision => {
      const why = held.get(d.key);
      return why === undefined
        ? d
        : {
            ...d,
            ship: false,
            status: "held back",
            reason: `${d.reason}; its stack waits, since ${why}`,
          };
    }),
    stacks,
  };
}

/**
 * `<key>=true|false` per surface, `stack_<stack>=true|false` per production
 * stack, then `any`, `any_site`, `any_stack`, `stacks` and `flip`, as
 * $GITHUB_OUTPUT takes them. `any_site` says a site build is needed: a stack
 * ships, or a staged site's own Pages job does.
 */
export function outputLines(release: ReleaseDecisions): string {
  const ships = new Set(release.decisions.filter((d) => d.ship).map((d) => d.key));
  const stacks = release.stacks.filter((s) => s.ship).map((s) => s.key);
  const pagesSite = PRODUCTION_SURFACES.some(
    (s) => ships.has(s.key) && stackDeployed(s) && s.production.kind === "job",
  );
  return [
    ...PRODUCTION_SURFACES.map((s) => `${s.key}=${ships.has(s.key)}`),
    ...PRODUCTION_STACKS.map((s) => `stack_${s.key}=${stacks.includes(s.key)}`),
    `any=${ships.size > 0 || stacks.length > 0}`,
    `any_site=${stacks.length > 0 || pagesSite}`,
    `any_stack=${stacks.length > 0}`,
    `stacks=${stacks.join(" ")}`,
    `flip=${release.flip ?? ""}`,
    "",
  ].join("\n");
}

/**
 * Whether cire-api ships while the organiser portal is also behind. When a
 * change alters the contract between them, the portal has to go first
 * (wiki/shared/production-deploy.md §5.6), and one approval cannot order two
 * jobs — so the approver is told to check.
 */
export function apiAheadOfHost(decisions: readonly PlanDecision[]): boolean {
  const api = decisions.find((d) => d.key === "cire_api");
  const host = decisions.find((d) => d.key === "cire_host");
  return api?.ship === true && (host?.status === "ships" || host?.status === "held back");
}

/** The table the approver reads on the run page before approving. */
export function renderSummary(
  release: ReleaseDecisions,
  context: { readonly head: string; readonly repository: string; readonly serverUrl: string },
): string {
  const { decisions } = release;
  const repo = `${context.serverUrl}/${context.repository}`;
  const rows = decisions.map((d) => {
    const production =
      d.production === undefined
        ? "—"
        : `[\`${short(d.production)}\`](${repo}/commit/${d.production}) ([diff](${repo}/compare/${d.production}...${context.head}))`;
    return `| \`${d.key}\` | ${production} | ${d.status} | ${d.reason} |`;
  });
  const shipping = decisions.filter((d) => d.ship).map((d) => `\`${d.key}\``);
  const stacks = release.stacks.filter((s) => s.ship).map((s) => `the ${s.key} stack`);
  const stackRows = release.stacks.map(
    (s) => `| ${s.key} stack | — | ${s.ship ? "ships" : "waits"} | ${s.reason} |`,
  );
  const flip =
    release.flip === undefined
      ? []
      : [
          `> [!IMPORTANT]`,
          `> Flip release: \`${release.flip}\`'s domain moves from its Pages project to its Worker, at low traffic.`,
          "> Four approvals, one per job: the Alchemy plan, the verify job, the detach, then the deploy. The site is down from the detach until the deploy attaches its domain, so approve the deploy at once.",
          "",
        ];
  const approvals =
    stacks.length === 0
      ? "Wait until every one of those jobs shows Waiting, then one approval releases them all."
      : "First approve the Alchemy plan job and read its plan; then every other job reaches the gate together, and one second approval releases them all.";
  const warning = apiAheadOfHost(decisions)
    ? [
        "> [!WARNING]",
        "> `cire_api` ships while `cire_host` is also behind. If this release changes the contract between",
        "> them (the plan tiers), reject it and release `cire_host` first: runbook §5.6.",
        "",
      ]
    : [];
  return [
    `### Production release of [\`${short(context.head)}\`](${repo}/commit/${context.head})`,
    "",
    shipping.length === 0 && stacks.length === 0
      ? "Nothing to ship: production already runs everything this commit would deploy."
      : `Ships ${[...shipping, ...stacks].join(", ")}. ${approvals}`,
    "",
    ...flip,
    ...warning,
    "| Surface | Production runs | This release | Why |",
    "|---|---|---|---|",
    ...rows,
    ...stackRows,
    "",
  ].join("\n");
}

// ── the plan job ────────────────────────────────────────────────────────────

export interface ReleasePlan extends ReleaseDecisions {
  readonly outputs: string;
  readonly summary: string;
}

function revParse(cwd: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error("GITHUB_SHA is unset and git rev-parse HEAD failed");
  return proc.stdout.toString().trim();
}

export async function runReleasePlan(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly cwd: string;
}): Promise<ReleasePlan> {
  const { env } = options;
  const token = env.GITHUB_TOKEN ?? "";
  if (token === "") throw new Error("GITHUB_TOKEN is not set; the plan job passes github.token");
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.endsWith("/..")) {
    throw new Error(`GITHUB_REPOSITORY must be owner/name, not '${repository}'`);
  }
  const head = env.GITHUB_SHA || revParse(options.cwd);
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error(`the release commit must be a full SHA, not '${head}'`);
  const request = parseRequest(env.SURFACES, env.FORCE, env.FLIP);
  const reader = restReader({
    fetch: options.fetch,
    token,
    repository,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  });
  const diffs = new Map<string, readonly string[] | undefined>();
  const diff: Diff = (from) => {
    if (!diffs.has(from)) diffs.set(from, changedFiles(from, head, options.cwd));
    return diffs.get(from);
  };

  const newer = new Map<string, boolean>();
  const productionIsNewer = (commit: string): boolean => {
    if (!newer.has(commit)) newer.set(commit, isAncestor(head, commit, options.cwd));
    return newer.get(commit) === true;
  };

  const production = await lastDeployed(reader, "production", request.surfaces);
  const changed = changedSurfaces({ head, request, production, diff, productionIsNewer });
  const dev = await findDeployed(reader, "dev", devGateWanted(changed, request.force), {
    accept: (key, commit) => sameContent(surface(key), diff(commit)),
  });
  const gated = applyDevGate({ decisions: changed, dev, diff, force: request.force });
  const { decisions, stacks } = stackPlans(gated, request.force);
  const release: ReleaseDecisions =
    request.flip === undefined ? { decisions, stacks } : { decisions, stacks, flip: request.flip };

  return {
    ...release,
    outputs: outputLines(release),
    summary: renderSummary(release, {
      head,
      repository,
      serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
    }),
  };
}

if (import.meta.main) {
  try {
    const plan = await runReleasePlan({ env: process.env, fetch, cwd: process.cwd() });
    process.stdout.write(`${plan.summary}\n`);
    const output = process.env.GITHUB_OUTPUT;
    if (output !== undefined && output !== "") appendFileSync(output, plan.outputs);
    else process.stdout.write(plan.outputs);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined && summary !== "") appendFileSync(summary, `${plan.summary}\n`);
  } catch (error) {
    process.stderr.write(
      `::error::release-plan: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
