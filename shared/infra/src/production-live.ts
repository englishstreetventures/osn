/**
 * What a production stack's adopted resources hold live, read with the
 * production token, and what the plan guard refuses of it.
 *
 * Alchemy adopts an API Worker, a D1 database or an R2 bucket by its name and
 * then changes it to match the declaration, and no plan line shows a cron
 * replaced, a Durable Object class deleted, a lifecycle rule rewritten, CORS
 * cleared or a secret overwritten by a var. So before approval 2, and again in
 * each stack job before its deploy, the release reads each adopted resource
 * here, and the guard refuses:
 *
 *  - on every release: an adopted resource that does not exist live; a Worker
 *    that lacks a secret the inventory requires on production or holds one it
 *    forbids; a declared var or binding named like a live secret, which the
 *    upload would replace; a live Durable Object class no declared binding
 *    names, which the upload would delete with its storage;
 *  - for a resource the plan adopts (`adopted`, or an API Worker's `create`,
 *    which the deploy adopts): a live cron schedule that differs from the
 *    declared one, a database whose read replication differs, and a bucket
 *    whose lifecycle rules, CORS, r2.dev access or custom domains differ;
 *  - on a release that adopts nothing: a custom domain whose previews flag
 *    differs from the declaration.
 *
 * Once a resource is in state, Alchemy's own plan shows a declared change as
 * an `update`, so the adoption checks hold only while a resource is being
 * adopted; on any other release a cron schedule that differs is listed for
 * the approver. A Durable Object class is part of the Worker's upload, not a
 * resource the plan names, so its check holds on every release.
 *
 * Every value read is a name or a setting: no secret's value is ever fetched,
 * and the file holds none. Each read defaults exactly as the provider does
 * when it reads the same reply (`@alchemy.run/cloudflare` 2.0.0-beta.85).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { redactAccountIds } from "./secrets/compare";
import { tierSecrets, type WorkerKey } from "./secrets/inventory";
import type { ApiWorkerObservability } from "./worker";

// ── what a product declares ─────────────────────────────────────────────────

/** One lifecycle rule as the provider normalises a declared or a live one. */
export interface LifecycleRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly prefix: string;
  readonly abortMultipartUploadsTransition?: { readonly condition?: unknown };
  readonly deleteObjectsTransition?: { readonly condition?: unknown };
  readonly storageClassTransitions?: readonly unknown[];
}

/** An adopted API Worker as its production declaration states it. */
export interface AdoptedWorker {
  readonly name: string;
  readonly worker: WorkerKey;
  readonly crons: readonly string[];
  /** Each Durable Object namespace binding the Worker hosts, by binding name, with its class. */
  readonly durableObjects: Readonly<Record<string, string>>;
  /** Every var and binding name the upload sends: none may be a live secret's. */
  readonly envNames: readonly string[];
  /** Whether the upload asks for version previews on its custom domains: off for a domain declared by name. */
  readonly previews: boolean;
  readonly observability: ApiWorkerObservability;
}

export interface AdoptedDatabase {
  readonly name: string;
  readonly readReplication: "auto" | "disabled";
}

export interface AdoptedBucket {
  readonly name: string;
  readonly lifecycleRules: readonly LifecycleRule[];
  readonly cors: readonly unknown[];
  readonly publicAccess: boolean;
  readonly domains: readonly string[];
}

/** A stack's adopted resources, each by its logical id. */
export interface AdoptedResources {
  readonly workers: Readonly<Record<string, AdoptedWorker>>;
  readonly databases: Readonly<Record<string, AdoptedDatabase>>;
  readonly buckets: Readonly<Record<string, AdoptedBucket>>;
}

/** A binding as a product's declaration describes it: a Durable Object one names its class. */
interface DescribedBinding {
  readonly kind: string;
  readonly className?: string;
}

/**
 * An adopted Worker, from a product's production declaration of it (its
 * Worker input, bindings described as data). Its custom domain is declared by
 * name, which asks for no previews on it.
 */
