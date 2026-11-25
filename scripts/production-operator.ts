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
 *                           production cire-api and osn-api run, the scopes
 *                           cire-api signs with there, and how osn-api there
 *                           takes them. Writes `commit`, `scopes` and `method`
 *                           to GITHUB_OUTPUT. No production secret.
 *   register-cire-arc       INTERNAL_SERVICE_SECRET, EXPECTED_COMMIT,
 *                           EXPECTED_METHOD, GITHUB_TOKEN, GITHUB_REPOSITORY.
 *                           Renews the scopes of cire-api's registration at
 *                           production osn-api.
 *   count-deletion-fanouts  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
 *                           WINDOW_START, WINDOW_END. Two counts from
 *                           production zap-db-prod.
 *   check-notice            NOTICE_ID, DRY_RUN, RESEND_UNCONFIRMED, MAX_SENDS,
 *                           GITHUB_TOKEN, GITHUB_REPOSITORY. Reads the
 *                           change notice in the registry at the commit
 *                           production osn-api runs, shows it in full, and
 *                           writes `osn_commit` and `notice_digest` to
 *                           GITHUB_OUTPUT. No production secret.
 *   send-change-notice      OSN_CHANGE_NOTICE_SECRET, the four inputs above,
 *                           EXPECTED_OSN_COMMIT, EXPECTED_NOTICE_DIGEST,
 *                           GITHUB_TOKEN, GITHUB_REPOSITORY. Mails the notice
 *                           to every account through production osn-api, at
 *                           most MAX_SENDS addresses this run, or with DRY_RUN
 *                           only counts them. osn-api holds the addresses; the
 *                           runner sees counts.
 *
 * Run logs on this repository are public. No path prints a token, a bearer,
 * an account id, a row or any response body: a refusal prints the HTTP status,
 * a fixed hint, Cloudflare's numeric error codes, or an error's class name.
 * A request never follows a redirect, so a bearer goes to the host named here
 * and nowhere else.
 *
 * register-cire-arc writes no key of cire-api's own. osn-api keeps a service's
 * scopes on the service (`service_accounts`, osn/db/src/schema/index.ts) and
 * checks a token against them through whichever live key signed it
 * (shared/crypto/src/arc.ts, resolvePublicKey). How the action sets them
 * depends on the commit production osn-api runs:
 *
 *   renew     the commit has `PUT /graph/internal/service-scopes/:serviceId`
 *             (osn/api/src/routes/graph-internal.ts): one request with the
 *             scopes and no key. osn-api refuses it, writing nothing, unless
 *             cire-api already has a row and a live key.
 *   fallback  it has not: the action registers a key generated here through
 *             `POST /graph/internal/register-service`, under a new key id,
 *             already expired, whose private half is never exported, and then
 *             revokes that key id. The scopes reach cire-api's real key through
 *             the service row, and the throwaway key verifies nothing; each run
 *             leaves one expired, revoked row under cire-api in
 *             `service_account_keys`.
 *
 * The scopes are the `ARC_*_SCOPE` constants of
 * cire/api/src/services/osn-bridge.ts at the commit production cire-api runs,
 * as the release planner finds it (scripts/release-plan.ts, lastDeployed), and
 * each must be in `PERMITTED_SCOPES` at the commit production osn-api runs. The
 * register job reads them again when it runs and refuses, before any request,
 * unless cire-api's commit and the method are still the ones the check job
 * showed the approver.
 *
 * Everything it loads, smoke-check.ts (for CI_USER_AGENT) and release-plan.ts
 * with what they import, imports only Bun, Node built-ins and other
 * repository files, so `--no-install` holds: a package import fails rather
 * than being fetched beside a production secret. Test R14 walks that import
 * graph. Top-level code in any of those files runs beside the secret too.
 * release-plan.ts is loaded only by the two actions that read deployment
 * records.
 *
 * Exit codes: 0 done; 1 refused, or a request failed; 2 a usage error, before
 * any request.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChangeNotice,
  NOTICE_ID_PATTERN,
  noticeDigest,
  parseChangeNotices,
  takesEffectSeconds,
} from "../osn/api/src/services/change-notice-registry";
import { PRODUCTION_HOSTS } from "../shared/infra/src/production-sites";
import { CI_USER_AGENT } from "./smoke-check";

