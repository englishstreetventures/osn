#!/usr/bin/env bun
/**
 * Decide whether a dev stack job deploys its commit.
 *
 * Run by each stack job of .github/workflows/deploy.yml, inside the stack's
 * concurrency group, just before its deploy. The group lets one job deploy a
 * stack at a time, in the order the jobs reached it, which is not the order
 * of their commits: two pushes close together each start a run, and the
 * older commit's job can reach the group after the newer one's has deployed.
 * Deploying then would put older code back on dev until the next push that
 * touches the stack.
 *
 * So this refuses the deploy when the stack has already passed on dev at a
 * commit this one is a strict ancestor of, which it reads from the `dev`
 * Environment's Deployment records as scripts/release-plan.ts reads them (a
 * record counts only when the job it links succeeded at the record's commit,
 * in a deploy.yml run on main in this repository), and only at a commit on
 * `origin/main`, since GitHub reports a run from a tag as on a branch of the
 * tag's name. Either is enough:
 *   - the stack job's own record: it deployed the whole stack, and every
 *     check passed;
 *   - a record from every one of the stack's record jobs: each surface
 *     deployed and passed its check, though the stack job failed after them
 *     (the guest site's route comparison rolls nothing back). One surface is
 *     not enough: after a failed check rolled another back, that one runs
 *     older code, and a deploy lets the next snapshot re-upload it.
 * A record at this commit, at an older one, or at one git cannot place
 * deploys, as does no record at all.
 *
 * When no commit on `origin/main` is newer than this one, it deploys without
 * asking GitHub: a newer commit's stack job cannot succeed while this job
 * holds the group, so any newer record names a commit pushed before this
 * job's checkout. Otherwise it reads the newest page of records (MAX_RECORDS)
 * and their statuses in one GraphQL query, reads the jobs of a run only for a
 * record whose commit is newer than this one, and stops once the evidence is
 * complete. Evidence older than that page is not seen.
 *
 * Usage, from the repository root of a full-history checkout:
 *   dev-deploy-order.ts --stack <musubi|cire|zap|pulse>
 * Inputs, from the environment: GITHUB_TOKEN (deployments and Actions read),
 * GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_API_URL and GITHUB_SERVER_URL,
 * which default to github.com's.
 * Writes `deploy=true|false` to $GITHUB_OUTPUT (stdout when unset). On a
 * refusal it also appends a line naming both commits to $GITHUB_STEP_SUMMARY
 * and prints a notice.
 *
 * Each request gets REQUEST_TIMEOUT_MS and, after a network error, a timeout,
 * a 429, a 5xx or a rate-limited 403, two more tries (RETRY_DELAYS_MS apart,
 * or what a Retry-After asks, up to MAX_RETRY_AFTER_MS). Then any failure —
 * GitHub's, a shallow checkout, a commit the checkout lacks — exits 1 and
 * writes no output, so the deploy does not run: an unread record cannot show
 * that the commit is not older.
 */

import { appendFileSync } from "node:fs";

import { isAncestor, STACKS, type StackKey, SURFACES } from "./deploy-surfaces";
import {
  type DeploymentReader,
  type DeploymentRecord,
  type DeploymentStatus,
  findDeployed,
  PAGE_SIZE,
  type RecordKey,
  restReader,
  stackRecordKey,
} from "./release-plan";

/** Records the walk reads at most: one page. */
export const MAX_RECORDS = 100;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

/** The longest a rate limit's Retry-After makes a try wait: well inside the step's five minutes. */
export const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether an answer could differ if asked again: a 429, a 5xx, or a 403 that
 * says when to try again, which is how GitHub answers a secondary rate limit.
 */
const transient = (response: Response) =>
  response.status === 429 ||
  response.status >= 500 ||
  (response.status === 403 && response.headers.has("retry-after"));

/** The wait an answer's Retry-After asks for, capped, or undefined when it asks none. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
    : undefined;
}

/**
 * `inner`, with a time limit on each try, and up to `delays.length` more tries
 * after a network error, a timeout, a 429, a 5xx or a rate-limited 403. A try
 * waits what the answer's Retry-After asks (up to MAX_RETRY_AFTER_MS), else
 * the next delay. The last answer is returned for the caller to judge; the
 * last error is thrown.
 */
export function retryingFetch(
  inner: typeof fetch,
  options: {
    readonly timeoutMs?: number;
    readonly delays?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const pause = options.sleep ?? sleep;
  const attempt = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    left: readonly number[],
  ): Promise<Response> => {
    const [delay, ...rest] = left;
    const answer = await inner(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch(
      (error: unknown) => {
        if (delay === undefined) throw error;
        return undefined;
      },
    );
    if (answer !== undefined && (delay === undefined || !transient(answer))) return answer;
    // Here a try is left: an answer with none was returned, an error with none thrown.
    await pause((answer === undefined ? undefined : retryAfterMs(answer)) ?? delay ?? 0);
    return attempt(input, init, rest);
  };
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    attempt(input, init, delays)) as typeof fetch;
}

