#!/usr/bin/env bun
/**
 * One step of the domain move rehearsal
 * (.github/workflows/domain-move-rehearsal.yml): a host of the dev zone moves
 * from a throwaway Pages project to a Worker and back, through the same code
 * a flip release runs (scripts/pages-domain.ts's reach check, `locateHost`,
 * `detachHost` and `attachHost`; an Alchemy deploy that moves a Worker's
 * custom domain), and every step records what Cloudflare answered and when.
 *
 *   bun run scripts/domain-move-rehearsal.ts <step> --out <dir>
 *
 * Each step writes `<dir>/<step>.json`, its fragment, and rewrites it on every
 * event, so a step its job's timeout kills leaves what it saw. `report`
 * merges the fragments into `<dir>/domain-move-rehearsal.json`.
 *
 * Steps, in the order the workflow runs them:
 *   preflight      reach; the run's project absent and both hosts held by
 *                  nothing; then makes the run's Pages project
 *   pages-on       puts the moved host on the project (attachHost); waits for
 *                  the Pages marker and the domain's `active` status
 *   worker-staged  Alchemy deploy, REHEARSAL_MODE=staged; waits for the
 *                  Worker marker on the spare host
 *   wait-watch     waits until the watch job has been watching 45 s
 *   detach         detachHost: the moved host off the project, its CNAME gone
 *   flip           Alchemy deploy, REHEARSAL_MODE=worker; waits for the
 *                  Worker marker on the moved host
 *   check          classify: the moved host must read `free`, as a release's
 *                  precheck needs of a flipped host
 *   unflip         Alchemy deploy, REHEARSAL_MODE=staged; waits until the
 *                  moved host leaves the Worker and the spare is on it
 *   attach         attachHost: the moved host back on Pages; waits for the
 *                  Pages marker and the domain's `active` status
 *   destroy        Alchemy destroy; deletes by API whatever of the rehearsal
 *                  Worker it left, then destroys again
 *   cleanup        removes every rehearsal Pages project and its CNAMEs at
 *                  the two hosts, nothing else
 *   watch          probes both hosts every 2 s until the attach job completes
 *   report         merges the fragments and works out the intervals
 *
 * A step that waits pins one Cloudflare address of the dev zone, asked of the
 * zone's own name servers so no resolver cache sits between a write and the
 * pin, and probes over TLS to that address with SNI and Host set to the
 * probed host, so no cache decides a wait either. `watch` also asks the
 * runner's own resolver, as a visitor's browser would.
 *
 * Every step but destroy, cleanup and report refuses a re-run attempt: the
 * first attempt's cleanup removed what it would act on.
 *
 * Environment:
 *   DEV_DOMAIN             the dev zone (the dev Environment's variable)
 *   CLOUDFLARE_ACCOUNT_ID  the dev account
 *   CLOUDFLARE_API_TOKEN   every Cloudflare step: the dev deploy token, which
 *                          Alchemy and Wrangler read under the same name. The
 *                          Pages and DNS steps check its reach first, as
 *                          pages-domain.ts does: exactly the dev account and
 *                          the DEV_DOMAIN zone.
 *   GITHUB_TOKEN           wait-watch, watch: the job token
 *   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY  set by Actions
 * No token, account id or 32-hex id reaches a fragment or a message.
 *
 * Imports only node built-ins and the repository's import-free files, so a
 * step runs with nothing installed, as a flip release's detach and attach do.
 *
 * Exit codes: 0 done; 1 refused, Cloudflare failed, or what the step waits
 * for did not come in time; 2 a usage error, before any request.
 */

import { spawn } from "node:child_process";
import { lookup, Resolver, resolveNs } from "node:dns/promises";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from "node:tls";

import {
  REHEARSAL_MARKERS,
  REHEARSAL_PROJECT_PREFIX,
  REHEARSAL_WORKER,
  RehearsalNameError,
  type RehearsalHosts,
  type RehearsalMode,
  rehearsalHosts,
  rehearsalProject,
} from "../shared/infra/rehearsal/names";
import {
  ApiError,
  attachHost,
  decides,
  detachHost,
  locateHost,
  type ObservedAttempt,
  type PagesDnsApi,
  pagesDnsApi,
} from "./pages-domain";
import { CI_USER_AGENT } from "./smoke-check";

/** The watch job's and the attach job's `name:` in the workflow; the waits find them by it. */
export const WATCH_JOB_NAME = "Watch the moved host";
export const ATTACH_JOB_NAME = "Put the host back on Pages";

export const PROBE_INTERVAL_MS = 2_000;
export const PIN_TIMEOUT_MS = 120_000;
export const WORKER_WAIT_MS = 15 * 60_000;
export const PAGES_WAIT_MS = 20 * 60_000;
/** Three reads every 6 s: 150 every 5 minutes, an eighth of the API's 1,200 a token. */
export const ALCHEMY_POLL_MS = 6_000;
export const WATCH_CAP_MS = 120 * 60_000;
export const WATCH_JOBS_EVERY_MS = 20_000;
export const WAIT_WATCH_MARGIN_MS = 45_000;
export const WAIT_WATCH_CAP_MS = 5 * 60_000;
export const WAIT_WATCH_POLL_MS = 5_000;
export const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 64 * 1024;
const ALCHEMY_LOG_LINES = 40;
/** How many probe rounds pass between reads of the Pages domain's status. */
const PAGES_STATUS_EVERY = 5;

const STEPS = [
  "preflight",
  "pages-on",
  "worker-staged",
  "wait-watch",
  "detach",
  "flip",
  "check",
  "unflip",
  "attach",
  "destroy",
  "cleanup",
  "watch",
  "report",
] as const;
export type Step = (typeof STEPS)[number];

const isStep = (value: string): value is Step => STEPS.some((step) => step === value);

/**
 * The env name each step reads its token from; report holds none. Every
 * Cloudflare step holds the dev deploy token, the one Alchemy reads.
 */
const TOKEN_OF = {
  preflight: "CLOUDFLARE_API_TOKEN",
  "pages-on": "CLOUDFLARE_API_TOKEN",
  "worker-staged": "CLOUDFLARE_API_TOKEN",
  "wait-watch": "GITHUB_TOKEN",
  detach: "CLOUDFLARE_API_TOKEN",
  flip: "CLOUDFLARE_API_TOKEN",
  check: "CLOUDFLARE_API_TOKEN",
  unflip: "CLOUDFLARE_API_TOKEN",
  attach: "CLOUDFLARE_API_TOKEN",
  destroy: "CLOUDFLARE_API_TOKEN",
  cleanup: "CLOUDFLARE_API_TOKEN",
  watch: "GITHUB_TOKEN",
  report: "",
} as const satisfies Readonly<Record<Step, string>>;

/** The env names of every token a step may hold, all redacted from what it records. */
const TOKEN_NAMES = ["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN"] as const;

/** Steps that may run on a re-run attempt: each finishes or reads what an earlier attempt left. */
const ANY_ATTEMPT: ReadonlySet<Step> = new Set(["destroy", "cleanup", "report"]);

/** Steps that act on the run's own Pages project. */
const PROJECT_STEPS: ReadonlySet<Step> = new Set(["preflight", "pages-on", "detach", "attach"]);

export type ProbeOutcome = "pages" | "worker" | "other" | "error";

export interface ProbeResult {
  readonly outcome: ProbeOutcome;
  readonly status?: number;
  readonly error?: string;
}