/** The production D1 database zap-api's erasures are recorded in (zap/api/wrangler.toml, `[[env.production.d1_databases]]`). */
export const ZAP_DATABASE = "zap-db-prod";
export const SERVICE_ID = "cire-api";
export const OSN_BRIDGE = "cire/api/src/services/osn-bridge.ts";
export const GRAPH_INTERNAL = "osn/api/src/routes/graph-internal.ts";
/** osn-api's scope renewal, under `/graph/internal`, the route group's prefix. */
export const RENEW_PATH = `/graph/internal/service-scopes/${encodeURIComponent(SERVICE_ID)}`;
const OSN_API_ORIGIN = `https://${PRODUCTION_HOSTS.osnApi}`;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ROOT = join(import.meta.dir, "..");

// Removed by englishstreetventures/osn#2432 with the fallback below.
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
 * Headers for a request to osn-api's public host. It carries CI_USER_AGENT,
 * as every check of a deployed host does: Cloudflare's Bot Fight Mode answers
 * a GitHub runner's request that carries Bun's own user agent with a
 * challenge, in the Worker's place (scripts/smoke-check.ts). The Cloudflare
 * API is not behind it, so its requests keep Bun's.
 */
function osnApiHeaders(bearer: string, body: unknown): Headers {
  const headers = bearerHeaders(bearer, body);
  headers.set("user-agent", CI_USER_AGENT);
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

/**
 * Whether a version of graph-internal.ts declares the scope renewal: a line
 * that starts, after spaces, with `.put(`, and the route's path next, on that
 * line or the one after, as the formatter writes it. A `//` or ` * ` comment
 * line never starts that way. Two things it would still count, and that no
 * version has held: the route inside a block comment whose lines carry no
 * leading `*`, and the route written in the file but not mounted.
 */
export function renewRouteIn(source: string): boolean {
  return /^[ \t]*\.put\(\s*"\/service-scopes\/:serviceId"/m.test(source);
}

/** How the action sets the scopes; `fallback` goes with englishstreetventures/osn#2432. */
export type Method = "renew" | "fallback";
const METHODS: readonly string[] = ["renew", "fallback"] satisfies readonly Method[];

interface ProductionScopes {
  readonly cireCommit: string;
  readonly osnCommit: string;
  readonly scopes: readonly string[];
  readonly method: Method;
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
  return { cireCommit, osnCommit, scopes, method: renewRouteIn(graph) ? "renew" : "fallback" };
}

/** The line that tells the approver, and the run's log, how the scopes are sent. */
const methodLine = (planned: ProductionScopes): string =>
  planned.method === "renew"
    ? `Production osn-api serves PUT /graph/internal/service-scopes/:serviceId: the run sets the scopes and registers no key.`
    : `Production osn-api (${planned.osnCommit}) predates PUT /graph/internal/service-scopes/:serviceId: the run registers a throwaway key, already expired, and revokes it (englishstreetventures/osn#2432 removes this path).`;

async function planRegister(deps: Deps): Promise<void> {
  const planned = await productionScopes(deps);
  const lines = [
    `Production cire-api runs ${planned.cireCommit}; production osn-api runs ${planned.osnCommit}.`,
    `Approving register-cire-arc sets cire-api's ${planned.scopes.length} scopes at osn-api to: ${planned.scopes.join(", ")}.`,
    methodLine(planned),
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
    deps.appendFile(
      output,
      `commit=${planned.cireCommit}\nscopes=${planned.scopes.join(",")}\nmethod=${planned.method}\n`,
    );
  }
  summary(deps, lines);
}

// ── register-cire-arc ───────────────────────────────────────────────────────

/** What each status of the fallback's registration means. */
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

/** What each status of the renewal means, beside the two refusals `RENEW_REFUSALS` names. */
const RENEW_HINTS = new Map([
  [400, "osn-api refused a scope it does not permit."],
  [
    401,
    "osn-api refused the bearer: the production Environment's INTERNAL_SERVICE_SECRET is not the value osn-api holds.",
  ],
  [403, "Something in front of osn-api refused the request."],
  [404, "osn-api has no such route on this host."],
  [409, "osn-api refused the renewal."],
  [422, "osn-api found the body malformed."],
  [429, "osn-api or Cloudflare limited the rate; dispatch again later."],
  [501, "osn-api holds no INTERNAL_SERVICE_SECRET, so registration is off."],
  [503, "osn-api is unavailable; dispatch again later."],
]);

/**
 * The renewal's two refusals, by the fixed token in the answer's `error`, the
 * only field of a body this script reads, and the one status osn-api sends it
 * with. A token under any other status gets that status's hint.
 */
const RENEW_REFUSALS = new Map([
  [
    "unknown_service",
    {
      status: 404,
      hint: "osn-api holds no registration for cire-api: register cire-api's key first, as wiki/shared/production-deploy.md §6.2 says.",
    },
  ],
  [
    "no_live_key",
    {
      status: 409,
      hint: "osn-api holds no live key for cire-api: each is revoked or expired. Register cire-api's new key first, as wiki/shared/production-deploy.md §6.2 says.",
    },
  ],
]);

/**
 * What the status means. `mitigated` is Cloudflare's `cf-mitigated` header:
 * null when absent, else its value when that is one short lower-case word, or
 * "" when it is anything else, which is never printed. `refusal` is one of
 * `RENEW_REFUSALS`' tokens, or undefined.
 */
const hintFor = (
  hints: ReadonlyMap<number, string>,
  sent: { readonly status: number; readonly mitigated: string | null; readonly refusal?: string },
): string => {
  if (sent.mitigated !== null) {
    const named = sent.mitigated === "" ? "cf-mitigated" : `cf-mitigated: ${sent.mitigated}`;
    return `Cloudflare answered in osn-api's place (${named}); the request never reached osn-api.`;
  }
  const refusal = sent.refusal === undefined ? undefined : RENEW_REFUSALS.get(sent.refusal);
  return (
    (refusal?.status === sent.status ? refusal.hint : undefined) ??
    hints.get(sent.status) ??
    (sent.status >= 300 && sent.status < 400
      ? "osn-api answered a redirect, which this script never follows with the bearer."
      : "osn-api did not store the scopes.")
  );
};

/** A `cf-mitigated` value fit to print: one short lower-case word, else "". */
const mitigation = (value: string | null): string | null =>
  value === null ? null : /^[a-z_-]{1,20}$/.test(value) ? value : "";

type Sent =
  | {
      readonly status: number;
      readonly ok: boolean;
      readonly mitigated: string | null;
      /** The answer's `error` when it is exactly one of `RENEW_REFUSALS`' tokens. */
      readonly refusal: string | undefined;
    }
  | { readonly failed: string };

/**
 * One request to osn-api with the bearer: its status, whether it said
 * `ok: true`, and its `error` only when that is one of the fixed refusal
 * tokens. Nothing else of the body is kept.
 */
async function toOsnApi(
  deps: Deps,
  bearer: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Sent> {
  try {
    const response = await deps.fetch(`${OSN_API_ORIGIN}${path}`, {
      method,
      headers: osnApiHeaders(bearer, body),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(OSN_TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => undefined);
    const error = isRecord(answer) ? answer.error : undefined;
    return {
      status: response.status,
      ok: isRecord(answer) && answer.ok === true,
      mitigated: mitigation(response.headers.get("cf-mitigated")),
      refusal: typeof error === "string" && RENEW_REFUSALS.has(error) ? error : undefined,
    };
  } catch (error) {
    return { failed: error instanceof Error ? error.name : "unknown error" };
  }
}

async function registerCireArc(deps: Deps): Promise<void> {
  const bearer = required(deps.env, "INTERNAL_SERVICE_SECRET");
  const expected = required(deps.env, "EXPECTED_COMMIT");
  if (!SHA.test(expected)) throw new UsageError("EXPECTED_COMMIT is not a full commit SHA.");
  const expectedMethod = required(deps.env, "EXPECTED_METHOD");
  if (!METHODS.includes(expectedMethod)) {
    throw new UsageError(`EXPECTED_METHOD is not one of ${METHODS.join(", ")}.`);
  }
  const planned = await productionScopes(deps);
  if (planned.cireCommit !== expected) {
    throw new Refusal(
      `Production cire-api now runs ${planned.cireCommit}, not ${expected}, which the check job read and the approver saw. Nothing was sent. Dispatch again.`,
    );
  }
  if (planned.method !== expectedMethod) {
    throw new Refusal(
      `Production osn-api now runs ${planned.osnCommit}, which takes the scopes by the ${planned.method} method, not the ${expectedMethod} method the approver saw. Nothing was sent. Dispatch again.`,
    );
  }
  deps.out(methodLine(planned));
  if (planned.method === "renew") {
    await renewScopes(deps, bearer, planned);
  } else {
    await registerThrowaway(deps, bearer, planned);
  }
}

/** What a 200 that said `ok` shows, in the log and the run summary. */
function stored(deps: Deps, planned: ProductionScopes): void {
  const lines = [
    `osn-api answered 200: cire-api's ${planned.scopes.length} scopes are now ${planned.scopes.join(", ")}.`,
    "Each osn-api isolate keeps a key's scopes for up to 5 minutes, so a host's removal of their Cire data may answer 503 until then.",
    "A 200 shows osn-api stored the scopes; they apply only while cire-api's own key, CIRE_API_ARC_KEY_ID, is registered and live.",
  ];
  for (const line of lines) deps.out(line);
  summary(deps, lines);
}

/** One PUT of the scopes, with no key. osn-api writes nothing unless cire-api has a row and a live key. */
async function renewScopes(deps: Deps, bearer: string, planned: ProductionScopes): Promise<void> {
  const renewed = await toOsnApi(deps, bearer, "PUT", RENEW_PATH, { scopes: planned.scopes });
  if ("failed" in renewed) {
    throw new Refusal(
      `The renewal did not complete (${renewed.failed}); osn-api may or may not have stored the scopes. The renewal sets the whole list, so dispatching again is safe.`,
    );
  }
  if (renewed.status !== 200 || !renewed.ok) {
    throw new Refusal(
      `The renewal answered ${renewed.status}${renewed.status === 200 ? " without ok" : ""}. ${hintFor(RENEW_HINTS, renewed)}`,
    );
  }
  stored(deps, planned);
}

// Removed by englishstreetventures/osn#2432 once production osn-api serves the renewal.
/** The fallback: a throwaway key, registered already expired with the scopes, then revoked. */
async function registerThrowaway(
  deps: Deps,
  bearer: string,
  planned: ProductionScopes,
): Promise<void> {
  const keyId = deps.randomUUID();
  const registered = await toOsnApi(deps, bearer, "POST", "/graph/internal/register-service", {
    serviceId: SERVICE_ID,
    keyId,
    publicKeyJwk: await deps.generatePublicJwk(),
    allowedScopes: planned.scopes.join(","),
    expiresAt: deps.now() - EXPIRED_BY,
  });
  // The throwaway key may exist after a 200, a 5xx or a lost answer, so it is
  // revoked then. A 3xx or 4xx is a refusal before any write, and a 409 there
  // names a key id held by another service or already revoked, which this run
  // must not touch.
  const mayHaveWritten =
    "failed" in registered || registered.status === 200 || registered.status >= 500;
  const revoked = mayHaveWritten
    ? await toOsnApi(
        deps,
        bearer,
        "DELETE",
        `/graph/internal/service-keys/${encodeURIComponent(keyId)}`,
      )
    : undefined;

  if ("failed" in registered) {
    throw new Refusal(
      `The registration did not complete (${registered.failed}); osn-api may or may not have stored the scopes. Dispatch again.`,
    );
  }
  if (registered.status !== 200 || !registered.ok) {
    throw new Refusal(
      `The registration answered ${registered.status}${registered.status === 200 ? " without ok" : ""}. ${hintFor(REGISTER_HINTS, { status: registered.status, mitigated: registered.mitigated })}`,
    );
  }
  stored(deps, planned);
  if (revoked === undefined) return;
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

// ── change notices ──────────────────────────────────────────────────────────

/** The change-notice registry, by repository path, as production osn-api ships it. */
export const CHANGE_NOTICES_FILE = "osn/api/src/services/change-notices.json";
/** The most addresses one run may send: 1,000 calls of 100. */
const MAX_SENDS_CEILING = 100_000;
/** One call of osn-api sends at most this many. */
const NOTICE_BATCH = 100;
/** The pause between accepted batches: one request a second of Resend's ten per team. */
const NOTICE_GAP_MS = 1_000;
/** Waits after a 429, before giving up: Resend's rate limit, or its quota. */
const NOTICE_RATE_WAITS_MS: readonly number[] = [30_000, 60_000, 120_000];
/** Waits after a busy answer or an unknown outcome, before giving up. */
const NOTICE_RETRY_WAITS_MS: readonly number[] = [5_000, 10_000, 20_000];
/** A notice that takes effect sooner than this gets a warning in the check job. */
const NOTICE_LATE_SECONDS = 30 * 24 * 60 * 60;
const DIGEST = /^[0-9a-f]{64}$/;
const NOTICE_ID = new RegExp(NOTICE_ID_PATTERN);

interface NoticeInputs {
  readonly noticeId: string;
  readonly dryRun: boolean;
  readonly resendUnconfirmed: boolean;
  readonly maxSends: number;
}

const flag = (env: Deps["env"], name: string): boolean => {
  const value = env[name] ?? "";
  if (value !== "true" && value !== "false") throw new UsageError(`${name} must be true or false.`);
  return value === "true";
};

/** The dispatch's inputs, each checked before anything is read. */
function noticeInputs(env: Deps["env"]): NoticeInputs {
  const noticeId = required(env, "NOTICE_ID");
  if (!NOTICE_ID.test(noticeId)) throw new UsageError(`NOTICE_ID must match ${NOTICE_ID_PATTERN}.`);
  const dryRun = flag(env, "DRY_RUN");
  const resendUnconfirmed = flag(env, "RESEND_UNCONFIRMED");
  const raw = required(env, "MAX_SENDS");
  const maxSends = /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(maxSends >= 1 && maxSends <= MAX_SENDS_CEILING)) {
    throw new UsageError(`MAX_SENDS must be a whole number from 1 to ${MAX_SENDS_CEILING}.`);
  }
  return { noticeId, dryRun, resendUnconfirmed, maxSends };
}

interface ProductionNotice {
  readonly osnCommit: string;
  readonly notice: ChangeNotice;
  readonly digest: string;
}

/** The notice as production osn-api holds it: the registry at the commit it runs. */
async function productionNotice(deps: Deps, noticeId: string): Promise<ProductionNotice> {
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
  const osnCommit = commits.get("osn_api") ?? "";
  if (!SHA.test(osnCommit)) {
    throw new Refusal("No trusted production deployment record names osn_api's commit.");
  }
  const source = deps.gitShow(osnCommit, CHANGE_NOTICES_FILE);
  if (source === undefined) {
    throw new Refusal(
      `git cannot show ${CHANGE_NOTICES_FILE} at production osn-api's commit ${osnCommit}: release osn-api with the notice first.`,
    );
  }
  let notices: ReadonlyMap<string, ChangeNotice>;
  try {
    notices = parseChangeNotices(JSON.parse(source));
  } catch (error) {
    throw new Refusal(
      `${CHANGE_NOTICES_FILE} at ${osnCommit} does not parse (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  }
  const notice = notices.get(noticeId);
  if (notice === undefined) {
    throw new Refusal(
      `Production osn-api (${osnCommit}) holds no notice ${noticeId}: release osn-api with it first.`,
    );
  }
  return { osnCommit, notice, digest: await noticeDigest(notice) };
}

async function checkNotice(deps: Deps): Promise<void> {
  const inputs = noticeInputs(deps.env);
  const planned = await productionNotice(deps, inputs.noticeId);
  const { notice } = planned;
  const lines = [
    `Production osn-api runs ${planned.osnCommit}. The notice it would send, ${inputs.noticeId}:`,
    `  page: the ${notice.document}, at ${notice.path}`,
    `  takes effect: ${notice.takesEffect}`,
    "  what changes:",
    ...notice.changes.map((line) => `    - ${line}`),
    `  digest: ${planned.digest}`,
    inputs.dryRun
      ? "Approving counts the accounts it would reach, and sends nothing."
      : `Approving sends it to at most ${inputs.maxSends} accounts this run${inputs.resendUnconfirmed ? ", first sending again a batch whose outcome osn-api could not confirm: some in it may get the notice twice" : ""}.`,
  ];
  const ahead = takesEffectSeconds(notice) - deps.now();
  // The email says the changes "take effect on" the day: a day already past
  // needs a notice of its own, in words that hold.
  if (ahead <= 0) {
    throw new Refusal(
      `${inputs.noticeId} took effect on ${notice.takesEffect}: its email would announce a change already made. Add a notice with words and a day that hold, and send that.`,
    );
  }
  for (const line of lines) deps.out(line);
  if (ahead < NOTICE_LATE_SECONDS) {
    deps.out(
      `::warning::${inputs.noticeId} takes effect on ${notice.takesEffect}, under 30 days from now.`,
    );
  }
  const output = deps.env.GITHUB_OUTPUT ?? "";
  if (output !== "") {
    deps.appendFile(output, `osn_commit=${planned.osnCommit}\nnotice_digest=${planned.digest}\n`);
  }
  summary(deps, lines);
}

/** The counts and booleans a 200 from the route may hold, and nothing else. */
const NOTICE_COUNTS = new Set([
  "sent",
  "failed",
  "sentSoFar",
  "failedSoFar",
  "toSend",
  "skipped",
  "unconfirmed",
]);
const NOTICE_FLAGS = new Set(["ok", "dryRun", "finished"]);
/** The refusals the route answers with, by their fixed token. */
const NOTICE_ERRORS = new Set([
  "busy",
  "unconfirmed_batch",
  "pending_exceeds_limit",
  "notice_changed",
  "rate_limited",
  "refused",
  "unknown_outcome",
  "unknown_notice",
  "no_batch_transport",
  "bad_registry",
  "internal",
]);

/** One live call's body, as osn-api's route reads it. */
interface NoticeSendBody {
  readonly dryRun: false;
  readonly expect: string;
  readonly limit: number;
  resendUnconfirmed?: true;
}

type NoticeAnswer =
  | {
      readonly status: number;
      /** Every count and flag a 200 held, each checked; undefined for any other status or shape. */
      readonly counts: ReadonlyMap<string, number | boolean> | undefined;
      /** The refusal token, when the body held one this script knows. */
      readonly error: string | undefined;
      /** The `unconfirmed` or `pending` count a 409 carried. */
      readonly count: number | undefined;
      readonly mitigated: string | null;
    }
  | { readonly failed: string };

/** One call of the route. Keeps only checked counts, flags and a known token. */
async function noticeCall(
  deps: Deps,
  bearer: string,
  path: string,
  body: unknown,
): Promise<NoticeAnswer> {
  try {
    const response = await deps.fetch(`${OSN_API_ORIGIN}${path}`, {
      method: "POST",
      headers: osnApiHeaders(bearer, body),
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(OSN_TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => undefined);
    let counts: Map<string, number | boolean> | undefined;
    if (response.status === 200 && isRecord(answer) && answer.ok === true) {
      counts = new Map();
      for (const [key, value] of Object.entries(answer)) {
        if (NOTICE_FLAGS.has(key) && typeof value === "boolean") counts.set(key, value);
        else if (NOTICE_COUNTS.has(key) && isCount(value)) counts.set(key, value);
        else {
          counts = undefined;
          break;
        }
      }
    }
    const error = isRecord(answer) ? answer.error : undefined;
    const known = typeof error === "string" && NOTICE_ERRORS.has(error) ? error : undefined;
    const count = isRecord(answer)
      ? [answer.unconfirmed, answer.pending].find((value) => isCount(value))
      : undefined;
    return {
      status: response.status,
      counts,
      error: known,
      count: typeof count === "number" ? count : undefined,
      mitigated: mitigation(response.headers.get("cf-mitigated")),
    };
  } catch (error) {
    return { failed: error instanceof Error ? error.name : "unknown error" };
  }
}

/** A count the answer must hold. */
const countOf = (counts: ReadonlyMap<string, number | boolean>, key: string): number => {
  const value = counts.get(key);
  if (typeof value !== "number") {
    throw new Refusal(
      "osn-api answered in a form this script does not read; nothing from it is printed.",
    );
  }
  return value;
};

/** Why a refusal of the route stopped the run, by status and token. */
function noticeRefusal(answer: Exclude<NoticeAnswer, { readonly failed: string }>): string {
  if (answer.mitigated !== null) {
    return `Cloudflare answered in osn-api's place (${answer.mitigated === "" ? "cf-mitigated" : `cf-mitigated: ${answer.mitigated}`}); the request never reached osn-api.`;
  }
  switch (answer.error) {
    case "notice_changed":
      return "osn-api answered 409 notice_changed: the words it holds are not the words the approver saw. Nothing was sent. Dispatch again and read the check job's notice.";
    case "unknown_notice":
      return "osn-api answered 404 unknown_notice: release osn-api with the notice first.";
    case "pending_exceeds_limit":
      return `osn-api answered 409: the batch in hand holds ${answer.count ?? "more"} addresses, more than this run may still send. Dispatch again with max_sends of at least that many.`;
    case "unconfirmed_batch":
      return `osn-api answered 409 unconfirmed_batch: it cannot tell whether a batch of ${answer.count ?? "some"} addresses went. Nothing more was sent. To send that batch again, some of whom may get the notice twice, dispatch with resend_unconfirmed: true.`;
    case "refused":
      return "osn-api answered 502: Resend refused the batch. osn-api's log line `change notice batch not sent` holds Resend's status. Nothing in the batch was counted sent.";
    case "no_batch_transport":
      return "osn-api answered 501: its mail transport cannot send keyed batches.";
    case "bad_registry":
      return "osn-api answered 500 bad_registry: its change-notice registry does not parse.";
    default:
      break;
  }
  if (answer.status === 501) {
    return "osn-api answered 501: it holds no OSN_CHANGE_NOTICE_SECRET of at least 32 characters, so change notices are off.";
  }
  if (answer.status === 401) {
    return "osn-api answered 401: the production Environment's OSN_CHANGE_NOTICE_SECRET is not the value osn-api holds.";
  }
  if (answer.status >= 300 && answer.status < 400) {
    return `osn-api answered ${answer.status}, a redirect, which this script never follows with the bearer.`;
  }
  return `osn-api answered ${answer.status}. Nothing from the answer is printed.`;
}

async function sendChangeNotice(deps: Deps): Promise<void> {
  const bearer = required(deps.env, "OSN_CHANGE_NOTICE_SECRET");
  const inputs = noticeInputs(deps.env);
  const expectedCommit = required(deps.env, "EXPECTED_OSN_COMMIT");
  if (!SHA.test(expectedCommit))
    throw new UsageError("EXPECTED_OSN_COMMIT is not a full commit SHA.");
  const expected = required(deps.env, "EXPECTED_NOTICE_DIGEST");
  if (!DIGEST.test(expected))
    throw new UsageError("EXPECTED_NOTICE_DIGEST is not a SHA-256 digest.");
  const planned = await productionNotice(deps, inputs.noticeId);
  if (planned.osnCommit !== expectedCommit) {
    throw new Refusal(
      `Production osn-api now runs ${planned.osnCommit}, not ${expectedCommit}, which the check job read and the approver saw. Nothing was sent. Dispatch again.`,
    );
  }
  if (planned.digest !== expected) {
    throw new Refusal(
      "The notice's words at production osn-api's commit are not the words the check job showed. Nothing was sent. Dispatch again.",
    );
  }
  const path = `/internal/change-notices/${encodeURIComponent(inputs.noticeId)}/send`;

  if (inputs.dryRun) {
    const answer = await noticeCall(deps, bearer, path, { dryRun: true, expect: expected });
    if ("failed" in answer) throw new Refusal(`The dry run did not complete (${answer.failed}).`);
    if (answer.counts === undefined || answer.counts.get("dryRun") !== true) {
      throw new Refusal(
        answer.status === 200
          ? "osn-api answered in a form this script does not read; nothing from it is printed."
          : noticeRefusal(answer),
      );
    }
    const c = answer.counts;
    const lines = [
      `Dry run of ${inputs.noticeId}: nothing was sent.`,
      `  to send: ${countOf(c, "toSend")}`,
      `  skipped, their processing restricted: ${countOf(c, "skipped")}`,
      `  sent so far: ${countOf(c, "sentSoFar")}; refused by Resend so far: ${countOf(c, "failedSoFar")}`,
      `  in a batch osn-api could not confirm: ${countOf(c, "unconfirmed")}`,
      `  finished: ${c.get("finished") === true ? "yes" : "no"}`,
    ];
    for (const line of lines) deps.out(line);
    summary(deps, lines);
    return;
  }

  let sent = 0;
  let failed = 0;
  let first = true;
  let rateTries = 0;
  let retryTries = 0;
  let batches = 0;
  const report = (finished: boolean, sentSoFar: number, failedSoFar: number) => {
    const lines = [
      `${inputs.noticeId}: this run sent ${sent}, and Resend refused ${failed} addresses on their own.`,
      `In all: ${sentSoFar} sent, ${failedSoFar} refused.`,
      finished
        ? "Finished: every account in the audience has been passed."
        : "Not finished: dispatch again to go on.",
    ];
    for (const line of lines) deps.out(line);
    summary(deps, lines);
  };

  for (let call = 0; call < inputs.maxSends + NOTICE_BATCH; call += 1) {
    const room = inputs.maxSends - sent - failed;
    if (room < 1) {
      deps.out(`max_sends reached: ${sent + failed} addresses this run.`);
      report(false, sent, failed);
      return;
    }
    const body: NoticeSendBody = {
      dryRun: false,
      expect: expected,
      limit: Math.min(NOTICE_BATCH, room),
    };
    // The approval to send an unconfirmed batch again covers the one batch
    // the approver was told of: the first call's.
    if (first && inputs.resendUnconfirmed) body.resendUnconfirmed = true;
    // oxlint-disable-next-line no-await-in-loop -- each call resumes where the last stopped
    const answer = await noticeCall(deps, bearer, path, body);
    // Whatever it answered: a retry of a lost answer must not carry the flag
    // to a batch the approver was never told of.
    first = false;
    const unknown =
      "failed" in answer || answer.error === "unknown_outcome" || answer.error === "busy";
    if (unknown) {
      const wait = NOTICE_RETRY_WAITS_MS[retryTries];
      if (wait === undefined) {
        throw new Refusal(
          `osn-api could not confirm the batch in hand ${retryTries + 1} times (${"failed" in answer ? answer.failed : answer.error}). Nothing is lost: dispatch again within 23 hours, and the batch is retried under the key Resend dedupes on.`,
        );
      }
      retryTries += 1;
      // oxlint-disable-next-line no-await-in-loop -- a retry waits for the try before it
      await deps.sleep(wait);
      continue;
    }
    if (answer.error === "rate_limited" || answer.status === 429) {
      const wait = NOTICE_RATE_WAITS_MS[rateTries];
      if (wait === undefined) {
        report(false, sent, failed);
        throw new Refusal(
          "Resend refused for its rate limit or its quota four times. The run resumes where it stopped: dispatch again later, after the quota resets.",
        );
      }
      rateTries += 1;
      // oxlint-disable-next-line no-await-in-loop -- a retry waits for the try before it
      await deps.sleep(wait);
      continue;
    }
    if (answer.status !== 200 || answer.counts === undefined) {
      if (sent + failed > 0) report(false, sent, failed);
      throw new Refusal(
        answer.status === 200
          ? "osn-api answered in a form this script does not read; nothing from it is printed."
          : noticeRefusal(answer),
      );
    }
    rateTries = 0;
    retryTries = 0;
    const c = answer.counts;
    if (c.get("finished") === true) {
      report(true, countOf(c, "sentSoFar"), countOf(c, "failedSoFar"));
      return;
    }
    const batchSent = countOf(c, "sent");
    const batchFailed = countOf(c, "failed");
    sent += batchSent;
    failed += batchFailed;
    batches += 1;
    deps.out(
      `Batch ${batches}: ${batchSent} sent, ${batchFailed} refused by Resend; ${countOf(c, "sentSoFar")} sent in all.`,
    );
    // oxlint-disable-next-line no-await-in-loop -- one request a second, leaving Resend room for sign-in mail
    await deps.sleep(NOTICE_GAP_MS);
  }
  report(false, sent, failed);
  throw new Refusal("The run made more calls than max_sends allows for; dispatch again.");
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
  ["check-notice", checkNotice],
  ["send-change-notice", sendChangeNotice],
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
  // The reader sends GITHUB_TOKEN with every request; a redirect fails rather
  // than carrying it to another host.
  const noRedirect = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetchImpl(input, { ...init, redirect: "error" }),
    { preconnect: fetchImpl.preconnect },
  );
  const reader = restReader({
    fetch: noRedirect,
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