const DEPLOYMENTS_QUERY = `query($owner: String!, $name: String!, $environment: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    deployments(environments: [$environment], first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { endCursor }
      nodes { databaseId commitOid statuses(first: 10) { nodes { state logUrl } } }
    }
  }
}`;

interface DeploymentsPage {
  readonly records: readonly (DeploymentRecord & {
    readonly statuses: readonly DeploymentStatus[];
  })[];
  readonly endCursor: string | null;
}

function parseDeploymentsPage(payload: unknown): DeploymentsPage {
  const body = payload as {
    data?: {
      repository?: {
        deployments?: { pageInfo?: { endCursor?: unknown }; nodes?: unknown };
      } | null;
    };
    errors?: unknown;
  } | null;
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error(
      `GitHub API: the deployments query failed: ${JSON.stringify(body.errors).slice(0, 200)}`,
    );
  }
  const connection = body?.data?.repository?.deployments;
  if (!Array.isArray(connection?.nodes)) {
    throw new TypeError("GitHub API: the deployments query returned no list of deployments");
  }
  const records = connection.nodes.map((item: unknown) => {
    const node = item as {
      databaseId?: unknown;
      commitOid?: unknown;
      statuses?: { nodes?: unknown } | null;
    } | null;
    if (typeof node?.databaseId !== "number" || typeof node.commitOid !== "string") {
      throw new TypeError("GitHub API: a deployment has no numeric `databaseId` or `commitOid`");
    }
    const statuses = Array.isArray(node.statuses?.nodes) ? node.statuses.nodes : [];
    return {
      id: node.databaseId,
      sha: node.commitOid,
      statuses: statuses.map((entry: unknown) => {
        const status = entry as { state?: unknown; logUrl?: unknown } | null;
        if (typeof status?.state !== "string") {
          throw new TypeError("GitHub API: a deployment status has no `state`");
        }
        return {
          // GraphQL's states are REST's in upper case.
          state: status.state.toLowerCase(),
          log_url: typeof status.logUrl === "string" ? status.logUrl : "",
        };
      }),
    };
  });
  const cursor = connection.pageInfo?.endCursor;
  return { records, endCursor: typeof cursor === "string" ? cursor : null };
}

/**
 * `rest`, but each page of Deployment records is one GraphQL query that brings
 * every record's statuses with it, where REST spends a request per record: a
 * walk past other stacks' records costs one request a page, not one a record.
 * Jobs and run origins still come from `rest`.
 */
export function graphqlPages(options: {
  readonly fetch: typeof fetch;
  readonly token: string;
  readonly repository: string;
  readonly graphqlUrl: string;
  readonly rest: DeploymentReader;
}): DeploymentReader {
  const [owner, name] = options.repository.split("/");
  const statuses = new Map<number, readonly DeploymentStatus[]>();
  const cursors = new Map<number, string | null>([[1, null]]);
  return {
    async deployments(environment, page) {
      const after = cursors.get(page);
      if (after === undefined)
        throw new Error(`deployments page ${page} asked before the one before it`);
      const response = await options.fetch(options.graphqlUrl, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: DEPLOYMENTS_QUERY,
          variables: { owner, name, environment, first: PAGE_SIZE, after },
        }),
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200);
        throw new Error(
          `GitHub API answered ${response.status} for the deployments query: ${text}`,
        );
      }
      const read = parseDeploymentsPage(await response.json());
      cursors.set(page + 1, read.endCursor);
      for (const record of read.records) statuses.set(record.id, record.statuses);
      return read.records.map(({ id, sha }) => ({ id, sha }));
    },
    statuses: async (deploymentId) =>
      statuses.get(deploymentId) ?? options.rest.statuses(deploymentId),
    jobs: (runId) => options.rest.jobs(runId),
    origin: (runId) => options.rest.origin(runId),
  };
}

export interface OrderDecision {
  readonly deploy: boolean;
  /** When refused, the newer commits the stack passed at. */
  readonly newer: readonly string[];
  readonly reason: string;
}

/** The surfaces a stack deploys, in map order. */
const surfacesOf = (key: StackKey): readonly RecordKey[] =>
  SURFACES.filter((s) => s.stack === key).map((s) => s.key);

/**
 * Whether the stack has passed on dev at a commit `isNewer` keeps: its own
 * job's record there, or one from every one of its record jobs.
 */
export async function decideDevDeploy(input: {
  readonly reader: DeploymentReader;
  readonly stack: StackKey;
  readonly isNewer: (commit: string) => boolean;
  readonly maxRecords?: number;
}): Promise<OrderDecision> {
  const own = stackRecordKey(input.stack);
  const surfaces = surfacesOf(input.stack);
  const complete = (accepted: ReadonlyMap<RecordKey, string>) =>
    accepted.has(own) || (surfaces.length > 0 && surfaces.every((key) => accepted.has(key)));
  const { accepted } = await findDeployed(input.reader, "dev", [own, ...surfaces], {
    only: input.isNewer,
    enough: complete,
    maxRecords: input.maxRecords ?? MAX_RECORDS,
  });
  const stackAt = accepted.get(own);
  if (stackAt !== undefined) {
    return { deploy: false, newer: [stackAt], reason: "its stack job passed" };
  }
  if (complete(accepted)) {
    const commits = [...new Set(surfaces.map((key) => accepted.get(key) as string))];
    return { deploy: false, newer: commits, reason: "every one of its surfaces passed" };
  }
  return {
    deploy: true,
    newer: [],
    reason: "no dev record in the newest page shows it passed at a newer commit",
  };
}

