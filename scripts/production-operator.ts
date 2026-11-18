#!/usr/bin/env bun
/**
 * One-shot operator actions on production, run by
 * .github/workflows/production-operator.yml. Each action that touches
 * production runs in a job bound to the `production` Environment, so a person
 * approves it first, and no agent or laptop holds a production credential.
 *
 *   bun --no-install scripts/production-operator.ts <action>
 *
 *   check-window            WINDOW_START, WINDOW_END. No secret, no request.
 *   plan-register           GITHUB_TOKEN, GITHUB_REPOSITORY. Reads which commit
 *                           production cire-api and osn-api run, and the scopes
 *                           cire-api signs with there. Writes `commit` and
 *                           `scopes` to GITHUB_OUTPUT. No production secret.
 *   register-cire-arc       INTERNAL_SERVICE_SECRET, EXPECTED_COMMIT,
 *                           GITHUB_TOKEN, GITHUB_REPOSITORY. Renews the scopes
 *                           of cire-api's registration at production osn-api.
 *   count-deletion-fanouts  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
 *                           WINDOW_START, WINDOW_END. Two counts from
 *                           production zap-db-prod.
 *
 * Run logs on this repository are public. No path prints a token, a bearer,
 * an account id, a row or any response body: a refusal prints the HTTP status,
 * a fixed hint, Cloudflare's numeric error codes, or an error's class name.
 * A request never follows a redirect, so a bearer goes to the host named here
 * and nowhere else.
 *
 * register-cire-arc writes no key of cire-api's own. osn-api keeps a service's
 * scopes on the service (`service_accounts`, upserted by serviceId alone in
 * `POST /graph/internal/register-service`, osn/api/src/routes/graph-internal.ts)
 * and checks a token against them through whichever live key signed it
 * (shared/crypto/src/arc.ts, resolvePublicKey). So the action registers a key
 * generated here, under a new key id, already expired, whose private half is
 * never exported, and then revokes that key id: the scopes reach cire-api's
 * real key, and the throwaway one can verify nothing. Each run leaves one
 * expired, revoked row under cire-api in `service_account_keys`.
 *
 * The scopes are the `ARC_*_SCOPE` constants of
 * cire/api/src/services/osn-bridge.ts at the commit production cire-api runs,
 * as the release planner finds it (scripts/release-plan.ts, lastDeployed), and
 * each must be in `PERMITTED_SCOPES` at the commit production osn-api runs. The
 * register job reads them again when it runs and refuses unless cire-api's
 * commit is still the one the check job showed the approver.
 *
 * Imports only Bun, Node built-ins and repository files that import nothing
 * else, so `--no-install` holds: a package import fails rather than being
 * fetched beside a production secret. release-plan.ts is loaded only by the
 * two actions that read deployment records.
 *
 * Exit codes: 0 done; 1 refused, or a request failed; 2 a usage error, before
 * any request.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PRODUCTION_HOSTS } from "../shared/infra/src/production-sites";

/** The production D1 database zap-api's erasures are recorded in (zap/api/wrangler.toml, `[[env.production.d1_databases]]`). */
export const ZAP_DATABASE = "zap-db-prod";
export const SERVICE_ID = "cire-api";
export const OSN_BRIDGE = "cire/api/src/services/osn-bridge.ts";
export const GRAPH_INTERNAL = "osn/api/src/routes/graph-internal.ts";
const OSN_API_ORIGIN = `https://${PRODUCTION_HOSTS.osnApi}`;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ROOT = join(import.meta.dir, "..");