/** The parts of a TLS socket the edge probe uses. */
export interface EdgeSocket {
  readonly authorized: boolean;
  readonly authorizationError?: Error;
  getPeerCertificate(): PeerCertificate;
  on(event: "secureConnect" | "end" | "close", handler: () => void): EdgeSocket;
  on(event: "data", handler: (chunk: Buffer) => void): EdgeSocket;
  on(event: "error", handler: (error: Error & { readonly code?: string }) => void): EdgeSocket;
  write(text: string): boolean;
  destroy(): EdgeSocket;
}

export type AlchemyScript = "rehearsal:deploy" | "rehearsal:destroy";

export interface AlchemyRun {
  readonly exitCode: number;
  readonly log: string;
}

export interface RehearsalDns {
  /** The zone's name servers, through the system resolver. */
  resolveNs(zone: string): Promise<readonly string[]>;
  /** One IPv4 address of `name`, through the system resolver. */
  lookup4(name: string): Promise<string>;
  /** The IPv4 addresses `servers` answer for `name`, asked directly. */
  resolveAt(servers: readonly string[], name: string): Promise<readonly string[]>;
  /** `resolves`, or the error code, as the system resolver answers `name` now. */
  lookupSystem(name: string): Promise<string>;
}

export interface RehearsalInput {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly probe: (address: string, host: string) => Promise<ProbeResult>;
  readonly dns: RehearsalDns;
  readonly runAlchemy: (
    script: AlchemyScript,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<AlchemyRun>;
  readonly writeFile: (path: string, text: string) => void;
  /** The fragment files in a directory, by file name. */
  readonly readDir: (dir: string) => Readonly<Record<string, string>>;
}

// ── The edge probe ────────────────────────────────────────────────────────

const cut = (text: string, max = 200): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Which marker a page holds, if one. */
function markerOf(body: string): "pages" | "worker" | null {
  if (body.includes(REHEARSAL_MARKERS.worker)) return "worker";
  if (body.includes(REHEARSAL_MARKERS.pages)) return "pages";
  return null;
}

/**
 * Asks `host` for `/` over TLS at `address`, with SNI and Host the host,
 * following no redirect. The certificate must be trusted and name the host,
 * checked here whatever the TLS layer does with an address for `host`.
 */
export function edgeProbe(input: {
  readonly connect: (options: {
    readonly host: string;
    readonly port: number;
    readonly servername: string;
  }) => EdgeSocket;
  readonly checkIdentity?: typeof checkServerIdentity;
  readonly address: string;
  readonly host: string;
  readonly timeoutMs?: number;
}): Promise<ProbeResult> {
  const checkIdentity = input.checkIdentity ?? checkServerIdentity;
  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    let socket: EdgeSocket | undefined;
    const failure = (code: string, message: string): ProbeResult => ({
      outcome: "error",
      error: cut(`${code}: ${message}`),
    });
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(failure("TIMEOUT", "no whole answer in time")),
      input.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    const answered = () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1] ?? Number.NaN);
      if (!Number.isInteger(status)) {
        finish(failure("NO_HTTP", cut(received.split("\r\n")[0] ?? "", 80) || "an empty answer"));
        return;
      }
      const body = received.slice(received.indexOf("\r\n\r\n") + 4);
      const marker = status === 200 ? markerOf(body) : null;
      finish({ outcome: marker ?? "other", status });
    };
    try {
      socket = input.connect({ host: input.address, port: 443, servername: input.host });
    } catch (error) {
      finish(failure("CONNECT", error instanceof Error ? error.message : String(error)));
      return;
    }
    const open = socket;
    open.on("secureConnect", () => {
      if (!open.authorized) {
        finish(failure("UNAUTHORIZED", open.authorizationError?.message ?? "untrusted"));
        return;
      }
      const identity = checkIdentity(input.host, open.getPeerCertificate());
      if (identity !== undefined) {
        const { code } = identity as Error & { readonly code?: string };
        finish(failure(code ?? "IDENTITY", identity.message));
        return;
      }
      open.write(
        `GET / HTTP/1.1\r\nHost: ${input.host}\r\nUser-Agent: ${CI_USER_AGENT}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`,
      );
    });
    open.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (received.length >= PROBE_MAX_BYTES) answered();
    });
    open.on("end", () => answered());
    open.on("close", () => {
      if (received === "") finish(failure("CLOSED", "the connection closed with no answer"));
      else answered();
    });
    open.on("error", (error) => finish(failure(error.code ?? "ERROR", error.message)));
  });
}

// ── What is recorded ──────────────────────────────────────────────────────

/** A JSON value, as the fragments hold it. */
export type Json = string | number | boolean | null | readonly Json[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: Json;
}

/** `value` as JSON: what JSON.stringify would keep of it. */
function asJson(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, asJson(item)]));
  }
  return null;
}

/** Replaces every secret and every 32-hex id in `text`. */
function redactText(text: string, secrets: readonly string[]): string {
  const hidden = secrets
    .filter((secret) => secret.length >= 4)
    .reduce((current, secret) => current.split(secret).join("<secret>"), text);
  return hidden.replace(/[0-9a-f]{32}/gi, "<id>");
}

/** `value` with `change` applied to every string in it, keys left as they are. */
function mapStrings(value: Json, change: (text: string) => string): Json {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item: Json) => mapStrings(item, change));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)]),
    );
  }
  return value;
}

/** Keys kept from an answer no special case covers, at any depth. */
const KEPT: ReadonlySet<string> = new Set([
  "name",
  "type",
  "content",
  "proxied",
  "ttl",
  "subdomain",
  "domains",
  "production_branch",
  "status",
  "method",
  "validation_data",
  "verification_data",
  "certificate_authority",
  "hostname",
  "service",
  "environment",
  "zone_name",
  "created_on",
]);

function allowList(value: Json): Json {
  if (Array.isArray(value)) return value.map(allowList);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => KEPT.has(key))
        .map(([key, item]) => [key, allowList(item)]),
    );
  }
  return value;
}

const isJsonObject = (item: Json): item is JsonObject =>
  item !== null && typeof item === "object" && !Array.isArray(item);

const fieldOf = (item: Json, key: string): Json =>
  isJsonObject(item) ? (item[key] ?? null) : null;

/**
 * What the artifact keeps of an answer's `result`. A DNS record list, a DNS
 * record made, and a Worker custom-domain list are kept whole: their shape is
 * what the rehearsal is for. The account and zone listings keep only what
 * the reach check judges; everything else passes the KEPT keys alone, which
 * leave out account names, zone owners, name servers and a Pages project's
 * settings.
 */
function projectResult(path: string, result: Json, account: string): Json {
  const bare = path.split("?")[0] ?? "";
  if (bare.endsWith("/dns_records") || bare.endsWith("/workers/domains")) return result;
  const items = Array.isArray(result) ? (result as readonly Json[]) : [];
  if (bare === "/accounts") {
    return {
      count: items.length,
      isTheAccount: items.length === 1 && fieldOf(items[0] ?? null, "id") === account,
    };
  }
  if (bare === "/zones") {
    const inAccount = items.filter((zone) => fieldOf(fieldOf(zone, "account"), "id") === account);
    return {
      inTheAccount: inAccount.map((zone) => ({
        name: fieldOf(zone, "name"),
        status: fieldOf(zone, "status"),
      })),
      // Another account's zone is counted, never named.
      outsideTheAccount: items.length - inAccount.length,
    };
  }
  return allowList(result);
}

