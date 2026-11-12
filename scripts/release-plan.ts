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
 * surface's record is read from `production-records`, where the record job
 * after its stack's job leaves it, and a stack's own from the `production`
 * Environment. The newest such record is what production runs: every run of
 * one stack takes the same concurrency group without cancelling, so they run
 * in the order they were created, and a re-run makes a new record.
 *
 * A record is only a claim: anyone who can write Deployments can create one
 * and point its status at any job. So a record counts only when the job it
 * links succeeded at the record's own commit, in a run of a workflow that
 * deploys that tier (`DEPLOYING_WORKFLOWS`), on `main`, from this repository.
 * A dev stack job's record counts only when its deploy step succeeded too: a
 * stack job that finds its commit older than one its stack already passed on
 * dev succeeds without deploying (scripts/dev-deploy-order.ts). And a dev
 * record counts only at a commit on main (an ancestor of `origin/main`, or of
 * the release commit in a checkout without it): GitHub reports a run from a
 * tag as on a branch of the tag's name.
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
 * A production stack deploys every surface it declares at once, its API
 * Workers and its sites, so it ships when one of its surfaces ships, or when
 * its own paths (its `infra/` directory and shared/infra/) changed since the
 * commit its stack job last deployed — the newest successful record of that
 * job in `production` — and dev has run its stack job at the same paths; and
 * only when none of its surfaces, nor that change, is held back or newer on
 * production. Otherwise its surfaces wait with it. Only a stack one of whose
 * surfaces the request names is asked about. Asking for one of a stack's
 * surfaces asks for all of them.
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
 *                       (a repo Variable, a rollback made by hand);
 *                       SHIPS_AFTER still holds
 * Writes `<key>=true|false` per surface, `stack_<stack>=true|false` per
 * production stack, `any` and `any_stack` (a site build is needed) to
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

import {
  changedFiles,
  changesContent,
  deployReason,
  isAncestor,
  type Job,
  PRODUCTION_STACKS,
  PRODUCTION_SURFACES,
  stack,
  stackDeployed,
  type StackKey,
  STACKS,
  surface,
  SURFACES,
  type Surface,
  type SurfaceKey,
  type Tier,
  WORKFLOW_FILE,
} from "./deploy-surfaces";

/**
 * Where Deployment records are read: each tier's Environment, and
 * `production-records`, which holds the records of the surfaces a production
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

/** One step of a job, as the jobs API reports it. */
export interface JobStep {
  readonly name: string;
  /** `success`, `skipped`, …; null while the step has not finished. */
  readonly conclusion: string | null;
}