/** How far in the past the throwaway key expires, in seconds. */
const EXPIRED_BY = 60;
const OSN_TIMEOUT_MS = 30_000;
const CLOUDFLARE_TIMEOUT_MS = 15_000;
/** Waits between tries of one Cloudflare read after a network error, a 429 or a 5xx. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  /** One line to stdout. */
  readonly out: (line: string) => void;
  /** One line to stderr. */
  readonly err: (line: string) => void;
  readonly appendFile: (path: string, text: string) => void;
  /** Unix seconds. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly randomUUID: () => string;
  /** A fresh public JWK whose private half is never exported. */
  readonly generatePublicJwk: () => Promise<string>;
  /** A file of this checkout, by repository path. */
  readonly readFile: (path: string) => string;
  /** A file at a commit, or undefined when git cannot show it. */
  readonly gitShow: (commit: string, path: string) => string | undefined;
  /** The commit each of cire_api and osn_api last deployed to production. */
  readonly productionCommits: () => Promise<ReadonlyMap<string, string>>;
}

/** A refusal whose message is written here and holds nothing read from outside. */
class Refusal extends Error {
  override readonly name = "Refusal";
}

/** A usage error, raised before any request. */
class UsageError extends Error {
  override readonly name = "UsageError";
}

const SHA = /^[0-9a-f]{40}$/;
const SCOPE = /^[a-z0-9_:-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const required = (env: Deps["env"], name: string): string => {
  const value = env[name] ?? "";
  if (value === "") throw new UsageError(`${name} is not set.`);
  return value;
};

// ── the window ──────────────────────────────────────────────────────────────

export interface Window {
  readonly start: number;
  readonly end: number;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parseInstant(name: string, value: string | undefined): number {
  if (value === undefined || !INSTANT.test(value)) {
    throw new UsageError(`${name} must be an instant written YYYY-MM-DDTHH:MM:SSZ.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value.replace("Z", ".000Z")) {
    throw new UsageError(`${name} is not a date and time that exists.`);
  }
  return ms / 1000;
}

/** The window from WINDOW_START and WINDOW_END, in unix seconds, both ends included. */
export function parseWindow(env: Deps["env"]): Window {
  const start = parseInstant("WINDOW_START", env.WINDOW_START);
  const end = parseInstant("WINDOW_END", env.WINDOW_END);
  if (end <= start) throw new UsageError("WINDOW_END must be after WINDOW_START.");
  return { start, end };
}

/** One read-only statement: the rows inside the window, and every row. */
export function countSql(window: Window): string {
  for (const edge of [window.start, window.end]) {
    if (!Number.isSafeInteger(edge)) throw new UsageError("A window edge is not a whole second.");
  }
  return `SELECT (SELECT COUNT(*) FROM zap_account_purges WHERE processed_at BETWEEN ${window.start} AND ${window.end}) AS in_window, (SELECT COUNT(*) FROM zap_account_purges) AS total`;
}

// ── Cloudflare ──────────────────────────────────────────────────────────────

interface Envelope {
  readonly status: number;
  readonly success: boolean;
  readonly codes: readonly number[];
  readonly result: unknown;
}

type Json = string | number | boolean | null | readonly Json[] | Answered;
/** An object an API answered, each field checked before use. */
interface Answered {
  readonly [key: string]: Json;
}

const isRecord = (value: unknown): value is Answered =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Request headers carrying `bearer`, and a JSON content type when there is a body. */
function bearerHeaders(bearer: string, body: unknown): Headers {
  const headers = new Headers({ authorization: `Bearer ${bearer}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return headers;
}

/**
 * One read of the v4 API, tried again after a network error, a 429 or a 5xx.
 * `label` names the read in every message; the URL, which holds the account
 * id, is never printed.
 */
async function cloudflareRead(
  deps: Deps,
  label: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Envelope> {
  const account = required(deps.env, "CLOUDFLARE_ACCOUNT_ID");
  const token = required(deps.env, "CLOUDFLARE_API_TOKEN");
  let last = "";
  for (const delay of [...RETRY_DELAYS_MS, undefined]) {
    let response: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a retry waits for the try before it
      response = await deps.fetch(`${CLOUDFLARE_API}/accounts/${account}${path}`, {
        method,
        headers: bearerHeaders(token, body),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
      });
    } catch (error) {
      last = `did not complete (${error instanceof Error ? error.name : "unknown error"})`;
      if (delay === undefined) break;
      // oxlint-disable-next-line no-await-in-loop -- a retry waits for the try before it
      await deps.sleep(delay);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      last = `answered ${response.status}`;
      if (delay === undefined) break;
      // oxlint-disable-next-line no-await-in-loop -- a retry waits for the try before it
      await deps.sleep(delay);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one answer per try
    const answer: unknown = await response.json().catch(() => undefined);
    const errors = isRecord(answer) && Array.isArray(answer.errors) ? answer.errors : [];
    const codes = errors.flatMap((error: unknown) =>
      isRecord(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)
        ? [error.code]
        : [],
    );
    const envelope: Envelope = {
      status: response.status,
      success: response.status === 200 && isRecord(answer) && answer.success === true,
      codes,
      result: isRecord(answer) ? answer.result : undefined,
    };
    if (!envelope.success) {
      const listed = codes.length > 0 ? `, codes ${codes.join(", ")}` : "";
      throw new Refusal(
        `${label} answered ${envelope.status}${listed}. Nothing from the answer is printed.`,
      );
    }
    return envelope;
  }
  throw new Refusal(`${label} failed after ${RETRY_DELAYS_MS.length + 1} tries; the last ${last}.`);
}

async function zapDatabaseId(deps: Deps): Promise<string> {
  const listing = await cloudflareRead(
    deps,
    `Listing the D1 databases named ${ZAP_DATABASE}`,
    "GET",
    `/d1/database?name=${encodeURIComponent(ZAP_DATABASE)}&per_page=100`,
  );
  const databases = Array.isArray(listing.result) ? listing.result : [];
  const exact = databases.filter(
    (database) => isRecord(database) && database.name === ZAP_DATABASE,
  );
  if (exact.length !== 1) {
    throw new Refusal(
      `Found ${exact.length} D1 databases named exactly ${ZAP_DATABASE} in the account; expected one.`,
    );
  }
  const [database] = exact;
  const uuid = isRecord(database) ? database.uuid : undefined;
  if (typeof uuid !== "string" || !UUID.test(uuid)) {
    throw new Refusal(`The listing's ${ZAP_DATABASE} has no database id of the expected form.`);
  }
  return uuid;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface PurgeCounts {
  readonly inWindow: number;
  readonly total: number;
}

/** The two counts the query answers, or a refusal that prints nothing from the answer. */
function readCounts(result: unknown): PurgeCounts {
  const unreadable = new Refusal(
    "The count query answered in a form this script does not read; nothing from it is printed.",
  );
  if (!Array.isArray(result) || result.length !== 1) throw unreadable;
  const [statement] = result;
  if (!isRecord(statement) || statement.success !== true || !Array.isArray(statement.results)) {
    throw unreadable;
  }
  if (statement.results.length !== 1) throw unreadable;
  const [row] = statement.results;
  if (!isRecord(row) || Object.keys(row).toSorted().join(",") !== "in_window,total") {
    throw unreadable;
  }
  const { in_window: inWindow, total } = row;
  if (!isCount(inWindow) || !isCount(total) || inWindow > total) throw unreadable;
  return { inWindow, total };
}

async function countDeletionFanouts(deps: Deps): Promise<void> {
  const window = parseWindow(deps.env);
  required(deps.env, "CLOUDFLARE_ACCOUNT_ID");
  required(deps.env, "CLOUDFLARE_API_TOKEN");
  const uuid = await zapDatabaseId(deps);
  const answer = await cloudflareRead(
    deps,
    "The count query",
    "POST",
    `/d1/database/${uuid}/query`,
    {
      sql: countSql(window),
    },
  );
  const { inWindow, total } = readCounts(answer.result);
  const lines = [
    `Zap erasures recorded in zap_account_purges (${ZAP_DATABASE}):`,
    `  processed from ${deps.env.WINDOW_START} to ${deps.env.WINDOW_END}, both ends included: ${inWindow}`,
    `  total: ${total}`,
  ];
  for (const line of lines) deps.out(line);
  summary(deps, lines);
}

// ── the scopes production cire-api signs with ───────────────────────────────

/**
 * The scopes a version of osn-bridge.ts signs with: each `const ARC_…SCOPE`
 * at the start of a line, in source order, once each. A constant inside a
 * comment does not start a line with `const`, so it never counts.
 */
export function scopesIn(source: string): string[] {
  const scopes: string[] = [];
  for (const match of source.matchAll(/^const ARC_\w*SCOPE = "([^"]+)";$/gm)) {
    const scope = match[1] ?? "";
    if (!SCOPE.test(scope)) throw new Refusal("An ARC_*_SCOPE constant is not a scope name.");
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/** The scopes a version of graph-internal.ts lets a service register. */
export function permittedIn(source: string): string[] {
  const block = /const PERMITTED_SCOPES = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

interface ProductionScopes {
  readonly cireCommit: string;
  readonly osnCommit: string;
  readonly scopes: readonly string[];
}

async function productionScopes(deps: Deps): Promise<ProductionScopes> {
  required(deps.env, "GITHUB_TOKEN");
  required(deps.env, "GITHUB_REPOSITORY");
  let commits: ReadonlyMap<string, string>;
  try {
    commits = await deps.productionCommits();
  } catch (error) {
    throw new Refusal(
      `Reading production's deployment records failed (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }
  const commitOf = (surface: string): string => {
    const commit = commits.get(surface) ?? "";
    if (!SHA.test(commit)) {
      throw new Refusal(`No trusted production deployment record names ${surface}'s commit.`);
    }
    return commit;
  };
  const cireCommit = commitOf("cire_api");
  const osnCommit = commitOf("osn_api");
  const bridge = deps.gitShow(cireCommit, OSN_BRIDGE);
  if (bridge === undefined) {
    throw new Refusal(
      `git cannot show ${OSN_BRIDGE} at production cire-api's commit ${cireCommit}.`,
    );
  }
  const scopes = scopesIn(bridge);
  if (scopes.length === 0) {
    throw new Refusal(`${OSN_BRIDGE} at ${cireCommit} has no ARC_*_SCOPE constant.`);
  }
  const graph = deps.gitShow(osnCommit, GRAPH_INTERNAL);
  if (graph === undefined) {
    throw new Refusal(
      `git cannot show ${GRAPH_INTERNAL} at production osn-api's commit ${osnCommit}.`,
    );
  }
  const permitted = permittedIn(graph);
  if (permitted.length === 0) {
    throw new Refusal(`${GRAPH_INTERNAL} at ${osnCommit} has no PERMITTED_SCOPES.`);
  }
  const refused = scopes.filter((scope) => !permitted.includes(scope));
  if (refused.length > 0) {
    throw new Refusal(
      `Production osn-api (${osnCommit}) does not permit ${refused.join(", ")}, which production cire-api (${cireCommit}) signs with. Release osn-api first.`,
    );
  }
  return { cireCommit, osnCommit, scopes };
}

async function planRegister(deps: Deps): Promise<void> {
  const planned = await productionScopes(deps);
  const lines = [
    `Production cire-api runs ${planned.cireCommit}; production osn-api runs ${planned.osnCommit}.`,
    `Approving register-cire-arc sets cire-api's ${planned.scopes.length} scopes at osn-api to: ${planned.scopes.join(", ")}.`,
  ];
  for (const line of lines) deps.out(line);
  const onMain = scopesIn(deps.readFile(OSN_BRIDGE));
  if (onMain.join(",") !== planned.scopes.join(",")) {
    deps.out(
      `::notice::main's ${OSN_BRIDGE} lists ${onMain.join(", ") || "no scope"}; production cire-api's lists ${planned.scopes.join(", ")}. The run registers production's.`,
    );
  }
  const output = deps.env.GITHUB_OUTPUT ?? "";
  if (output !== "") {
    deps.appendFile(output, `commit=${planned.cireCommit}\nscopes=${planned.scopes.join(",")}\n`);
  }
  summary(deps, lines);
}

// ── register-cire-arc ───────────────────────────────────────────────────────

const REGISTER_HINTS = new Map([
  [400, "osn-api refused the body: a scope it does not permit, or a key it cannot import."],
  [
    401,
    "osn-api refused the bearer: the production Environment's INTERNAL_SERVICE_SECRET is not the value osn-api holds.",
  ],
  [403, "Something in front of osn-api refused the request."],
  [404, "osn-api has no such route on this host."],
  [
    409,
    "osn-api refused the key id as revoked or as another service's; a fresh one never should be.",
  ],
  [422, "osn-api found the body malformed."],
  [429, "osn-api or Cloudflare limited the rate; dispatch again later."],
  [501, "osn-api holds no INTERNAL_SERVICE_SECRET, so registration is off."],
  [503, "osn-api is unavailable; dispatch again later."],
]);

const hintFor = (status: number): string =>
  REGISTER_HINTS.get(status) ??
  (status >= 300 && status < 400
    ? "osn-api answered a redirect, which this script never follows with the bearer."
    : "osn-api did not store the scopes.");

type Sent = { readonly status: number; readonly ok: boolean } | { readonly failed: string };

/** One request to osn-api with the bearer: its status and whether it said `ok: true`, never its body. */
async function toOsnApi(
  deps: Deps,
  bearer: string,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Sent> {
  try {
    const response = await deps.fetch(`${OSN_API_ORIGIN}${path}`, {
      method,
      headers: bearerHeaders(bearer, body),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(OSN_TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => undefined);
    return { status: response.status, ok: isRecord(answer) && answer.ok === true };
  } catch (error) {
    return { failed: error instanceof Error ? error.name : "unknown error" };
  }
}

async function registerCireArc(deps: Deps): Promise<void> {
  const bearer = required(deps.env, "INTERNAL_SERVICE_SECRET");
  const expected = required(deps.env, "EXPECTED_COMMIT");
  if (!SHA.test(expected)) throw new UsageError("EXPECTED_COMMIT is not a full commit SHA.");
  const planned = await productionScopes(deps);
  if (planned.cireCommit !== expected) {
    throw new Refusal(
      `Production cire-api now runs ${planned.cireCommit}, not ${expected}, which the check job read and the approver saw. Nothing was sent. Dispatch again.`,
    );
  }
  const keyId = deps.randomUUID();
  const registered = await toOsnApi(deps, bearer, "POST", "/graph/internal/register-service", {
    serviceId: SERVICE_ID,
    keyId,
    publicKeyJwk: await deps.generatePublicJwk(),
    allowedScopes: planned.scopes.join(","),
    expiresAt: deps.now() - EXPIRED_BY,
  });
  // Sent whatever the registration answered: a refusal wrote nothing and
  // answers 404, and a lost answer may have written the throwaway key.
  const revoked = await toOsnApi(
    deps,
    bearer,
    "DELETE",
    `/graph/internal/service-keys/${encodeURIComponent(keyId)}`,
  );

  if ("failed" in registered) {
    throw new Refusal(
      `The registration did not complete (${registered.failed}); osn-api may or may not have stored the scopes. Dispatch again.`,
    );
  }
  if (registered.status !== 200 || !registered.ok) {
    throw new Refusal(
      `The registration answered ${registered.status}${registered.status === 200 ? " without ok" : ""}. ${hintFor(registered.status)}`,
    );
  }
  const lines = [
    `osn-api answered 200: cire-api's ${planned.scopes.length} scopes are now ${planned.scopes.join(", ")}.`,
    "Each osn-api isolate keeps a key's scopes for up to 5 minutes, so a host's removal of their Cire data may answer 503 until then.",
    "A 200 shows osn-api stored the scopes; they apply only while cire-api's own key, CIRE_API_ARC_KEY_ID, is registered and live.",
  ];
  for (const line of lines) deps.out(line);
  summary(deps, lines);
  if ("failed" in revoked) {
    deps.out(
      `::warning::Revoking the throwaway key did not complete (${revoked.failed}). It was registered already expired, so it verifies nothing.`,
    );
  } else if (revoked.status === 200) {
    deps.out("Revoking the throwaway key answered 200.");
  } else {
    deps.out(
      `::warning::Revoking the throwaway key answered ${revoked.status}. It was registered already expired, so it verifies nothing.`,
    );
  }
}

// ── running ─────────────────────────────────────────────────────────────────

function summary(deps: Deps, lines: readonly string[]): void {
  const path = deps.env.GITHUB_STEP_SUMMARY ?? "";
  if (path !== "") deps.appendFile(path, `${lines.join("\n")}\n`);
}

function checkWindow(deps: Deps): void {
  parseWindow(deps.env);
  deps.out(`Window: ${deps.env.WINDOW_START} to ${deps.env.WINDOW_END}, both ends included.`);
}

/** Each action by name. A Map, so a name such as `constructor` finds nothing. */
const ACTIONS = new Map<string, (deps: Deps) => Promise<void> | void>([
  ["check-window", checkWindow],
  ["plan-register", planRegister],
  ["register-cire-arc", registerCireArc],
  ["count-deletion-fanouts", countDeletionFanouts],
]);

/** Runs one action; the exit code. Prints nothing an error carries but a message written here. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  const [name, ...rest] = argv;
  const action = name === undefined ? undefined : ACTIONS.get(name);
  if (action === undefined || rest.length > 0) {
    deps.err(
      `::error::production-operator: usage: production-operator.ts <${[...ACTIONS.keys()].join("|")}>`,
    );
    return 2;
  }
  try {
    await action(deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`::error::${name}: ${error.message}`);
      return 2;
    }
    if (error instanceof Refusal) {
      deps.err(`::error::${name}: ${error.message}`);
      return 1;
    }
    deps.err(`::error::${name} failed (${error instanceof Error ? error.name : "unknown error"}).`);
    return 1;
  }
}

// ── the real dependencies ───────────────────────────────────────────────────

/** Unix seconds, whole. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A fresh ECDSA P-256 public key as `kty`, `crv`, `x` and `y`; the private half is not extractable. */
export async function generatePublicJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return JSON.stringify({ kty, crv, x, y });
}

/** A file at a commit of this checkout, or undefined; git's own output is never printed. */
export function gitShow(commit: string, path: string): string | undefined {
  const proc = Bun.spawnSync(["git", "show", `${commit}:${path}`], {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? proc.stdout.toString() : undefined;
}

/** The commits production cire-api and osn-api run, from the release planner's trusted records. */
export async function lookupProductionCommits(
  fetchImpl: typeof fetch,
  env: Deps["env"],
): Promise<ReadonlyMap<string, string>> {
  const { lastDeployed, restReader } = await import("./release-plan");
  const reader = restReader({
    fetch: fetchImpl,
    token: env.GITHUB_TOKEN ?? "",
    repository: env.GITHUB_REPOSITORY ?? "",
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  });
  return lastDeployed(reader, "production", ["cire_api", "osn_api"]);
}

if (import.meta.main) {
  const env = process.env;
  const code = await run(process.argv.slice(2), {
    env,
    fetch,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    appendFile: appendFileSync,
    now: nowSeconds,
    sleep: (ms) => Bun.sleep(ms),
    randomUUID: () => crypto.randomUUID(),
    generatePublicJwk,
    readFile: (path) => readFileSync(join(ROOT, path), "utf8"),
    gitShow,
    productionCommits: () => lookupProductionCommits(fetch, env),
  });
  process.exit(code);
}