/** The names of the zones in a `GET /zones` answer that belong to another account than `account`. */
function foreignZoneNames(path: string, body: Json, account: string): string[] {
  if ((path.split("?")[0] ?? "") !== "/zones") return [];
  const result = fieldOf(body, "result");
  const items = Array.isArray(result) ? (result as readonly Json[]) : [];
  return items.flatMap((zone) => {
    const name = fieldOf(zone, "name");
    return fieldOf(fieldOf(zone, "account"), "id") !== account && typeof name === "string"
      ? [name]
      : [];
  });
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each of `names` where it stands as a whole host name in `text`. */
function withholdNames(text: string, names: readonly string[]): string {
  return names.reduce(
    (current, name) =>
      current.replace(
        new RegExp(`(?<![A-Za-z0-9.-])${escapeRegExp(name)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, "g"),
        "<another account's zone>",
      ),
    text,
  );
}

interface CallEntry {
  readonly method: string;
  readonly path: string;
  readonly what: string;
  readonly status: number | null;
  readonly success: Json;
  readonly errors: Json;
  readonly result: Json;
  readonly ms: number;
  readonly at: string;
  last: string;
  repeats: number;
}

interface TimelineEntry {
  readonly view: "edge" | "dns";
  readonly host: string;
  readonly outcome: string;
  readonly status?: number;
  readonly error?: string;
  readonly first: string;
  last: string;
  count: number;
}

interface FragmentBody {
  readonly step: Step;
  readonly attempt: string;
  readonly hosts: RehearsalHosts;
  readonly startedAt: string;
  endedAt?: string;
  exitCode?: number;
  message?: string;
  edgeAddress?: string;
  readonly calls: CallEntry[];
  readonly timeline: TimelineEntry[];
  readonly events: Record<string, string | number>;
  state?: Json;
  alchemyLogTail?: string;
}

class Recorder {
  readonly #path: string;
  readonly #write: (path: string, text: string) => void;
  readonly #now: () => number;
  readonly #secrets: readonly string[];
  readonly #account: string;
  readonly fragment: FragmentBody;

  constructor(input: {
    readonly step: Step;
    readonly attempt: string;
    readonly hosts: RehearsalHosts;
    readonly path: string;
    readonly write: (path: string, text: string) => void;
    readonly now: () => number;
    readonly secrets: readonly string[];
    readonly account: string;
  }) {
    this.#path = input.path;
    this.#write = input.write;
    this.#now = input.now;
    this.#secrets = input.secrets;
    this.#account = input.account;
    this.fragment = {
      step: input.step,
      attempt: input.attempt,
      hosts: input.hosts,
      startedAt: this.iso(),
      calls: [],
      timeline: [],
      events: {},
    };
  }

  iso(at: number = this.#now()): string {
    return new Date(at).toISOString();
  }

  /**
   * `text` with every secret and 32-hex id replaced, and every zone name a
   * `GET /zones` answer showed in another account withheld: a token with the
   * wrong reach must not publish the names of zones it should not see.
   */
  redact(text: string): string {
    return withholdNames(redactText(text, this.#secrets), this.#foreignZones);
  }

  readonly #foreignZones: string[] = [];

  /** One attempt at a Cloudflare call; the same answer again to the same path counts on the last entry. */
  call(attempt: ObservedAttempt): void {
    const body = asJson(attempt.body);
    for (const name of foreignZoneNames(attempt.path, body, this.#account)) {
      if (!this.#foreignZones.includes(name)) this.#foreignZones.push(name);
    }
    const field = (key: string) => this.#scrub(fieldOf(body, key));
    const entry = {
      method: attempt.method,
      path: this.redact(attempt.path),
      what: this.redact(attempt.what),
      status: attempt.status,
      success: field("success"),
      errors: field("errors"),
      result: this.#scrub(projectResult(attempt.path, fieldOf(body, "result"), this.#account)),
    };
    const at = this.iso();
    // A poll reads several paths in turn, so a repeat is matched against the
    // last answer to the same request, not the last answer recorded.
    const last = this.fragment.calls.findLast(
      (held) => held.method === entry.method && held.path === entry.path,
    );
    if (
      last !== undefined &&
      JSON.stringify([last.status, last.success, last.errors, last.result]) ===
        JSON.stringify([entry.status, entry.success, entry.errors, entry.result])
    ) {
      last.repeats += 1;
      last.last = at;
    } else {
      this.fragment.calls.push({ ...entry, ms: attempt.ms, at, last: at, repeats: 0 });
    }
    this.flush();
  }

  #scrub(value: Json): Json {
    return mapStrings(value, (text) => this.redact(text));
  }

  /** One probe or lookup; the same outcome as the host's last one in this view extends that run. */
  sample(view: "edge" | "dns", host: string, result: ProbeResult | string): void {
    const at = this.iso();
    const outcome = typeof result === "string" ? result : result.outcome;
    const status = typeof result === "string" ? undefined : result.status;
    const error =
      typeof result === "string" || result.error === undefined
        ? undefined
        : this.redact(result.error);
    const previous = this.fragment.timeline.findLast(
      (held) => held.view === view && held.host === host,
    );
    if (
      previous !== undefined &&
      previous.outcome === outcome &&
      previous.status === status &&
      previous.error === error
    ) {
      previous.last = at;
      previous.count += 1;
    } else {
      const entry: TimelineEntry = { view, host, outcome, first: at, last: at, count: 1 };
      const withStatus = status === undefined ? entry : { ...entry, status };
      this.fragment.timeline.push(error === undefined ? withStatus : { ...withStatus, error });
    }
    this.flush();
  }

  event(name: string, value: string | number = this.iso()): void {
    this.fragment.events[name] = value;
    this.flush();
  }

  /** Records `name` the first time only. */
  once(name: string): void {
    if (this.fragment.events[name] === undefined) this.event(name);
  }

  flush(): void {
    this.#write(this.#path, `${JSON.stringify(this.fragment, null, 2)}\n`);
  }
}

// ── The steps ─────────────────────────────────────────────────────────────

class Refusal extends Error {}

interface Context {
  readonly input: RehearsalInput;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hosts: RehearsalHosts;
  readonly account: string;
  /**
   * The Cloudflare client, holding the step's Cloudflare token; on a step
   * that holds the GitHub token instead it holds no token at all, so no edit
   * can send the GitHub token to Cloudflare.
   */
  readonly api: PagesDnsApi;
  /** The job token, on wait-watch and watch alone: sent only to api.github.com. */
  readonly githubToken: string;
  readonly record: Recorder;
}

interface StepResult {
  readonly ok: boolean;
  readonly message: string;
}

const accountPath = (ctx: Context) => `/accounts/${encodeURIComponent(ctx.account)}`;
const bothHosts = (ctx: Context): readonly string[] => [ctx.hosts.host, ctx.hosts.spare];

/**
 * Runs `tick` now, then every `intervalMs` (or sooner once `wake` settles),
 * until it returns a value or the clock passes `deadline`; returns that
 * value, or undefined at the deadline. Each round is one wait, so no round
 * waits on a request of another.
 */
async function until<T>(
  ctx: Context,
  intervalMs: number,
  deadline: number,
  tick: () => Promise<T | undefined>,
  wake?: Promise<unknown>,
): Promise<T | undefined> {
  const value = await tick();
  if (value !== undefined || ctx.input.now() >= deadline) return value;
  await (wake === undefined
    ? ctx.input.sleep(intervalMs)
    : Promise.race([ctx.input.sleep(intervalMs), wake]));
  return until(ctx, intervalMs, deadline, tick, wake);
}

/** The token's reach (exactly the dev account and zone), its projects, and where `host` is. */
async function readHost(ctx: Context, host: string) {
  const zones = await ctx.api.reach([ctx.hosts.zone]);
  const projects = await ctx.api.projects();
  const located = await locateHost(ctx.api, zones, ctx.hosts.zone, host, projects);
  return { zones, projects, located };
}

/** Runs `read`, recording a Cloudflare failure (its observer already has) as null. */
async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (failure) {
    if (failure instanceof ApiError) return null;
    throw failure;
  }
}

/** The zone's id, read with a deploy token; null when it cannot be read. */
async function zoneId(ctx: Context): Promise<string | null> {
  const listed = await readOrNull(() =>
    ctx.api.call(
      "GET",
      `/zones?name=${encodeURIComponent(ctx.hosts.zone)}`,
      "finding the dev zone",
    ),
  );
  const id = fieldOf(Array.isArray(listed?.result) ? asJson(listed.result[0]) : null, "id");
  return typeof id === "string" ? id : null;
}

/** The IPv4 addresses of the dev zone's name servers; none when they cannot be found. */
async function nameServers(ctx: Context): Promise<string[]> {
  const { dns } = ctx.input;
  const named = await dns.resolveNs(ctx.hosts.zone).catch((): readonly string[] => []);
  const found = await Promise.all(named.map((name) => dns.lookup4(name).catch(() => "")));
  return found.filter((address) => address !== "");
}

/**
 * Pins one address of the dev zone's edge: asks the zone's own name servers
 * for each of `names`, every 2 s, until one has an address. Throws Refusal
 * when none does in time.
 */
async function pin(ctx: Context, names: readonly string[]): Promise<string> {
  let servers: string[] = [];
  const found = await until(ctx, PROBE_INTERVAL_MS, ctx.input.now() + PIN_TIMEOUT_MS, async () => {
    if (servers.length === 0) servers = await nameServers(ctx);
    if (servers.length === 0) return undefined;
    const answers = await Promise.all(
      names.map((name) =>
        ctx.input.dns.resolveAt(servers, name).catch((): readonly string[] => []),
      ),
    );
    const index = answers.findIndex((answer) => answer.length > 0);
    const address = answers[index]?.[0];
    return address === undefined ? undefined : { name: names[index] ?? "", address };
  });
  if (found === undefined) {
    throw new Refusal(
      `neither ${names.join(" nor ")} has an address at the dev zone's name servers${servers.length === 0 ? " (none answered)" : ""}; there is no edge to probe.`,
    );
  }
  ctx.record.fragment.edgeAddress = found.address;
  ctx.record.event("pinnedFrom", found.name);
  return found.address;
}

async function probeAt(ctx: Context, address: string, host: string): Promise<ProbeResult> {
  const result = await ctx.input.probe(address, host);
  ctx.record.sample("edge", host, result);
  return result;
}

/** The Pages domain's status, recorded; null when it cannot be read. */
async function pagesDomainStatus(ctx: Context, project: string): Promise<string | null> {
  const read = await readOrNull(() =>
    ctx.api.call(
      "GET",
      `${accountPath(ctx)}/pages/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(ctx.hosts.host)}`,
      `reading ${ctx.hosts.host}'s Pages domain`,
    ),
  );
  const status = fieldOf(asJson(read?.result ?? null), "status");
  return typeof status === "string" ? status : null;
}

/**
 * Probes until the moved host answers the Pages marker and its Pages domain
 * reads `active`, or PAGES_WAIT_MS. True when the marker answered.
 */
async function waitForPages(ctx: Context, address: string, project: string): Promise<boolean> {
  let answered = false;
  let active = false;
  let rounds = 0;
  await until(ctx, PROBE_INTERVAL_MS, ctx.input.now() + PAGES_WAIT_MS, async () => {
    const readStatus = !active && rounds % PAGES_STATUS_EVERY === 0;
    rounds += 1;
    const [result, status] = await Promise.all([
      answered ? null : probeAt(ctx, address, ctx.hosts.host),
      readStatus ? pagesDomainStatus(ctx, project) : null,
    ]);
    if (result?.outcome === "pages") {
      answered = true;
      ctx.record.once("firstPagesAnswerAt");
    }
    if (status === "active") {
      active = true;
      ctx.record.once("pagesDomainActiveAt");
    }
    return answered && active ? true : undefined;
  });
  return answered;
}

/** Probes both hosts until `done` holds of their answers, or WORKER_WAIT_MS. */
async function waitForWorker(
  ctx: Context,
  address: string,
  done: (host: ProbeResult, spare: ProbeResult) => boolean,
): Promise<boolean> {
  const met = await until(ctx, PROBE_INTERVAL_MS, ctx.input.now() + WORKER_WAIT_MS, async () => {
    const [host, spare] = await Promise.all([
      probeAt(ctx, address, ctx.hosts.host),
      probeAt(ctx, address, ctx.hosts.spare),
    ]);
    if (host.outcome === "worker") {
      ctx.record.once("firstWorkerAnswerAt");
      ctx.record.event("lastWorkerAnswerAt");
    }
    if (spare.outcome === "worker") ctx.record.once("firstSpareWorkerAnswerAt");
    return done(host, spare) ? true : undefined;
  });
  return met === true;
}

/** The Worker custom domains listed for `host`; null when they cannot be read. */
async function workerDomainsAt(ctx: Context, host: string): Promise<readonly Json[] | null> {
  const listed = await readOrNull(() =>
    ctx.api.call(
      "GET",
      `${accountPath(ctx)}/workers/domains?hostname=${encodeURIComponent(host)}`,
      `listing ${host}'s Worker custom domains`,
    ),
  );
  const result = asJson(listed?.result ?? null);
  return listed === null ? null : Array.isArray(result) ? (result as readonly Json[]) : [];
}

/** Reads the Worker custom domains and DNS records at both hosts; a failure is recorded and passed over. */
async function pollWorker(ctx: Context, zone: string | null, mode: RehearsalMode): Promise<void> {
  const target = mode === "worker" ? ctx.hosts.host : ctx.hosts.spare;
  // Three reads a round, each sent once: a poll that meets a 429 waits for
  // its next round rather than adding retries to a limit already met.
  const once = { retry: false } as const;
  const [listed] = await Promise.all([
    readOrNull(() =>
      ctx.api.call(
        "GET",
        `${accountPath(ctx)}/workers/domains?service=${REHEARSAL_WORKER}`,
        `listing ${REHEARSAL_WORKER}'s custom domains`,
        undefined,
        once,
      ),
    ),
    ...(zone === null
      ? []
      : bothHosts(ctx).map((host) =>
          readOrNull(() =>
            ctx.api.call(
              "GET",
              `/zones/${encodeURIComponent(zone)}/dns_records?name=${encodeURIComponent(host)}`,
              `listing ${host}'s DNS records`,
              undefined,
              once,
            ),
          ),
        )),
  ]);
  const held = asJson(listed?.result ?? null);
  if (
    Array.isArray(held) &&
    (held as readonly Json[]).some((item) => fieldOf(item, "hostname") === target)
  ) {
    ctx.record.once("workerDomainListedAt");
  }
}

/** Runs one Alchemy script, polling what Cloudflare shows while a deploy runs. */
async function alchemy(ctx: Context, script: AlchemyScript, mode: RehearsalMode): Promise<number> {
  const deploying = script === "rehearsal:deploy";
  const zone = deploying ? await zoneId(ctx) : null;
  ctx.record.event(deploying ? "alchemyStartedAt" : "destroyStartedAt");
  let finished: AlchemyRun | undefined;
  const running = ctx.input.runAlchemy(script, { ...ctx.env, REHEARSAL_MODE: mode }).then((run) => {
    finished = run;
    if (deploying) ctx.record.event("alchemyEndedAt");
    return run;
  });
  await until(
    ctx,
    ALCHEMY_POLL_MS,
    Number.POSITIVE_INFINITY,
    async () => {
      if (deploying) await pollWorker(ctx, zone, mode);
      return finished === undefined ? undefined : true;
    },
    running,
  );
  const run = await running;
  ctx.record.event(deploying ? "alchemyExitCode" : "destroyExitCode", run.exitCode);
  if (deploying) await pollWorker(ctx, zone, mode);
  if (run.exitCode !== 0) {
    const tail = ctx.record.redact(run.log.split("\n").slice(-ALCHEMY_LOG_LINES).join("\n"));
    ctx.record.fragment.alchemyLogTail = tail;
    ctx.record.flush();
    ctx.input.out(`Alchemy's ${script} failed (exit ${run.exitCode}). Its last lines:\n${tail}\n`);
  }
  return run.exitCode;
}

async function preflight(ctx: Context, project: string): Promise<StepResult> {
  const zones = await ctx.api.reach([ctx.hosts.zone]);
  const projects = await ctx.api.projects();
  if (projects.some((held) => held.name === project)) {
    return {
      ok: false,
      message: `The Pages project ${project} already exists; dispatch a new run.`,
    };
  }
  const located = await Promise.all(
    bothHosts(ctx).map((host) => locateHost(ctx.api, zones, ctx.hosts.zone, host, projects)),
  );
  const listedOn = located.flatMap(({ host }) =>
    projects
      .filter((listing) => listing.domains.includes(host))
      .map((listing) => `${host} on the Pages project ${listing.name}`),
  );
  const routed = located.flatMap(({ host, records }) =>
    records
      .filter((record) => decides(host, record))
      .map((record) => `a ${record.type} record at ${host}`),
  );
  const held = listedOn.concat(routed);
  if (held.length > 0) {
    return {
      ok: false,
      message: `Held already: ${held.join(", ")}. The cleanup jobs remove what an earlier rehearsal left; then dispatch again.`,
    };
  }
  const made = await ctx.api.call(
    "POST",
    `${accountPath(ctx)}/pages/projects`,
    `creating the Pages project ${project}`,
    { name: project, production_branch: "main" },
  );
  const subdomain = fieldOf(asJson(made.result ?? null), "subdomain");
  if (subdomain !== `${project}.pages.dev`) {
    return {
      ok: false,
      message: `Cloudflare gave ${project} the subdomain ${String(subdomain)}, not ${project}.pages.dev, which pages-domain.ts points a host at; the cleanup job removes it.`,
    };
  }
  return { ok: true, message: `Made the Pages project ${project}; both hosts are free.` };
}

/** Puts the moved host on `project` and waits for Pages to serve it, pinning from `names`. */
async function putOnPages(
  ctx: Context,
  project: string,
  names: readonly string[],
): Promise<StepResult> {
  const { projects, located } = await readHost(ctx, ctx.hosts.host);
  const moved = await attachHost(ctx.api, located, projects, project);
  if (!moved.ok) return moved;
  ctx.record.event("attachedAt");
  const address = await pin(ctx, names);
  const served = await waitForPages(ctx, address, project);
  return served
    ? { ok: true, message: `${moved.message} ${ctx.hosts.host} serves the Pages marker.` }
    : {
        ok: false,
        message: `${ctx.hosts.host} did not serve the Pages marker within ${PAGES_WAIT_MS / 60_000} minutes.`,
      };
}

async function workerStaged(ctx: Context): Promise<StepResult> {
  const exit = await alchemy(ctx, "rehearsal:deploy", "staged");
  if (exit !== 0) return { ok: false, message: "Alchemy's deploy failed." };
  const address = await pin(ctx, [ctx.hosts.spare, ctx.hosts.host]);
  const served = await waitForWorker(ctx, address, (_host, spare) => spare.outcome === "worker");
  return served
    ? { ok: true, message: `The Worker serves ${ctx.hosts.spare}.` }
    : { ok: false, message: `${ctx.hosts.spare} did not serve the Worker marker in time.` };
}

interface Job {
  readonly name?: string;
  readonly status?: string;
  readonly started_at?: string | null;
}

/** This run attempt's jobs, or null when GitHub did not answer. */
async function runJobs(ctx: Context): Promise<readonly Job[] | null> {
  const { env } = ctx;
  if (ctx.githubToken === "") return null;
  const path = `/repos/${env.GITHUB_REPOSITORY ?? ""}/actions/runs/${env.GITHUB_RUN_ID ?? ""}/attempts/${env.GITHUB_RUN_ATTEMPT ?? "1"}/jobs?per_page=100`;
  try {
    const response = await ctx.input.fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${ctx.githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": CI_USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      ctx.record.event("lastGithubFailure", `${response.status}`);
      return null;
    }
    const body = (await response.json()) as { readonly jobs?: readonly Job[] };
    return Array.isArray(body.jobs) ? body.jobs : null;
  } catch {
    ctx.record.event("lastGithubFailure", "no answer");
    return null;
  }
}

async function waitWatch(ctx: Context): Promise<StepResult> {
  const ready = await until(
    ctx,
    WAIT_WATCH_POLL_MS,
    ctx.input.now() + WAIT_WATCH_CAP_MS,
    async () => {
      const watcher = (await runJobs(ctx))?.find((job) => job.name === WATCH_JOB_NAME);
      const started = Date.parse(watcher?.started_at ?? "");
      return watcher?.status === "in_progress" && ctx.input.now() >= started + WAIT_WATCH_MARGIN_MS
        ? true
        : undefined;
    },
  );
  return {
    ok: true,
    message:
      ready === true
        ? "The watch job is watching; the detach goes ahead."
        : `The watch job was not watching by the ${WAIT_WATCH_CAP_MS / 60_000}-minute cap; the detach goes ahead, and the report takes the gap's start from it.`,
  };
}

async function detachStep(ctx: Context, project: string): Promise<StepResult> {
  const { located } = await readHost(ctx, ctx.hosts.host);
  const moved = await detachHost(ctx.api, located, project);
  if (moved.ok) ctx.record.event("detachedAt");
  return moved;
}

const DEPLOY_FAILED =
  "Alchemy's deploy failed before Cloudflare listed the Worker's custom domain where it was going; nothing moved, so nothing was waited for.";

/**
 * Whether a deploy failed and Cloudflare never listed the Worker's domain
 * where the mode puts it: then the domain did not move, and a wait would
 * only hold the host dark and the runners busy for the full wait.
 */
const deployMovedNothing = (ctx: Context, exit: number): boolean =>
  exit !== 0 && ctx.record.fragment.events.workerDomainListedAt === undefined;

async function flip(ctx: Context): Promise<StepResult> {
  const address = await pin(ctx, [ctx.hosts.spare, ctx.hosts.host]);
  await probeAt(ctx, address, ctx.hosts.host);
  const exit = await alchemy(ctx, "rehearsal:deploy", "worker");
  if (deployMovedNothing(ctx, exit)) return { ok: false, message: DEPLOY_FAILED };
  const served = await waitForWorker(ctx, address, (host) => host.outcome === "worker");
  if (exit !== 0) return { ok: false, message: "Alchemy's deploy failed." };
  return served
    ? { ok: true, message: `The Worker serves ${ctx.hosts.host}.` }
    : {
        ok: false,
        message: `${ctx.hosts.host} did not serve the Worker marker within ${WORKER_WAIT_MS / 60_000} minutes.`,
      };
}

async function check(ctx: Context): Promise<StepResult> {
  const { located } = await readHost(ctx, ctx.hosts.host);
  ctx.record.fragment.state = asJson(located.state);
  ctx.record.flush();
  const { state } = located;
  return state.kind === "free"
    ? {
        ok: true,
        message: `${ctx.hosts.host} reads free: a release's precheck passes a flipped host.`,
      }
    : {
        ok: false,
        message: `${ctx.hosts.host} reads ${state.kind}${state.kind === "unclear" ? ` (${state.reason})` : ""}: a release's precheck would refuse a flipped host. The fragment holds the records.`,
      };
}

async function unflip(ctx: Context): Promise<StepResult> {
  const address = await pin(ctx, [ctx.hosts.host, ctx.hosts.spare]);
  const exit = await alchemy(ctx, "rehearsal:deploy", "staged");
  if (deployMovedNothing(ctx, exit)) return { ok: false, message: DEPLOY_FAILED };
  const left = await waitForWorker(
    ctx,
    address,
    (host, spare) => host.outcome !== "worker" && spare.outcome === "worker",
  );
  if (exit !== 0) return { ok: false, message: "Alchemy's deploy failed." };
  return left
    ? {
        ok: true,
        message: `${ctx.hosts.host} left the Worker, which serves ${ctx.hosts.spare} again.`,
      }
    : {
        ok: false,
        message: `${ctx.hosts.host} still answered from the Worker, or ${ctx.hosts.spare} did not, after ${WORKER_WAIT_MS / 60_000} minutes.`,
      };
}

interface WorkerLeft {
  /** The rehearsal Worker's custom domains at the two hosts. */
  readonly domains: readonly { readonly id: string; readonly hostname: string }[];
  /** Another Worker's custom domain at either host. */
  readonly others: readonly string[];
  /** Whether the rehearsal Worker exists; null when it could not be read. */
  readonly exists: boolean | null;
  /** False when a host's domains could not be read. */
  readonly readable: boolean;
}

async function workerLeft(ctx: Context): Promise<WorkerLeft> {
  const listed = await Promise.all(
    bothHosts(ctx).map(async (host) => ({ host, held: await workerDomainsAt(ctx, host) })),
  );
  const domains = listed.flatMap(({ host, held }) =>
    (held ?? []).flatMap((item) => {
      const id = fieldOf(item, "id");
      return fieldOf(item, "hostname") === host &&
        fieldOf(item, "service") === REHEARSAL_WORKER &&
        typeof id === "string"
        ? [{ id, hostname: host }]
        : [];
    }),
  );
  const others = listed.flatMap(({ host, held }) =>
    (held ?? [])
      .filter(
        (item) =>
          fieldOf(item, "hostname") === host && fieldOf(item, "service") !== REHEARSAL_WORKER,
      )
      .map((item) => `${host} (Worker ${String(fieldOf(item, "service"))})`),
  );
  let exists: boolean | null;
  try {
    await ctx.api.call(
      "GET",
      `${accountPath(ctx)}/workers/scripts/${REHEARSAL_WORKER}/settings`,
      `reading the Worker ${REHEARSAL_WORKER}`,
    );
    exists = true;
  } catch (failure) {
    if (!(failure instanceof ApiError)) throw failure;
    exists = failure.status === 404 ? false : null;
  }
  return { domains, others, exists, readable: listed.every(({ held }) => held !== null) };
}

async function destroy(ctx: Context): Promise<StepResult> {
  const first = await alchemy(ctx, "rehearsal:destroy", "staged");
  const before = await workerLeft(ctx);
  const fellBack = before.domains.length > 0 || before.exists === true;
  if (fellBack) {
    await Promise.all(
      before.domains.map((domain) =>
        ctx.api.call(
          "DELETE",
          `${accountPath(ctx)}/workers/domains/${encodeURIComponent(domain.id)}`,
          `removing ${domain.hostname} from ${REHEARSAL_WORKER}`,
        ),
      ),
    );
    if (before.exists === true) {
      await ctx.api.call(
        "DELETE",
        `${accountPath(ctx)}/workers/scripts/${REHEARSAL_WORKER}`,
        `deleting the Worker ${REHEARSAL_WORKER}`,
      );
    }
    // Alchemy's state still names what was just deleted; destroying again clears it.
    await alchemy(ctx, "rehearsal:destroy", "staged");
  }
  const after = fellBack ? await workerLeft(ctx) : before;
  const left = [
    ...after.domains.map((domain) => `${domain.hostname} on ${REHEARSAL_WORKER}`),
    ...after.others,
    ...(after.exists === true ? [`the Worker ${REHEARSAL_WORKER}`] : []),
  ];
  const unknown = !after.readable || after.exists === null;
  if (left.length > 0 || unknown || first !== 0) {
    const notes = [
      unknown ? "some of it could not be read" : "",
      first === 0 ? "" : "Alchemy's destroy failed",
      fellBack ? "the API removed what Alchemy left" : "",
    ].filter((note) => note !== "");
    return {
      ok: false,
      message: `Left after the destroy: ${left.join(", ") || "nothing seen"}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}.`,
    };
  }
  return {
    ok: true,
    message: fellBack
      ? "Alchemy's destroy left the Worker or a domain; the API removed them and Alchemy's state was cleared."
      : "The rehearsal Worker and its domains are gone.",
  };
}

const isRehearsalTarget = (content: string): boolean =>
  content.startsWith(REHEARSAL_PROJECT_PREFIX) && content.endsWith(".pages.dev");

/**
 * Removes what the rehearsal made in Pages and DNS, CNAMEs first: a project
 * goes only once no record of the zone points at it, so no failed write can
 * leave a rehearsal host pointing at a `pages.dev` name another account could
 * take. A failed write ends the step there.
 */
async function cleanup(ctx: Context): Promise<StepResult> {
  const zones = await ctx.api.reach([ctx.hosts.zone]);
  const hosts = bothHosts(ctx);
  const located = await Promise.all(
    hosts.map((host) => locateHost(ctx.api, zones, ctx.hosts.zone, host, [])),
  );
  await Promise.all(
    located.flatMap(({ host, zone, records }) =>
      records
        .filter((record) => record.type === "CNAME" && isRehearsalTarget(record.content))
        .map((record) => ctx.api.deleteRecord(zone, record.id, host)),
    ),
  );
  const ours = (await ctx.api.projects()).filter((held) =>
    held.name.startsWith(REHEARSAL_PROJECT_PREFIX),
  );
  await Promise.all(
    ours.map(async (project) => {
      await Promise.all(
        project.domains
          .filter((domain) => hosts.includes(domain))
          .map((host) => ctx.api.removeDomain(project.name, host)),
      );
      await ctx.api.call(
        "DELETE",
        `${accountPath(ctx)}/pages/projects/${encodeURIComponent(project.name)}`,
        `deleting the Pages project ${project.name}`,
      );
    }),
  );
  const projectsLeft = (await ctx.api.projects())
    .filter((held) => held.name.startsWith(REHEARSAL_PROJECT_PREFIX))
    .map((held) => `the Pages project ${held.name}`);
  const relocated = await Promise.all(
    hosts.map((host) => locateHost(ctx.api, zones, ctx.hosts.zone, host, [])),
  );
  const recordsLeft = relocated.flatMap(({ host, records }) =>
    records
      .filter((record) => decides(host, record))
      .map((record) => `a ${record.type} record at ${host}`),
  );
  const left = [...projectsLeft, ...recordsLeft];
  if (left.length > 0) {
    return {
      ok: false,
      message: `Left after the cleanup: ${left.join(", ")}. A record that is not a rehearsal CNAME is not this job's to delete; remove it by hand if it is the rehearsal's.`,
    };
  }
  return {
    ok: true,
    message:
      ours.length === 0
        ? "Nothing of the rehearsal's was there."
        : `Removed ${ours.map((held) => held.name).join(", ")} and the rehearsal's CNAMEs.`,
  };
}

async function watchStep(ctx: Context): Promise<StepResult> {
  const address = await pin(ctx, [ctx.hosts.host, ctx.hosts.spare]);
  let nextJobs = ctx.input.now() + WATCH_JOBS_EVERY_MS;
  const ended = await until(ctx, PROBE_INTERVAL_MS, ctx.input.now() + WATCH_CAP_MS, async () => {
    await Promise.all(
      bothHosts(ctx).map(async (host) => {
        await probeAt(ctx, address, host);
        ctx.record.sample("dns", host, await ctx.input.dns.lookupSystem(host));
      }),
    );
    if (ctx.input.now() < nextJobs) return undefined;
    nextJobs = ctx.input.now() + WATCH_JOBS_EVERY_MS;
    const attachJob = (await runJobs(ctx))?.find((job) => job.name === ATTACH_JOB_NAME);
    return attachJob?.status === "completed" ? true : undefined;
  });
  return {
    ok: true,
    message:
      ended === true
        ? "The attach job completed; the watch ends."
        : `The watch reached its ${WATCH_CAP_MS / 60_000}-minute cap before the attach job completed.`,
  };
}

// ── The report ────────────────────────────────────────────────────────────

interface Fragment {
  readonly step?: string;
  readonly exitCode?: number;
  readonly message?: string;
  readonly startedAt?: string;
  readonly events?: Readonly<Record<string, string | number>>;
  readonly timeline?: readonly TimelineEntry[];
}

const msBetween = (from: unknown, to: unknown): number | null =>
  typeof from === "string" && typeof to === "string" ? Date.parse(to) - Date.parse(from) : null;

export interface Intervals {
  readonly edgeGapMs: number | null;
  readonly edgeGapFrom: "watch" | "detach";
  readonly clientDnsGapMs: number | null;
  readonly gapMs: number | null;
  readonly workerDomainListedMs: number | null;
  readonly rollbackMs: number | null;
  readonly pagesServingMs: number | null;
  readonly pagesDomainActiveMs: number | null;
}

/** Every interval the report gives, from the fragments it found. */
export function intervals(fragments: Readonly<Record<string, Fragment>>, host: string): Intervals {
  const detached = fragments.detach?.events ?? {};
  const flipped = fragments.flip?.events ?? {};
  const attached = fragments.attach?.events ?? {};
  const timeline = fragments.watch?.timeline ?? [];
  const edge = timeline.filter((entry) => entry.view === "edge" && entry.host === host);
  const firstWorker = edge.findIndex((entry) => entry.outcome === "worker");
  const beforeWorker = firstWorker === -1 ? edge : edge.slice(0, firstWorker);
  const firstDown = beforeWorker.findIndex(
    (entry, index) => entry.outcome !== "pages" && beforeWorker[index - 1]?.outcome === "pages",
  );
  const lastPages = firstDown > 0 ? beforeWorker[firstDown - 1] : undefined;
  const longestDns = timeline
    .filter((entry) => entry.view === "dns" && entry.host === host && entry.outcome !== "resolves")
    .map((entry) => msBetween(entry.first, entry.last) ?? 0)
    .reduce<number | null>((longest, length) => Math.max(longest ?? 0, length), null);
  return {
    edgeGapMs:
      firstWorker === -1
        ? null
        : msBetween(lastPages?.last ?? detached.detachedAt, edge[firstWorker]?.first),
    edgeGapFrom: lastPages === undefined ? "detach" : "watch",
    clientDnsGapMs: longestDns,
    gapMs: msBetween(detached.detachedAt, flipped.firstWorkerAnswerAt),
    workerDomainListedMs: msBetween(flipped.alchemyStartedAt, flipped.workerDomainListedAt),
    rollbackMs: msBetween(fragments.unflip?.startedAt, attached.firstPagesAnswerAt),
    pagesServingMs: msBetween(attached.attachedAt, attached.firstPagesAnswerAt),
    pagesDomainActiveMs: msBetween(attached.attachedAt, attached.pagesDomainActiveAt),
  };
}

const REPORT_FILE = "domain-move-rehearsal.json";

/** Every fragment file in `out`, or null when the directory cannot be read. */
function readFragments(
  input: RehearsalInput,
  out: string,
): Readonly<Record<string, string>> | null {
  try {
    return input.readDir(out);
  } catch {
    return null;
  }
}

function report(input: RehearsalInput, out: string, hosts: RehearsalHosts): number {
  const files = readFragments(input, out);
  if (files === null) {
    input.out(
      `::error::domain-move-rehearsal: ${out} cannot be read: no job of this attempt left a record.\n`,
    );
    return 1;
  }
  const fragments: Record<string, Fragment> = {};
  for (const [name, text] of Object.entries(files)) {
    const step = name.replace(/\.json$/, "");
    if (name !== REPORT_FILE && isStep(step)) {
      try {
        fragments[step] = JSON.parse(text) as Fragment;
      } catch {
        fragments[step] = { message: "the fragment could not be read" };
      }
    }
  }
  const expected = STEPS.filter((step) => step !== "report");
  const measured = intervals(fragments, hosts.host);
  const result = {
    hosts,
    intervals: measured,
    steps: Object.fromEntries(
      expected.flatMap((step) => {
        const fragment = fragments[step];
        return fragment === undefined
          ? []
          : [[step, { exitCode: fragment.exitCode ?? null, message: fragment.message ?? null }]];
      }),
    ),
    missing: expected.filter((step) => fragments[step] === undefined),
    fragments,
    note: "Edge probes go to one pinned address of the dev zone with SNI and Host the probed host, so no resolver cache decides them; the dns view is the runner's own resolver, as a visitor's would be. A rerun reproduces the shape, the verdicts and the exit codes; the timings differ.",
  };
  input.writeFile(join(out, REPORT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  const seconds = (value: number | null) =>
    value === null ? "—" : `${Math.round(value / 100) / 10} s`;
  const summary = [
    "## Domain move rehearsal",
    "",
    "| Interval | Measured |",
    "|---|---|",
    `| Host unreachable at the edge (edgeGapMs, from the ${measured.edgeGapFrom}) | ${seconds(measured.edgeGapMs)} |`,
    `| Host not resolving on the runner (clientDnsGapMs) | ${seconds(measured.clientDnsGapMs)} |`,
    `| Detach to the Worker answering (gapMs) | ${seconds(measured.gapMs)} |`,
    `| Alchemy start to the domain listed (workerDomainListedMs) | ${seconds(measured.workerDomainListedMs)} |`,
    `| Unflip start to Pages answering (rollbackMs) | ${seconds(measured.rollbackMs)} |`,
    `| Attach to Pages answering (pagesServingMs) | ${seconds(measured.pagesServingMs)} |`,
    `| Attach to the Pages domain active (pagesDomainActiveMs) | ${seconds(measured.pagesDomainActiveMs)} |`,
    "",
    "| Step | Exit |",
    "|---|---|",
    ...expected.map((step) => `| ${step} | ${fragments[step]?.exitCode ?? "missing"} |`),
    "",
  ].join("\n");
  const summaryFile = input.env.GITHUB_STEP_SUMMARY ?? "";
  if (summaryFile === "") input.out(`${summary}\n`);
  else input.writeFile(summaryFile, `${summary}\n`);
  return 0;
}

// ── Running a step ────────────────────────────────────────────────────────

function runStep(
  ctx: Context,
  step: Exclude<Step, "report">,
  project: string,
): Promise<StepResult> {
  switch (step) {
    case "preflight":
      return preflight(ctx, project);
    case "pages-on":
      return putOnPages(ctx, project, [ctx.hosts.host, ctx.hosts.spare]);
    case "worker-staged":
      return workerStaged(ctx);
    case "wait-watch":
      return waitWatch(ctx);
    case "detach":
      return detachStep(ctx, project);
    case "flip":
      return flip(ctx);
    case "check":
      return check(ctx);
    case "unflip":
      return unflip(ctx);
    case "attach":
      return putOnPages(ctx, project, [ctx.hosts.spare, ctx.hosts.host]);
    case "destroy":
      return destroy(ctx);
    case "cleanup":
      return cleanup(ctx);
    case "watch":
      return watchStep(ctx);
  }
}

export async function runRehearsal(input: RehearsalInput): Promise<number> {
  const { env } = input;
  const error = (message: string) => input.out(`::error::domain-move-rehearsal: ${message}\n`);
  const usage = (message: string): number => {
    error(message);
    return 2;
  };
  const [step = "", ...rest] = input.args;
  const outAt = rest.indexOf("--out");
  const out = outAt === -1 ? "" : (rest[outAt + 1] ?? "");
  if (!isStep(step) || out === "") {
    return usage(`usage: domain-move-rehearsal.ts <${STEPS.join("|")}> --out <dir>`);
  }
  let hosts: RehearsalHosts;
  try {
    hosts = rehearsalHosts(env.DEV_DOMAIN ?? "");
  } catch (failure) {
    if (failure instanceof RehearsalNameError) return usage(failure.message);
    throw failure;
  }
  if (step === "report") return report(input, out, hosts);

  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  if (!ANY_ATTEMPT.has(step) && attempt !== "1") {
    return usage(
      `this is attempt ${attempt} of the run; the first attempt's cleanup removed what ${step} acts on. Dispatch a new run.`,
    );
  }
  const tokenName = TOKEN_OF[step];
  const token = (env[tokenName] ?? "").trim();
  const account = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const github = tokenName === "GITHUB_TOKEN";
  if (token === "" || (!github && account === "")) {
    return usage(`${step} needs ${github ? "" : "CLOUDFLARE_ACCOUNT_ID and "}${tokenName}`);
  }
  let project = "";
  if (PROJECT_STEPS.has(step)) {
    try {
      project = rehearsalProject(env.GITHUB_RUN_ID ?? "");
    } catch (failure) {
      if (failure instanceof RehearsalNameError) return usage(failure.message);
      throw failure;
    }
  }

  const secrets = [account, ...TOKEN_NAMES.map((name) => env[name] ?? "")].filter(
    (value) => value.trim() !== "",
  );
  const record = new Recorder({
    step,
    attempt,
    hosts,
    path: join(out, `${step}.json`),
    write: input.writeFile,
    now: input.now,
    secrets,
    account,
  });
  record.flush();
  const api = pagesDnsApi({
    account,
    token: github ? "" : token,
    fetch: input.fetch,
    sleep: input.sleep,
    observe: (seen) => record.call(seen),
  });
  const githubToken = github ? token : "";
  const ctx: Context = { input, env, hosts, account, api, githubToken, record };
  const finish = (code: number, message: string): number => {
    const said = record.redact(message);
    record.fragment.exitCode = code;
    record.fragment.message = said;
    record.fragment.endedAt = record.iso();
    record.flush();
    if (code === 0) input.out(`${said}\n`);
    else error(said);
    return code;
  };
  try {
    const result = await runStep(ctx, step, project);
    return finish(result.ok ? 0 : 1, result.message);
  } catch (failure) {
    if (failure instanceof ApiError || failure instanceof Refusal) {
      return finish(1, failure.message);
    }
    throw failure;
  }
}

// ── The real world ────────────────────────────────────────────────────────

const realDns: RehearsalDns = {
  resolveNs: (zone) => resolveNs(zone),
  lookup4: async (name) => (await lookup(name, { family: 4 })).address,
  resolveAt: (servers, name) => {
    const resolver = new Resolver({ timeout: 3_000, tries: 1 });
    resolver.setServers([...servers]);
    return resolver.resolve4(name);
  },
  lookupSystem: async (name) => {
    try {
      await lookup(name, { family: 4 });
      return "resolves";
    } catch (failure) {
      return failure instanceof Error && "code" in failure ? String(failure.code) : "ERROR";
    }
  },
};

/** Runs one of shared/infra's rehearsal scripts from the repository root, its output to a file. */
function runAlchemyIn(logDir: string) {
  return (script: AlchemyScript, env: Readonly<Record<string, string | undefined>>) =>
    new Promise<AlchemyRun>((resolve) => {
      mkdirSync(logDir, { recursive: true });
      const file = join(logDir, `alchemy-${script.replace(":", "-")}-${Date.now()}.log`);
      const log = createWriteStream(file);
      const child = spawn("bun", ["run", "--cwd", "shared/infra", script], {
        env: { ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("close", (code) => {
        log.end(() => resolve({ exitCode: code ?? 1, log: readFileSync(file, "utf8") }));
      });
      child.on("error", (failure) => {
        log.end(() => resolve({ exitCode: 1, log: failure.message }));
      });
    });
}

if (import.meta.main) {
  const code = await runRehearsal({
    args: process.argv.slice(2),
    env: process.env,
    out: (text) => process.stdout.write(text),
    fetch,
    sleep: (wait) => new Promise((resolve) => setTimeout(resolve, wait)),
    now: () => Date.now(),
    probe: (address, host) =>
      edgeProbe({ connect: (options) => tlsConnect(options), address, host }),
    dns: realDns,
    runAlchemy: runAlchemyIn(join(process.env.RUNNER_TEMP ?? "/tmp", "alchemy-logs")),
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    readDir: (dir) =>
      Object.fromEntries(
        readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
      ),
  });
  process.exit(code);
}