export function adoptedWorkerOf(declared: {
  readonly name: string;
  readonly worker: WorkerKey;
  readonly crons: readonly string[];
  readonly vars: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, DescribedBinding>>;
  readonly observability: ApiWorkerObservability;
}): AdoptedWorker {
  return {
    name: declared.name,
    worker: declared.worker,
    crons: declared.crons,
    durableObjects: Object.fromEntries(
      Object.entries(declared.bindings).flatMap(([binding, described]) =>
        described.kind === "durable-object" && described.className !== undefined
          ? [[binding, described.className]]
          : [],
      ),
    ),
    envNames: [...Object.keys(declared.vars), ...Object.keys(declared.bindings)].toSorted(),
    previews: false,
    observability: declared.observability,
  };
}

/** An adopted bucket, from a product's production declaration of it. */
export function adoptedBucketOf(declared: {
  readonly name: string;
  readonly lifecycleRules: readonly Parameters<typeof declaredRule>[0][];
  readonly cors: readonly unknown[];
  readonly publicAccess: boolean;
  readonly domains: readonly { readonly name: string }[];
}): AdoptedBucket {
  return {
    name: declared.name,
    lifecycleRules: declared.lifecycleRules.map(declaredRule),
    cors: declared.cors,
    publicAccess: declared.publicAccess,
    domains: declared.domains.map((domain) => domain.name),
  };
}

// ── what is live ────────────────────────────────────────────────────────────

export interface LiveDomain {
  readonly hostname: string;
  readonly previews: boolean;
}

export interface LiveWorker {
  readonly exists: boolean;
  readonly secrets: readonly string[];
  readonly crons: readonly string[];
  readonly durableObjectClasses: readonly string[];
  readonly domains: readonly LiveDomain[];
  /** The script's observability settings as Cloudflare returns them, or null when it has none. */
  readonly observability: unknown;
}

export interface LiveDatabase {
  readonly exists: boolean;
  readonly readReplication: string;
}

export interface LiveBucket {
  readonly exists: boolean;
  readonly lifecycleRules: readonly LifecycleRule[];
  readonly corsRules: number;
  readonly managedDomain: boolean;
  readonly customDomains: readonly string[];
}

/** What `readProductionLive` writes: each adopted resource, by logical id. */
export interface LiveState {
  readonly workers: Readonly<Record<string, LiveWorker>>;
  readonly databases: Readonly<Record<string, LiveDatabase>>;
  readonly buckets: Readonly<Record<string, LiveBucket>>;
}

// ── reading ─────────────────────────────────────────────────────────────────

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** How the reader reaches Cloudflare: the production account and token, and a fetch. */
export interface CloudflareApi {
  readonly account: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
}

export class LiveReadError extends Error {}