// ── the step ────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() } as const;
}

function parseStack(argv: readonly string[]): StackKey {
  const at = argv.indexOf("--stack");
  const value = at === -1 ? undefined : argv[at + 1];
  const found = STACKS.find((s) => s.key === value);
  if (found === undefined) {
    const known = STACKS.map((s) => s.key).join(", ");
    throw new Error(`--stack must name one of ${known}, not '${value ?? ""}'`);
  }
  return found.key;
}

export interface OrderStep {
  readonly decision: OrderDecision;
  /** `deploy=true|false`, as $GITHUB_OUTPUT takes it. */
  readonly outputs: string;
  /** Empty unless the deploy is refused. */
  readonly summary: string;
  readonly log: string;
}

export async function runDevDeployOrder(options: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly cwd: string;
  readonly retry?: {
    readonly timeoutMs?: number;
    readonly delays?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
  };
}): Promise<OrderStep> {
  const { env, cwd } = options;
  const stack = parseStack(options.argv);
  const head = env.GITHUB_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`GITHUB_SHA must be a full SHA, not '${head}'`);
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.endsWith("/..")) {
    throw new Error(`GITHUB_REPOSITORY must be owner/name, not '${repository}'`);
  }
  const token = env.GITHUB_TOKEN ?? "";
  if (token === "") throw new Error("GITHUB_TOKEN is not set; the stack job passes github.token");

  // Ancestry is only as good as the history: a shallow checkout would answer
  // "not newer" for every record, and so "deploy", with nothing red.
  if (git(cwd, "rev-parse", "--is-shallow-repository").out !== "false") {
    throw new Error("the checkout is shallow or not a repository; check out with fetch-depth: 0");
  }
  if (!git(cwd, "cat-file", "-e", `${head}^{commit}`).ok) {
    throw new Error(`the checkout has no commit ${head}`);
  }
  const main = git(cwd, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}");
  if (!main.ok) throw new Error("the checkout has no origin/main; check out with fetch-depth: 0");

  // Newer than this commit, and on main: dev deploys only from main, and
  // GitHub reports a run from a tag as on a branch of the tag's name, so a
  // record at a commit main never held is no evidence.
  const newer = new Map<string, boolean>();
  const isNewer = (commit: string): boolean => {
    if (!newer.has(commit)) {
      newer.set(
        commit,
        commit !== head && isAncestor(head, commit, cwd) && isAncestor(commit, main.out, cwd),
      );
    }
    return newer.get(commit) === true;
  };

  const short = (sha: string) => sha.slice(0, 7);
  const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
  const fetcher = retryingFetch(options.fetch, options.retry);
  const decision: OrderDecision = !isNewer(main.out)
    ? { deploy: true, newer: [], reason: "nothing on main is newer" }
    : await decideDevDeploy({
        reader: graphqlPages({
          fetch: fetcher,
          token,
          repository,
          graphqlUrl: `${apiUrl}/graphql`,
          rest: restReader({ fetch: fetcher, token, repository, apiUrl }),
        }),
        stack,
        isNewer,
      });

  if (decision.deploy) {
    return {
      decision,
      outputs: "deploy=true\n",
      summary: "",
      log: `The ${stack} stack deploys ${short(head)}: ${decision.reason}.\n`,
    };
  }
  const commitUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/commit`;
  const link = (sha: string) => `[\`${short(sha)}\`](${commitUrl}/${sha})`;
  const newerList = decision.newer.map(short).join(" and ");
  const plain = `The ${stack} stack does not deploy ${short(head)}: it already passed on dev at the newer ${newerList} (${decision.reason}). Deploying would put older code back; the next push that touches the stack deploys it.`;
  return {
    decision,
    outputs: "deploy=false\n",
    summary: `**The ${stack} stack did not deploy.** This run's commit ${link(head)} is older than ${decision.newer.map(link).join(" and ")}, at which the stack already passed on dev (${decision.reason}).\n`,
    log: `::notice title=${stack} stack not deployed::${plain}\n`,
  };
}

if (import.meta.main) {
  try {
    const step = await runDevDeployOrder({
      argv: process.argv.slice(2),
      env: process.env,
      fetch,
      cwd: process.cwd(),
    });
    process.stdout.write(step.log);
    const output = process.env.GITHUB_OUTPUT;
    if (output !== undefined && output !== "") appendFileSync(output, step.outputs);
    else process.stdout.write(step.outputs);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (step.summary !== "" && summary !== undefined && summary !== "") {
      appendFileSync(summary, step.summary);
    }
  } catch (error) {
    process.stderr.write(
      `::error::dev-deploy-order: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