/** One job of a workflow run: what the planner checks a record against. */
export interface RunJob {
  readonly name: string;
  /** The commit the job ran on. */
  readonly headSha: string;
  /** `success`, `failure`, …; null while the job has not finished. */
  readonly conclusion: string | null;
  /** In order; empty while the job is queued. */
  readonly steps: readonly JobStep[];
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
 * The workflow files whose runs deploy each environment. On production only
 * production-release.yml's do: `production` holds its stack jobs' records and
 * `production-records` its record jobs'.
 */
export const DEPLOYING_WORKFLOWS = {
  production: [WORKFLOW_FILE.production],
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

/** A job's steps; GitHub lists none, or `null`, for a job still queued. */
function parseSteps(value: unknown): readonly JobStep[] {
  if (value === undefined || value === null) return [];
  return listOf(value, "job steps").map((item) => {
    const step = item as { name?: unknown; conclusion?: unknown } | null;
    if (typeof step?.name !== "string") throw new TypeError("GitHub API: a job step has no `name`");
    return {
      name: step.name,
      conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
    };
  });
}

function parseJobs(payload: unknown): readonly (RunJob & { readonly id: number })[] {
  const body = payload as { jobs?: unknown } | null;
  return listOf(body?.jobs, "jobs").map((item) => {
    const job = item as {
      id?: unknown;
      name?: unknown;
      head_sha?: unknown;
      conclusion?: unknown;
      steps?: unknown;
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
      steps: parseSteps(job.steps),
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

/**
 * The step of a dev stack job in deploy.yml that runs Alchemy's deploy, by the
 * name the jobs API reports. scripts/tests/deploy-workflows.test.ts holds the
 * workflow to it.
 */
export const devDeployStep = (key: StackKey): string => `Deploy the ${key} stack`;

const JOB_LINK = /\/actions\/runs\/(\d+)\/job\/(\d+)/;

/** A production stack's own record: the newest successful run of its stack job. */
export type StackRecordKey = `stack_${StackKey}`;

/** What a Deployment record can say a tier runs: a surface, or a stack as a whole. */
export type RecordKey = SurfaceKey | StackRecordKey;

export const stackRecordKey = (key: StackKey): StackRecordKey => `stack_${key}`;

const isStackRecordKey = (key: RecordKey): key is StackRecordKey => key.startsWith("stack_");

const stackOfRecord = (key: StackRecordKey): StackKey => key.slice("stack_".length) as StackKey;

export interface DeployedCommits {
  /** Per key, the commit of its newest trusted successful record. */
  readonly newest: ReadonlyMap<RecordKey, string>;
  /** Per key, the commit of its newest trusted successful record that `accept` took. */
  readonly accepted: ReadonlyMap<RecordKey, string>;
}

/**
 * The job whose Deployment records in `environment` say what `s` runs there:
 * its dev record job in `dev`, its production record job in
 * `production-records`, and none in `production`, which holds the stacks'
 * own records alone.
 */
function recordJob(s: Surface, environment: Environment): Job | undefined {
  if (environment === "dev") return s.dev;
  return environment === "production-records" ? s.production : undefined;
}

/**
 * Each job whose records in `environment` the planner reads, by name: every
 * surface's record job, and each stack's job — in `production` its
 * production job, whose success means the stack deployed and every surface
 * it serves passed its check, and in `dev` its dev job, which passes the same
 * way once its deploy step ran (`ranItsDeploy`).
 */
function recordJobs(environment: Environment): ReadonlyMap<string, RecordKey> {
  const byName = new Map<string, RecordKey>();
  for (const s of SURFACES) {
    const job = recordJob(s, environment);
    if (job !== undefined) byName.set(job.name, s.key);
  }
  if (environment === "production") {
    for (const s of PRODUCTION_STACKS) byName.set(s.production.name, stackRecordKey(s.key));
  }
  if (environment === "dev") {
    for (const s of STACKS) byName.set(s.job.name, stackRecordKey(s.key));
  }
  return byName;
}

/**
 * Whether a job did what its record claims. A dev stack job can succeed
 * without deploying — scripts/dev-deploy-order.ts refuses a commit older than
 * one its stack already passed on dev — so its record counts only when its
 * deploy step succeeded. Every other job's success is its claim.
 */
function ranItsDeploy(job: RunJob, key: RecordKey, environment: Environment): boolean {
  if (environment !== "dev" || !isStackRecordKey(key)) return true;
  const step = devDeployStep(stackOfRecord(key));
  return job.steps.some((s) => s.name === step && s.conclusion === "success");
}

/**
 * Walk `environment`'s Deployment records newest first, reading only those
 * with a `success` status that a wanted key's job made (`recordJobs`), in a
 * run that deploys `environment` (`deploysTier`), at the commit the job ran
 * on (`ranItsDeploy` too). Stops once `enough` says the records taken are
 * enough — by default, once `accept` has taken one for every wanted key — or
 * after `maxRecords` records. Statuses are read `batch` records at a time, and
 * the jobs and origins of the runs in a batch together, each run once. Without
 * `accept`, the first such record per key is taken.
 *
 * With `only`, a record whose commit it refuses is passed over before its
 * statuses are read: the caller wants no record at that commit.
 *
 * With `accept`, a record is skipped before its statuses are read once every
 * key still open has a newest record and `accept` refuses the record's
 * commit for all of them: reading it could change neither answer. That keeps a
 * walk that finds no acceptable record — the dev gate holding a surface back —
 * from spending a status read on every record up to `maxRecords`.
 */
export async function findDeployed(
  reader: DeploymentReader,
  environment: Environment,
  wanted: readonly RecordKey[],
  options: {
    readonly accept?: (key: RecordKey, sha: string) => boolean;
    readonly only?: (sha: string) => boolean;
    readonly enough?: (accepted: ReadonlyMap<RecordKey, string>) => boolean;
    readonly maxRecords?: number;
    readonly batch?: number;
  } = {},
): Promise<DeployedCommits> {
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  const batch = options.batch ?? 10;
  const { accept, only } = options;
  const newest = new Map<RecordKey, string>();
  const accepted = new Map<RecordKey, string>();
  const want = new Set(wanted);
  if (want.size === 0) return { newest, accepted };
  const enough = options.enough ?? (() => accepted.size === want.size);

  const surfaceByJob = recordJobs(environment);
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
    if (only !== undefined && !only(record.sha)) return false;
    if (accept === undefined) return true;
    const open = [...want].filter((key) => !accepted.has(key));
    return open.some((key) => !newest.has(key) || accept(key, record.sha));
  };

  /** Read one batch; true once the accepted records are `enough`. */
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
      if (!ranItsDeploy(job, key, environment)) return [];
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
      if (enough(accepted)) return true;
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
 * The commit each wanted key last deployed successfully on `tier`: its
 * newest successful record. On production a stack's own record is in the
 * `production` Environment and a surface's in `production-records`; the two
 * Environments are walked at once. A key missing from the answer has no such
 * record among the newest `maxRecords` of its Environment.
 */
export async function lastDeployed(
  reader: DeploymentReader,
  tier: Tier,
  wanted: readonly RecordKey[],
  options: { readonly maxRecords?: number; readonly batch?: number } = {},
): Promise<Map<RecordKey, string>> {
  if (tier === "dev") return new Map((await findDeployed(reader, "dev", wanted, options)).accepted);
  const [own, recorded] = await Promise.all([
    findDeployed(reader, "production", wanted.filter(isStackRecordKey), options),
    findDeployed(
      reader,
      "production-records",
      wanted.filter((key) => !isStackRecordKey(key)),
      options,
    ),
  ]);
  return new Map([...own.accepted, ...recorded.accepted]);
}

// ── deciding ────────────────────────────────────────────────────────────────

export interface ReleaseRequest {
  readonly surfaces: readonly SurfaceKey[];
  readonly force: boolean;
}

/** The surfaces a production stack deploys, API Workers and sites, in map order. */
const stackSites = (key: StackKey): readonly SurfaceKey[] =>
  PRODUCTION_SURFACES.filter((s) => s.stack === key && stackDeployed(s)).map((s) => s.key);

/** The production stacks a request asks for: those one of whose sites it names. */
export function requestedStacks(surfaces: readonly SurfaceKey[]): StackKey[] {
  return PRODUCTION_STACKS.filter((s) =>
    stackSites(s.key).some((key) => surfaces.includes(key)),
  ).map((s) => s.key);
}

/**
 * The dispatch inputs, as the workflow passes them. Throws on a bad value.
 * Naming a site a production stack deploys asks for every site that stack
 * deploys, since the stack deploys them together.
 */
export function parseRequest(
  surfaces: string | undefined,
  force: string | undefined,
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
  const expanded = new Set(
    requested.flatMap((key) =>
      stackDeployed(surface(key)) ? stackSites(surface(key).stack) : [key],
    ),
  );
  const asked = requested.length > 0 ? keys.filter((key) => expanded.has(key)) : keys;
  return { surfaces: asked, force: flag === "true" };
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
  readonly production: Pick<ReadonlyMap<SurfaceKey, string>, "get">;
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

/** What a production stack's own paths say: whether they changed since its own last deploy. */
export interface StackChange {
  readonly key: StackKey;
  readonly ship: boolean;
  readonly status: PlanStatus;
  /** The commit the stack's own job last deployed, when one was found. */
  readonly production?: string;
  readonly reason: string;
}

/**
 * Whether each requested stack's own paths (its `infra/` directory and
 * shared/infra/) differ from the commit its stack job last deployed. A
 * stack none of whose sites the request names is not asked about, so a
 * release whose surfaces leave a stack out never ships it.
 */
export function changedStacks(input: {
  readonly head: string;
  readonly request: ReleaseRequest;
  readonly production: Pick<ReadonlyMap<RecordKey, string>, "get">;
  readonly diff: Diff;
  readonly productionIsNewer: (production: string) => boolean;
}): StackChange[] {
  const asked = requestedStacks(input.request.surfaces);
  return PRODUCTION_STACKS.map((s): StackChange => {
    const production = input.production.get(stackRecordKey(s.key));
    const change = (ship: boolean, status: PlanStatus, reason: string): StackChange =>
      production === undefined
        ? { key: s.key, ship, status, reason }
        : { key: s.key, ship, status, production, reason };
    if (!asked.includes(s.key))
      return change(false, "not requested", "none of its sites is asked for");
    if (input.request.force) return change(true, "ships", "forced by the FORCE input");
    if (production === undefined) {
      return change(
        true,
        "ships",
        `no successful ${s.key} stack deployment found in the recent records`,
      );
    }
    if (production === input.head)
      return change(false, "unchanged", `production already runs ${short(production)}`);
    if (input.productionIsNewer(production)) {
      return change(
        false,
        "production is newer",
        `production runs ${short(production)}, which already contains this commit`,
      );
    }
    const files = input.diff(production);
    if (files === undefined) {
      return change(
        true,
        "ships",
        `cannot compare production's ${short(production)} with this commit`,
      );
    }
    const own = files.filter((file) => s.paths.test(file));
    if (own.length === 0) {
      return change(
        false,
        "unchanged",
        `nothing the stack deploys from changed since ${short(production)}`,
      );
    }
    return change(
      true,
      "ships",
      `${own[0]} changed${own.length > 1 ? `, and ${own.length - 1} more of its files` : ""}, which the ${s.key} stack deploys`,
    );
  });
}

/** Whether a commit whose files differ from the release commit's by `files` has the same stack paths. */
export function sameStackContent(key: StackKey, files: readonly string[] | undefined): boolean {
  return files !== undefined && !files.some((file) => stack(key).paths.test(file));
}

/** The stacks whose dev deployments the gate has to read. */
export function stackDevGateWanted(
  changes: readonly StackChange[],
  force: boolean,
): StackRecordKey[] {
  if (force) return [];
  return changes.filter((c) => c.ship).map((c) => stackRecordKey(c.key));
}

/**
 * Hold back a stack whose own paths changed when no successful dev run of
 * its stack job deployed the same stack paths, as a surface is held. A
 * forced release passes untouched.
 */
export function applyStackDevGate(input: {
  readonly changes: readonly StackChange[];
  readonly dev: DeployedCommits;
  readonly force: boolean;
}): StackChange[] {
  return input.changes.map((c): StackChange => {
    if (input.force || !c.ship) return c;
    const match = input.dev.accepted.get(stackRecordKey(c.key));
    if (match !== undefined)
      return { ...c, reason: `${c.reason}; dev ran this stack at ${short(match)}` };
    const newest = input.dev.newest.get(stackRecordKey(c.key));
    return {
      ...c,
      ship: false,
      status: "held back",
      reason: `${c.reason}; ${newest === undefined ? "no successful dev deployment of the stack found in the recent records" : `no recent dev deployment of the stack was built from these paths (dev's newest is ${short(newest)})`}, so it ships once dev has deployed it`,
    };
  });
}

export interface StackPlan {
  readonly key: StackKey;
  readonly ship: boolean;
  readonly reason: string;
  /** The commit the stack's own job last deployed, when one was found. */
  readonly production?: string;
}

/** What a release does: each surface's decision and each production stack's. */
export interface ReleaseDecisions {
  readonly decisions: readonly PlanDecision[];
  readonly stacks: readonly StackPlan[];
}

/**
 * Which production stacks ship. A stack deploys every site it declares, so
 * it ships when one of them ships, or when its own paths changed
 * (`changes`), and none of its sites, nor its own change, is held back or
 * newer on production (unless forced). A stack that waits holds its sites
 * back with it.
 */
export function stackPlans(
  decisions: readonly PlanDecision[],
  force: boolean,
  changes: readonly StackChange[] = [],
): ReleaseDecisions {
  const held = new Map<SurfaceKey, string>();
  const stacks = PRODUCTION_STACKS.map((s): StackPlan => {
    const own = changes.find((c) => c.key === s.key);
    const plan = (ship: boolean, reason: string): StackPlan =>
      own?.production === undefined
        ? { key: s.key, ship, reason }
        : { key: s.key, ship, reason, production: own.production };
    const sites = decisions.filter((d) => stackSites(s.key).includes(d.key));
    const shipping = sites.filter((d) => d.ship);
    if (shipping.length === 0 && own?.ship !== true) {
      return plan(
        false,
        own?.status === "held back" || own?.status === "production is newer"
          ? own.reason
          : "none of its sites ships",
      );
    }
    const blocking = force
      ? []
      : [
          ...sites
            .filter((d) => d.status === "held back" || d.status === "production is newer")
            .map((d) => `${d.key} is ${d.status}`),
          ...(own?.status === "held back"
            ? [`its own change is held back (${own.reason})`]
            : own?.status === "production is newer"
              ? [`production runs a newer ${s.key} stack`]
              : []),
        ];
    if (blocking.length === 0) {
      const why = [
        ...(shipping.length === 0
          ? []
          : [
              `${shipping.map((d) => d.key).join(", ")} ${shipping.length === 1 ? "ships" : "ship"}`,
            ]),
        ...(own?.ship === true ? [own.reason] : []),
      ];
      return plan(true, why.join("; "));
    }
    const why = blocking.join(", ");
    for (const d of shipping) {
      if (surface(d.key).production !== undefined) held.set(d.key, why);
    }
    return plan(false, `it deploys every site at once, and ${why}`);
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
 * stack, then `any` and `any_stack`, as $GITHUB_OUTPUT takes them.
 * `any_stack` also says a site build is needed: only a stack deploys a site.
 */
export function outputLines(release: ReleaseDecisions): string {
  const ships = new Set(release.decisions.filter((d) => d.ship).map((d) => d.key));
  const stacks = release.stacks.filter((s) => s.ship).map((s) => s.key);
  return [
    ...PRODUCTION_SURFACES.map((s) => `${s.key}=${ships.has(s.key)}`),
    ...PRODUCTION_STACKS.map((s) => `stack_${s.key}=${stacks.includes(s.key)}`),
    `any=${ships.size > 0 || stacks.length > 0}`,
    `any_stack=${stacks.length > 0}`,
    "",
  ].join("\n");
}

/**
 * Surfaces that ship only once another has a production record, each mapped
 * to the surface it waits for. osn-api and cire-api hold secrets that have no
 * copy outside Cloudflare, and the stacks upload none: every upload keeps the
 * secrets it does not name. zap-api's stack job proves that on production
 * first, since zap-api holds a secret its stack does not upload, and its
 * record exists only once the job's check after the deploy found every
 * secret still live.
 */
export const SHIPS_AFTER: ReadonlyMap<SurfaceKey, SurfaceKey> = new Map([
  ["osn_api", "zap_api"],
  ["cire_api", "zap_api"],
]);

/** The surface decisions and stack changes once SHIPS_AFTER has held back what waits. */
export interface ShipsAfterHold {
  readonly decisions: PlanDecision[];
  readonly changes: StackChange[];
}

/**
 * Holds back every shipping surface, and the own change, of each stack that
 * deploys a SHIPS_AFTER surface whose first has no production record. A stack
 * uploads every Worker it declares, so a change to a sibling site, or to the
 * stack's own paths, would otherwise upload the waiting API with it. A forced
 * release is held too: it uploads every Worker of a stack it ships.
 */
export function applyShipsAfter(input: {
  readonly decisions: readonly PlanDecision[];
  readonly changes: readonly StackChange[];
  readonly production: ReadonlyMap<RecordKey, string>;
}): ShipsAfterHold {
  const waiting = new Map<StackKey, string>();
  for (const [key, first] of SHIPS_AFTER) {
    const owner = surface(key).stack;
    if (input.production.has(first) || waiting.has(owner)) continue;
    waiting.set(
      owner,
      `the ${owner} stack deploys ${key}, which ships once ${first} has a production record, which proves on production that a deploy keeps the secrets it does not upload`,
    );
  }
  return {
    decisions: input.decisions.map((d): PlanDecision => {
      const why = waiting.get(surface(d.key).stack);
      return !d.ship || why === undefined
        ? d
        : { ...d, ship: false, status: "held back", reason: `${d.reason}; ${why}` };
    }),
    changes: input.changes.map((c): StackChange => {
      const why = waiting.get(c.key);
      return !c.ship || why === undefined
        ? c
        : { ...c, ship: false, status: "held back", reason: `${c.reason}; ${why}` };
    }),
  };
}

/**
 * Whether cire-api and the organiser portal both change in this release.
 * The cire stack deploys them in one Alchemy run in no set order, so when a
 * change alters the contract between them the portal side has to ship in a
 * release of its own first (wiki/shared/production-deploy.md §5.6), and the
 * approver is told to check.
 */
export function apiAheadOfHost(decisions: readonly PlanDecision[]): boolean {
  const api = decisions.find((d) => d.key === "cire_api");
  const host = decisions.find((d) => d.key === "cire_host");
  return api?.ship === true && host?.ship === true;
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
  const stackRows = release.stacks.map((s) => {
    const production =
      s.production === undefined
        ? "—"
        : `[\`${short(s.production)}\`](${repo}/commit/${s.production}) ([diff](${repo}/compare/${s.production}...${context.head}))`;
    return `| ${s.key} stack | ${production} | ${s.ship ? "ships" : "waits"} | ${s.reason} |`;
  });
  const approvals =
    stacks.length === 0
      ? "Wait until every one of those jobs shows Waiting, then one approval releases them all."
      : "First approve the Alchemy plan job and read its plan; then every other job reaches the gate together, and one second approval releases them all.";
  const warning = apiAheadOfHost(decisions)
    ? [
        "> [!WARNING]",
        "> `cire_api` and `cire_host` both change, and the cire stack deploys them together in no set order.",
        "> If this release changes the contract between them (the plan tiers), reject it and ship the portal side first: runbook §5.6.",
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

/** The commit `origin/main` names in the checkout, or undefined when it has none. */
export function mainCommit(cwd: string): string | undefined {
  const proc = Bun.spawnSync(
    ["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const sha = proc.stdout.toString().trim();
  return proc.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
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
  const request = parseRequest(env.SURFACES, env.FORCE);
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

  // A requested surface in the stack of a SHIPS_AFTER surface needs that
  // surface's first, since the stack would upload it.
  const firsts = [...SHIPS_AFTER].flatMap(([key, first]) =>
    request.surfaces.includes(first) ||
    !request.surfaces.some((s) => surface(s).stack === surface(key).stack)
      ? []
      : [first],
  );
  const production = await lastDeployed(reader, "production", [
    ...new Set([...request.surfaces, ...firsts]),
    ...requestedStacks(request.surfaces).map(stackRecordKey),
  ]);
  const changed = changedSurfaces({ head, request, production, diff, productionIsNewer });
  const stackChanges = changedStacks({ head, request, production, diff, productionIsNewer });
  // Dev deploys only from main, so a dev record whose commit main never held
  // proves nothing, whatever branch its run reports: GitHub reports a run
  // from a tag as on a branch of the tag's name.
  const mainTip = mainCommit(options.cwd) ?? head;
  const onMain = new Map<string, boolean>();
  const isOnMain = (commit: string): boolean => {
    if (!onMain.has(commit)) onMain.set(commit, isAncestor(commit, mainTip, options.cwd));
    return onMain.get(commit) === true;
  };
  const dev = await findDeployed(
    reader,
    "dev",
    [...devGateWanted(changed, request.force), ...stackDevGateWanted(stackChanges, request.force)],
    {
      only: isOnMain,
      accept: (key, commit) =>
        isStackRecordKey(key)
          ? sameStackContent(stackOfRecord(key), diff(commit))
          : sameContent(surface(key), diff(commit)),
    },
  );
  const gated = applyShipsAfter({
    decisions: applyDevGate({ decisions: changed, dev, diff, force: request.force }),
    changes: applyStackDevGate({ changes: stackChanges, dev, force: request.force }),
    production,
  });
  const planned = stackPlans(gated.decisions, request.force, gated.changes);
  const release: ReleaseDecisions = planned;

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