/** Waits between tries of one read after a network error, a 429 or a 5xx. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

interface Envelope {
  readonly status: number;
  readonly success: boolean;
  readonly codes: readonly number[];
  readonly result: unknown;
  readonly resultInfo: unknown;
}

/** One GET of the v4 API, tried again after a network error, a 429 or a 5xx. */
async function get(api: CloudflareApi, path: string): Promise<Envelope> {
  const url = `${CLOUDFLARE_API}/accounts/${api.account}${path}`;
  const once = async (): Promise<Envelope | "transient"> => {
    let response: Response;
    try {
      response = await api.fetch(url, {
        headers: { authorization: `Bearer ${api.token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return "transient";
    }
    if (response.status === 429 || response.status >= 500) return "transient";
    const body = (await response.json().catch(() => undefined)) as
      | {
          readonly success?: unknown;
          readonly errors?: readonly { readonly code?: unknown }[];
          readonly result?: unknown;
          readonly result_info?: unknown;
        }
      | undefined;
    if (body === undefined) {
      throw new LiveReadError(
        `GET ${redactAccountIds(url)} answered ${response.status} with no JSON`,
      );
    }
    return {
      status: response.status,
      success: body.success === true,
      codes: (body.errors ?? []).flatMap((error) =>
        typeof error.code === "number" ? [error.code] : [],
      ),
      result: body.result,
      resultInfo: body.result_info,
    };
  };
  for (const delay of [...RETRY_DELAYS_MS, undefined]) {
    // oxlint-disable-next-line no-await-in-loop -- a retry waits for the try before it
    const answer = await once();
    if (answer !== "transient") return answer;
    if (delay === undefined) break;
    // oxlint-disable-next-line no-await-in-loop -- the pause between tries
    await api.sleep(delay);
  }
  throw new LiveReadError(`GET ${redactAccountIds(url)} failed three times (network, 429 or 5xx)`);
}

const refusedRead = (path: string, envelope: Envelope): LiveReadError =>
  new LiveReadError(
    redactAccountIds(
      `GET ${path} answered ${envelope.status}${envelope.codes.length === 0 ? "" : ` (codes ${envelope.codes.join(", ")})`}`,
    ),
  );

/** A value parsed from an API answer's JSON body. */
type Json = string | number | boolean | null | readonly Json[] | Answered;
/** An object the API answered, each field checked before use. */
interface Answered {
  readonly [key: string]: Json;
}

const isRecord = (value: unknown): value is Answered =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (values: readonly unknown[], path: string): string[] =>
  values.map((value) => {
    if (typeof value !== "string") throw new LiveReadError(`GET ${path}: a name is not a string`);
    return value;
  });

/** A result that must be a list, as each listing endpoint answers. */
function listOf(envelope: Envelope, path: string): readonly unknown[] {
  if (!envelope.success || !Array.isArray(envelope.result)) throw refusedRead(path, envelope);
  return envelope.result;
}

/** A result that must be an object. */
function objectOf(envelope: Envelope, path: string): Answered {
  if (!envelope.success || !isRecord(envelope.result)) throw refusedRead(path, envelope);
  return envelope.result;
}

const WORKER_NOT_FOUND = 10007;
const BUCKET_NOT_FOUND = 10006;
const NO_CORS_CONFIGURATION = 10059;

const notFound = (envelope: Envelope, code: number): boolean =>
  envelope.status === 404 || envelope.codes.includes(code);

/** Every Durable Object namespace on the account, every page. */
async function durableObjectNamespaces(
  api: CloudflareApi,
): Promise<readonly { readonly script: string; readonly className: string }[]> {
  const namespaces: { script: string; className: string }[] = [];
  for (let page = 1; ; page++) {
    const path = `/workers/durable_objects/namespaces?page=${page}&per_page=1000`;
    // oxlint-disable-next-line no-await-in-loop -- a page's length says whether another follows
    const listed = listOf(await get(api, path), path);
    for (const entry of listed) {
      if (!isRecord(entry) || typeof entry.class !== "string") continue;
      namespaces.push({
        script: typeof entry.script === "string" ? entry.script : "",
        className: entry.class,
      });
    }
    if (listed.length < 1000) return namespaces;
  }
}

async function readWorker(
  api: CloudflareApi,
  name: string,
  namespaces: () => Promise<readonly { readonly script: string; readonly className: string }[]>,
): Promise<LiveWorker> {
  const script = `/workers/scripts/${encodeURIComponent(name)}`;
  const settings = await get(api, `${script}/settings`);
  if (notFound(settings, WORKER_NOT_FOUND)) {
    return {
      exists: false,
      secrets: [],
      crons: [],
      durableObjectClasses: [],
      domains: [],
      observability: null,
    };
  }
  const settingsResult = objectOf(settings, `${script}/settings`);
  const secretsPath = `${script}/secrets`;
  const secrets = strings(
    listOf(await get(api, secretsPath), secretsPath).map((entry) =>
      isRecord(entry) ? entry.name : undefined,
    ),
    secretsPath,
  ).toSorted();
  const schedulesPath = `${script}/schedules`;
  const schedules = objectOf(await get(api, schedulesPath), schedulesPath).schedules;
  const crons = (Array.isArray(schedules) ? schedules : []).flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.cron === "string" ? [entry.cron] : [],
  );
  const domainsPath = `/workers/domains?service=${encodeURIComponent(name)}`;
  const domains = listOf(await get(api, domainsPath), domainsPath).flatMap((entry): LiveDomain[] =>
    isRecord(entry) && entry.service === name && typeof entry.hostname === "string"
      ? // The provider reads an absent or null flag as off.
        [{ hostname: entry.hostname, previews: entry.previews_enabled === true }]
      : [],
  );
  const durableObjectClasses = (await namespaces())
    .filter((namespace) => namespace.script === name)
    .map((namespace) => namespace.className);
  return {
    exists: true,
    secrets,
    crons: [...new Set(crons)].toSorted(),
    durableObjectClasses: [...new Set(durableObjectClasses)].toSorted(),
    domains: domains.toSorted((a, b) => a.hostname.localeCompare(b.hostname)),
    observability: settingsResult.observability ?? null,
  };
}

async function readDatabase(api: CloudflareApi, name: string): Promise<LiveDatabase> {
  let uuid: string | undefined;
  for (let page = 1; uuid === undefined; page++) {
    const path = `/d1/database?name=${encodeURIComponent(name)}&page=${page}&per_page=100`;
    // oxlint-disable-next-line no-await-in-loop -- a page's length says whether another follows
    const listed = listOf(await get(api, path), path);
    // The name filter matches by part, so `osn-db` lists `osn-db-prod` too: only an exact name counts.
    const match = listed.find((entry) => isRecord(entry) && entry.name === name);
    if (isRecord(match) && typeof match.uuid === "string") uuid = match.uuid;
    if (uuid === undefined && listed.length < 100) {
      return { exists: false, readReplication: "disabled" };
    }
  }
  const path = `/d1/database/${uuid}`;
  const database = objectOf(await get(api, path), path);
  const replication = database.read_replication;
  return {
    exists: true,
    // The provider reads an absent or null setting as disabled.
    readReplication:
      isRecord(replication) && typeof replication.mode === "string" ? replication.mode : "disabled",
  };
}

/** A live lifecycle rule as the provider's `toLifecycleRule` reads it. */
function liveRule(entry: unknown, path: string): LifecycleRule {
  if (!isRecord(entry) || typeof entry.id !== "string") {
    throw new LiveReadError(`GET ${path}: a lifecycle rule has no id`);
  }
  const conditions = isRecord(entry.conditions) ? entry.conditions : {};
  const transition = (value: unknown) =>
    isRecord(value) ? { condition: value.condition ?? undefined } : undefined;
  return {
    id: entry.id,
    enabled: entry.enabled === true,
    prefix: typeof conditions.prefix === "string" ? conditions.prefix : "",
    abortMultipartUploadsTransition: transition(entry.abortMultipartUploadsTransition),
    deleteObjectsTransition: transition(entry.deleteObjectsTransition),
    storageClassTransitions: Array.isArray(entry.storageClassTransitions)
      ? entry.storageClassTransitions
      : undefined,
  };
}

async function readBucket(api: CloudflareApi, name: string): Promise<LiveBucket> {
  const bucket = `/r2/buckets/${encodeURIComponent(name)}`;
  const found = await get(api, bucket);
  if (notFound(found, BUCKET_NOT_FOUND)) {
    return {
      exists: false,
      lifecycleRules: [],
      corsRules: 0,
      managedDomain: false,
      customDomains: [],
    };
  }
  objectOf(found, bucket);
  const lifecyclePath = `${bucket}/lifecycle`;
  const lifecycle = objectOf(await get(api, lifecyclePath), lifecyclePath).rules;
  const corsPath = `${bucket}/cors`;
  const cors = await get(api, corsPath);
  // No CORS configuration answers an error, which the provider reads as none.
  const corsRules = cors.codes.includes(NO_CORS_CONFIGURATION)
    ? 0
    : (() => {
        const rules = objectOf(cors, corsPath).rules;
        return Array.isArray(rules) ? rules.length : 0;
      })();
  const managedPath = `${bucket}/domains/managed`;
  const managed = objectOf(await get(api, managedPath), managedPath);
  const customPath = `${bucket}/domains/custom`;
  const custom = objectOf(await get(api, customPath), customPath).domains;
  return {
    exists: true,
    lifecycleRules: (Array.isArray(lifecycle) ? lifecycle : []).map((entry) =>
      liveRule(entry, lifecyclePath),
    ),
    corsRules,
    managedDomain: managed.enabled === true,
    customDomains: (Array.isArray(custom) ? custom : [])
      .flatMap((entry: unknown) =>
        isRecord(entry) && typeof entry.domain === "string" ? [entry.domain] : [],
      )
      .toSorted(),
  };
}

/** Reads every adopted resource of a stack, in a fixed order. Throws LiveReadError, whose message names no account id. */
export async function readProductionLive(
  adopted: AdoptedResources,
  api: CloudflareApi,
): Promise<LiveState> {
  let listed:
    | Promise<readonly { readonly script: string; readonly className: string }[]>
    | undefined;
  const namespaces = () => (listed ??= durableObjectNamespaces(api));
  // Each map is built in logical-id order, so the file it is written to reads
  // the same on every run.
  const byId = <T, R>(
    entries: Readonly<Record<string, T>>,
    read: (entry: T) => Promise<R>,
  ): Promise<Record<string, R>> => {
    const sorted = Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b));
    return Promise.all(sorted.map(([, entry]) => read(entry))).then((results) =>
      Object.fromEntries(sorted.map(([id], i) => [id, results[i]!])),
    );
  };
  const [workers, databases, buckets] = await Promise.all([
    byId(adopted.workers, (worker) => readWorker(api, worker.name, namespaces)),
    byId(adopted.databases, (database) => readDatabase(api, database.name)),
    byId(adopted.buckets, (bucket) => readBucket(api, bucket.name)),
  ]);
  return { workers, databases, buckets };
}

// ── judging ─────────────────────────────────────────────────────────────────

/** A declared lifecycle rule as the provider's `normalizeLifecycleRule` reads it. */
export function declaredRule(rule: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly prefix?: string;
  readonly abortMultipartUploadsTransition?: { readonly condition?: unknown };
  readonly deleteObjectsTransition?: { readonly condition?: unknown };
  readonly storageClassTransitions?: readonly unknown[];
}): LifecycleRule {
  return {
    id: rule.id,
    enabled: rule.enabled ?? true,
    prefix: rule.prefix ?? "",
    abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition
      ? { condition: rule.abortMultipartUploadsTransition.condition }
      : undefined,
    deleteObjectsTransition: rule.deleteObjectsTransition
      ? { condition: rule.deleteObjectsTransition.condition }
      : undefined,
    storageClassTransitions: rule.storageClassTransitions,
  };
}

/** A rule as compared: its fields in a fixed order, absent ones left out, so key order and `undefined` never count. */
const ruleKey = (rule: LifecycleRule): string =>
  JSON.stringify(rule, (_key, value: unknown) =>
    isRecord(value) && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))
      : value,
  );

const sameRules = (live: readonly LifecycleRule[], declared: readonly LifecycleRule[]): boolean => {
  const byId = (rules: readonly LifecycleRule[]) => rules.map(ruleKey).toSorted().join("\n");
  return byId(live) === byId(declared);
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  [...new Set(a)].toSorted().join("\n") === [...new Set(b)].toSorted().join("\n");

/** What the observability settings are, as compared and listed. */
function observabilitySummary(value: unknown): string {
  if (!isRecord(value)) return "none";
  const logs = isRecord(value.logs) ? value.logs : {};
  const traces = isRecord(value.traces) ? value.traces : {};
  return [
    `enabled ${String(value.enabled ?? "unset")}`,
    `logs ${String(logs.enabled ?? "unset")}`,
    `invocation logs ${String(logs.invocation_logs ?? "unset")}`,
    `traces ${String(traces.enabled ?? "unset")}`,
    `query strings redacted ${String(value.redact_query_string ?? "unset")}`,
  ].join(", ");
}

const declaredObservability = (observability: ApiWorkerObservability): string =>
  observabilitySummary({
    enabled: observability.logs,
    logs: {
      enabled: observability.logs,
      invocation_logs: observability.logs && (observability.invocationLogs ?? false),
    },
    traces: { enabled: observability.traces.enabled },
    redact_query_string: observability.redactQueryString,
  });

/** What the guard makes of the live read: what it refuses, and what it only lists. */
export interface LiveJudgement {
  readonly refusals: readonly string[];
  readonly notices: readonly string[];
}

/**
 * Every reason to refuse the live state of a stack's adopted resources, and
 * every difference to list. `adopting` holds the logical ids the plan adopts.
 * A resource the live read did not cover is refused: the read and the
 * declaration must name the same resources.
 */
export function judgeLive(input: {
  readonly adopted: AdoptedResources;
  readonly live: LiveState;
  readonly adopting: ReadonlySet<string>;
}): LiveJudgement {
  const { adopted, live, adopting } = input;
  const refusals: string[] = [];
  const notices: string[] = [];
  const anyAdoption = adopting.size > 0;
  for (const [id, worker] of Object.entries(adopted.workers)) {
    const state = live.workers[id];
    if (state === undefined) {
      refusals.push(`${id} (${worker.name}) was not read live`);
      continue;
    }
    if (!state.exists) {
      refusals.push(
        `${id}: no Worker ${worker.name} exists live, and production adopts its API Workers`,
      );
      continue;
    }
    const row = tierSecrets(worker.worker, "production");
    const missing = row.secrets.filter((name) => !state.secrets.includes(name));
    if (missing.length > 0) {
      refusals.push(
        `${worker.name} lacks secrets it needs on production: ${missing.join(", ")}; set each on the Worker (wrangler secret put) before releasing`,
      );
    }
    const forbidden = row.forbidden.filter((name) => state.secrets.includes(name));
    if (forbidden.length > 0) {
      refusals.push(
        `${worker.name} holds secrets it must not: ${forbidden.join(", ")}; delete each with wrangler secret delete before releasing`,
      );
    }
    const known = new Set([...row.secrets, ...row.optional, ...row.forbidden]);
    const unknown = state.secrets.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      notices.push(
        `${worker.name} keeps live secrets the inventory does not list: ${unknown.join(", ")}`,
      );
    }
    const shadowed = worker.envNames.filter((name) => state.secrets.includes(name)).toSorted();
    if (shadowed.length > 0) {
      refusals.push(
        `${worker.name} declares vars or bindings named like its live secrets, which the upload would replace: ${shadowed.join(", ")}`,
      );
    }
    for (const domain of state.domains) {
      if (domain.previews === worker.previews) continue;
      const line = `${worker.name}'s custom domain ${domain.hostname} has previews ${domain.previews ? "on" : "off"} live and ${worker.previews ? "on" : "off"} declared, so the deploy detaches it and attaches it again`;
      if (anyAdoption) notices.push(line);
      else
        refusals.push(
          `${line}; outside a release that adopts, change it in the Cloudflare dashboard first`,
        );
    }
    const declaredClasses = Object.values(worker.durableObjects);
    const deleted = state.durableObjectClasses.filter(
      (className) => !declaredClasses.includes(className),
    );
    if (deleted.length > 0) {
      refusals.push(
        `${worker.name} hosts Durable Object classes no declared binding names: ${deleted.join(", ")}; the deploy would delete each, with its storage`,
      );
    }
    if (!sameSet(state.crons, worker.crons)) {
      const line = `${worker.name}'s live cron schedule [${state.crons.join(", ")}] differs from the declared [${worker.crons.join(", ")}]`;
      if (adopting.has(id)) refusals.push(`${line}, and adopting it would replace it`);
      else notices.push(`${line}; the deploy replaces it with the declared one`);
    }
    if (!adopting.has(id)) continue;
    const liveObservability = observabilitySummary(state.observability);
    const wanted = declaredObservability(worker.observability);
    if (liveObservability !== wanted) {
      notices.push(
        `${worker.name}'s observability changes from [${liveObservability}] to [${wanted}]`,
      );
    }
  }
  for (const [id, database] of Object.entries(adopted.databases)) {
    const state = live.databases[id];
    if (state === undefined) {
      refusals.push(`${id} (${database.name}) was not read live`);
      continue;
    }
    if (!state.exists) {
      refusals.push(
        `${id}: no D1 database ${database.name} exists live, and production adopts its databases`,
      );
      continue;
    }
    if (adopting.has(id) && state.readReplication !== database.readReplication) {
      refusals.push(
        `${database.name}'s read replication is ${state.readReplication} live and ${database.readReplication} declared, and adopting it would change it`,
      );
    }
  }
  for (const [id, bucket] of Object.entries(adopted.buckets)) {
    const state = live.buckets[id];
    if (state === undefined) {
      refusals.push(`${id} (${bucket.name}) was not read live`);
      continue;
    }
    if (!state.exists) {
      refusals.push(
        `${id}: no R2 bucket ${bucket.name} exists live, and production adopts its buckets`,
      );
      continue;
    }
    if (!adopting.has(id)) continue;
    const changes = [
      sameRules(state.lifecycleRules, bucket.lifecycleRules) ? "" : "its lifecycle rules",
      state.corsRules === bucket.cors.length ? "" : "its CORS rules",
      state.managedDomain === bucket.publicAccess ? "" : "its r2.dev access",
      sameSet(state.customDomains, bucket.domains) ? "" : "its custom domains",
    ].filter((change) => change !== "");
    if (changes.length > 0) {
      refusals.push(
        `${bucket.name}: ${changes.join(", ")} differ live from the declaration, and adopting it would change them`,
      );
    }
  }
  return { refusals, notices };
}

/** Whether `value` holds what lostSecrets reads: each Worker's secret names. */
function holdsSecretNames(value: unknown): value is LiveState {
  if (!isRecord(value) || !isRecord(value.workers)) return false;
  return Object.values(value.workers).every(
    (worker) =>
      isRecord(worker) &&
      Array.isArray(worker.secrets) &&
      worker.secrets.every((name) => typeof name === "string"),
  );
}

/** Each Worker's secret names live before a deploy and gone after it. */
export function lostSecrets(before: LiveState, after: LiveState): readonly string[] {
  return Object.entries(before.workers).flatMap(([id, worker]) => {
    const now = new Set(after.workers[id]?.secrets ?? []);
    const lost = worker.secrets.filter((name) => !now.has(name));
    return lost.length === 0 ? [] : [`${id}: ${lost.join(", ")}`];
  });
}

// ── the CLI each product's `read:live` script runs ─────────────────────────

/** What one product's `read:live` entry hands the CLI. */
export interface ReadLiveCliInput {
  readonly adopted: AdoptedResources;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (text: string) => void;
}

/**
 * `bun run read:live -- --out <live.json> [--kept <before.json>]`: reads the
 * stack's adopted resources with CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN and writes the state to `--out`. With `--kept`, the
 * state an earlier read wrote, it also fails, naming them, when a secret
 * name live then is gone now: the check after a deploy. Exits 0 when read
 * (and nothing was lost), 1 when a secret was lost, 2 on a bad argument, a
 * missing credential or a read that failed; no message names the account.
 */
export async function runReadLiveCli(input: ReadLiveCliInput): Promise<number> {
  const args = input.argv.filter((arg) => arg !== "--");
  const value = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    const found = at === -1 ? undefined : args[at + 1];
    return found === undefined || found.startsWith("--") ? undefined : found;
  };
  const fail = (code: 1 | 2, message: string): number => {
    input.out(`::error::read-live: ${redactAccountIds(message)}\n`);
    return code;
  };
  const outFile = value("out");
  if (outFile === undefined) return fail(2, "pass --out <file>, and --kept <file> after a deploy");
  const keptFile = args.includes("--kept") ? value("kept") : undefined;
  if (args.includes("--kept") && keptFile === undefined) return fail(2, "--kept takes a file");
  const account = input.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = input.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!/^[0-9a-f]{32}$/.test(account) || token === "") {
    return fail(2, "CLOUDFLARE_ACCOUNT_ID (32 hex digits) and CLOUDFLARE_API_TOKEN must be set");
  }
  let live: LiveState;
  try {
    live = await readProductionLive(input.adopted, {
      account,
      token,
      fetch: input.fetch,
      sleep: input.sleep,
    });
  } catch (error) {
    return fail(2, error instanceof Error ? error.message : String(error));
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(live, null, 2)}\n`);
  for (const [id, worker] of Object.entries(live.workers)) {
    input.out(
      worker.exists
        ? `${id}: ${worker.secrets.length} secrets, ${worker.crons.length} crons, ${worker.durableObjectClasses.length} Durable Object classes, ${worker.domains.length} custom domains\n`
        : `${id}: no such Worker\n`,
    );
  }
  if (keptFile === undefined) return 0;
  let before: unknown;
  try {
    before = JSON.parse(readFileSync(keptFile, "utf8"));
  } catch {
    before = undefined;
  }
  if (!holdsSecretNames(before)) {
    return fail(2, `--kept ${keptFile} is not a state read-live wrote`);
  }
  const lost = lostSecrets(before, live);
  if (lost.length > 0) {
    return fail(
      1,
      `secrets live before the deploy are gone after it: ${lost.join("; ")}. Cloudflare returns no secret value; set each again from its owner's copy (wiki/shared/production-deploy.md §3)`,
    );
  }
  input.out("Every secret live before the deploy is live after it.\n");
  return 0;
}
