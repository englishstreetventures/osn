// scripts/domain-move-rehearsal.ts runs each step of the domain move
// rehearsal on the dev account and records what Cloudflare answered. These
// drive every step against a fake Cloudflare API, a fake Alchemy, a fake
// DNS, a fake edge and a fake clock, one test per way a step can go wrong.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";

import {
  REHEARSAL_MARKERS,
  REHEARSAL_WORKER,
  rehearsalProject,
} from "../../shared/infra/rehearsal/names";
import {
  ATTACH_JOB_NAME,
  edgeProbe,
  type EdgeSocket,
  type ProbeResult,
  type RehearsalInput,
  runRehearsal,
  WATCH_JOB_NAME,
} from "../domain-move-rehearsal";
import type { DnsRecord } from "../pages-domain";
import { CI_USER_AGENT } from "../smoke-check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE_ID = "fedcba9876543210fedcba9876543210";
const DNS_TOKEN = "dev-pages-dns-token-for-tests";
const API_TOKEN = "dev-deploy-token-for-tests";
const GH_TOKEN = "github-job-token-for-tests";
const DOMAIN = "example.dev";
const HOST = "domain-move.example.dev";
const SPARE = "next.domain-move.example.dev";
const RUN = "41818903897";
const PROJECT = rehearsalProject(RUN);
const API = "https://api.cloudflare.com/client/v4";
const GITHUB = "https://api.github.com";
const EDGE = "198.51.100.7";

const BASE_ENV: Record<string, string> = {
  DEV_DOMAIN: DOMAIN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  GITHUB_RUN_ID: RUN,
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "englishstreetventures/osn",
};
const DNS_ENV = { ...BASE_ENV, CLOUDFLARE_PAGES_DNS_TOKEN: DNS_TOKEN };
const DEPLOY_ENV = { ...BASE_ENV, CLOUDFLARE_API_TOKEN: API_TOKEN, OSN_DEPLOY_TIER: "dev" };
const GH_ENV = { ...BASE_ENV, GITHUB_TOKEN: GH_TOKEN };

const ok = (result: unknown, info?: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result, result_info: info }), {
    status: 200,
  });
const failed = (status: number, code: number, message = "refused") =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), {
    status,
  });

/** A DNS record as the fake zone holds it: any `meta`, as Cloudflare may send. */
type Rec = Omit<DnsRecord, "meta"> & { name: string; meta?: Record<string, unknown> };

const cname = (id: string, host: string, project: string): Rec => ({
  id,
  name: host,
  type: "CNAME",
  content: `${project}.pages.dev`,
});
const workerRecord = (host: string): Rec => ({
  id: `rec-worker-${host}`,
  name: host,
  type: "AAAA",
  content: "100::",
  meta: { origin_worker_id: "abc", read_only: true },
});

/** The dev account as the fake API holds it; writes change it. */
interface World {
  accounts: string[];
  zones: { id: string; name: string; account: { id: string; name?: string }; owner?: unknown }[];
  projects: Record<string, { domains: string[]; subdomain?: string; status?: string }>;
  records: Record<string, Rec[]>;
  workerDomains: { id: string; hostname: string; service: string }[];
  worker: boolean;
  jobs: { name: string; status: string; started_at?: string }[];
  /** Answers given in turn to `METHOD /path` (no query) before the usual one; an Error is a network failure. */
  flaky: Record<string, (Response | Error)[]>;
  /** Extra fields every answer of that list carries, to test what the artifact keeps. */
  extra: Record<string, unknown>;
}

const world = (patch: Partial<World> = {}): World => ({
  accounts: [ACCOUNT],
  zones: [{ id: ZONE_ID, name: DOMAIN, account: { id: ACCOUNT } }],
  projects: {},
  records: {},
  workerDomains: [],
  worker: false,
  jobs: [],
  flaky: {},
  extra: {},
  ...patch,
});

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth: string | null;
}

function fakeFetch(w: World, calls: Call[]) {
  let next = 1;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get("authorization") });
    const path = url.startsWith(API) ? url.slice(API.length) : url.slice(GITHUB.length);
    const bare = path.split("?")[0] ?? "";
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const queued = w.flaky[`${method} ${bare}`]?.shift();
    if (queued instanceof Error) throw queued;
    if (queued !== undefined) return queued;
    if (url.startsWith(GITHUB)) {
      if (method === "GET" && /\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(bare)) {
        return new Response(JSON.stringify({ total_count: w.jobs.length, jobs: w.jobs }), {
          status: 200,
        });
      }
      throw new Error(`unlisted GitHub URL ${method} ${url}`);
    }
    const accountPath = `/accounts/${ACCOUNT}`;
    if (method === "GET" && bare === "/accounts") {
      return ok(
        w.accounts.map((id) => ({ id, name: "someone@example.com's Account" })),
        { total_count: w.accounts.length },
      );
    }
    if (method === "GET" && bare === "/zones") {
      const named = query.get("name");
      const zones = named === null ? w.zones : w.zones.filter((zone) => zone.name === named);
      return ok(
        zones.map((zone) =>
          Object.assign({ name_servers: ["ada.ns.cloudflare.com"] }, zone, w.extra),
        ),
      );
    }
    if (method === "GET" && bare === `${accountPath}/pages/projects`) {
      const page = Number(query.get("page") ?? "1");
      const names = Object.keys(w.projects);
      return ok(
        page === 1
          ? names.map((name) =>
              Object.assign(
                {
                  name,
                  deployment_configs: { production: { env_vars: { SECRET: { value: "plain" } } } },
                  latest_deployment: { id: "dep" },
                },
                w.extra,
              ),
            )
          : [],
        { page, total_pages: 1 },
      );
    }
    if (method === "POST" && bare === `${accountPath}/pages/projects`) {
      const { name } = body as { name: string };
      w.projects[name] = { domains: [], subdomain: w.projects[name]?.subdomain };
      return ok({
        name,
        subdomain: w.extra.subdomain ?? `${name}.pages.dev`,
        production_branch: "main",
      });
    }
    const project = new RegExp(`^${accountPath}/pages/projects/([^/]+)$`).exec(bare);
    if (method === "DELETE" && project !== null) {
      delete w.projects[project[1] ?? ""];
      return ok(null);
    }
    const domains = new RegExp(`^${accountPath}/pages/projects/([^/]+)/domains$`).exec(bare);
    if (domains !== null) {
      const held = w.projects[domains[1] ?? ""];
      if (method === "GET") return ok((held?.domains ?? []).map((name) => ({ name })));
      if (method === "POST") {
        held?.domains.push((body as { name: string }).name);
        return ok({ name: (body as { name: string }).name, status: "pending" });
      }
    }
    const domain = new RegExp(`^${accountPath}/pages/projects/([^/]+)/domains/([^/]+)$`).exec(bare);
    if (domain !== null) {
      const held = w.projects[domain[1] ?? ""];
      const name = decodeURIComponent(domain[2] ?? "");
      if (method === "GET") {
        return ok({
          name,
          status: held?.status ?? "active",
          validation_data: { status: "active" },
        });
      }
      if (method === "DELETE" && held !== undefined) {
        held.domains = held.domains.filter((listed) => listed !== name);
        return ok(null);
      }
    }
    if (bare === `/zones/${ZONE_ID}/dns_records`) {
      if (method === "GET") return ok(w.records[query.get("name") ?? ""] ?? []);
      if (method === "POST") {
        const record = body as { name: string; type: string; content: string };
        const made = { ...record, id: `rec-${next++}` };
        w.records[record.name] = [...(w.records[record.name] ?? []), made];
        return ok(made);
      }
    }
    const record = new RegExp(`^/zones/${ZONE_ID}/dns_records/([^/]+)$`).exec(bare);
    if (method === "DELETE" && record !== null) {
      for (const host of Object.keys(w.records)) {
        w.records[host] = (w.records[host] ?? []).filter((held) => held.id !== record[1]);
      }
      return ok({ id: record[1] });
    }
    if (method === "GET" && bare === `${accountPath}/workers/domains`) {
      const hostname = query.get("hostname");
      return ok(w.workerDomains.filter((held) => hostname === null || held.hostname === hostname));
    }
    const workerDomain = new RegExp(`^${accountPath}/workers/domains/([^/]+)$`).exec(bare);
    if (method === "DELETE" && workerDomain !== null) {
      w.workerDomains = w.workerDomains.filter((held) => held.id !== workerDomain[1]);
      return ok(null);
    }
    if (
      bare === `${accountPath}/workers/scripts/${REHEARSAL_WORKER}/settings` &&
      method === "GET"
    ) {
      return w.worker
        ? ok({ logpush: false })
        : failed(404, 10007, "workers.api.error.script_not_found");
    }
    if (bare === `${accountPath}/workers/scripts/${REHEARSAL_WORKER}` && method === "DELETE") {
      w.worker = false;
      return ok(null);
    }
    throw new Error(`unlisted Cloudflare URL ${method} ${url}`);
  };
  return fetch as unknown as typeof globalThis.fetch;
}

/** Who answers each host at the edge, read from the world as it is now. */
const edgeFromWorld =
  (w: World) =>
  async (_address: string, host: string): Promise<ProbeResult> => {
    if (w.workerDomains.some((held) => held.hostname === host))
      return { outcome: "worker", status: 200 };
    const pages = Object.values(w.projects).some((held) => held.domains.includes(host));
    const pointed = (w.records[host] ?? []).some((held) => held.type === "CNAME");
    return pages && pointed ? { outcome: "pages", status: 200 } : { outcome: "other", status: 530 };
  };

/** A name exists at the zone's servers while the zone holds a record for it. */
const dnsFromWorld = (w: World) => ({
  resolveNs: async () => ["ada.ns.cloudflare.com"],
  lookup4: async () => "192.0.2.53",
  resolveAt: async (_servers: readonly string[], name: string) =>
    (w.records[name] ?? []).length > 0 ? [EDGE] : [],
  lookupSystem: async (name: string) =>
    (w.records[name] ?? []).length > 0 ? "resolves" : "ENOTFOUND",
});

interface Run {
  code: number;
  output: string;
  calls: Call[];
  files: Record<string, string>;
  fragment: Record<string, unknown>;
  alchemy: { script: string; mode: string | undefined }[];
}

async function run(
  args: string[],
  w: World,
  env: Record<string, string | undefined>,
  options: Partial<Pick<RehearsalInput, "probe" | "dns" | "runAlchemy" | "readDir">> = {},
): Promise<Run> {
  const calls: Call[] = [];
  const files: Record<string, string> = {};
  const lines: string[] = [];
  const alchemy: Run["alchemy"] = [];
  let clock = Date.parse("2026-11-06T00:00:00Z");
  const code = await runRehearsal({
    args,
    env,
    out: (text) => lines.push(text),
    fetch: fakeFetch(w, calls),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    probe: options.probe ?? edgeFromWorld(w),
    dns: options.dns ?? dnsFromWorld(w),
    runAlchemy:
      options.runAlchemy ??
      (async (script, alchemyEnv) => {
        alchemy.push({ script, mode: alchemyEnv.REHEARSAL_MODE });
        return { exitCode: 0, log: "" };
      }),
    writeFile: (path, text) => {
      files[path] = text;
    },
    readDir: options.readDir ?? (() => ({})),
  });
  const fragmentPath = Object.keys(files).find((path) => path.endsWith(`/${args[0]}.json`));
  const fragment =
    fragmentPath === undefined
      ? {}
      : (JSON.parse(files[fragmentPath] ?? "{}") as Record<string, unknown>);
  return { code, output: lines.join(""), calls, files, fragment, alchemy };
}

const OUT = ["--out", "/tmp/rehearsal"];
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const events = (r: Run) => (r.fragment.events ?? {}) as Record<string, unknown>;

/** The dev account once the host is on the run's project and the Worker on the spare. */
const onPages = (): World =>
  world({
    projects: { [PROJECT]: { domains: [`${PROJECT}.pages.dev`, HOST] } },
    records: { [HOST]: [cname("rec-cname", HOST, PROJECT)], [SPARE]: [workerRecord(SPARE)] },
    workerDomains: [{ id: "wd-spare", hostname: SPARE, service: REHEARSAL_WORKER }],
    worker: true,
  });

describe("domain-move-rehearsal.ts", () => {
  test("R1: imports only the repository's import-free files and node built-ins", () => {
    const runtimeImports = (file: string) =>
      [...readFileSync(file, "utf8").matchAll(/^import (?!type )[^;]*from "([^"]+)";/gm)].map(
        (match) => match[1],
      );
    expect(
      runtimeImports(join(import.meta.dir, "..", "domain-move-rehearsal.ts")).toSorted(),
    ).toEqual(
      [
        "../shared/infra/rehearsal/names",
        "./pages-domain",
        "./smoke-check",
        "node:child_process",
        "node:dns/promises",
        "node:fs",
        "node:path",
        "node:tls",
      ].toSorted(),
    );
    const names = join(import.meta.dir, "..", "..", "shared", "infra", "rehearsal", "names.ts");
    expect(readFileSync(names, "utf8").match(/^import [^;]*from "([^"]+)";/gm)).toEqual([
      'import { PRODUCTION_HOSTS, zoneOf } from "../src/production-sites";',
    ]);
    const smoke = join(import.meta.dir, "..", "smoke-check.ts");
    expect(runtimeImports(smoke)).toEqual(["node:fs"]);
  });

  test("R2: an unknown step, no --out, or a missing DEV_DOMAIN, account or token exits 2 before any request", async () => {
    for (const [args, env] of [
      [["teleport", ...OUT], DNS_ENV],
      [["detach"], DNS_ENV],
      [["detach", ...OUT], { ...DNS_ENV, DEV_DOMAIN: undefined }],
      [["detach", ...OUT], { ...DNS_ENV, CLOUDFLARE_ACCOUNT_ID: "" }],
      [["detach", ...OUT], { ...DNS_ENV, CLOUDFLARE_PAGES_DNS_TOKEN: undefined }],
      [["flip", ...OUT], { ...DEPLOY_ENV, CLOUDFLARE_API_TOKEN: " " }],
      [["upload-reach", ...OUT], BASE_ENV],
      [["watch", ...OUT], BASE_ENV],
      [["preflight", ...OUT], { ...DNS_ENV, GITHUB_RUN_ID: "" }],
    ] as const) {
      const result = await run([...args], world(), env);
      expect({ args, code: result.code, calls: result.calls.length }).toEqual({
        args,
        code: 2,
        calls: 0,
      });
    }
  });

  test.each(["cireweddings.com", "next.musubi.social", "pulse.events", "x.pages.dev"])(
    "R3: DEV_DOMAIN %s exits 2 before any request",
    async (domain) => {
      const result = await run(["detach", ...OUT], onPages(), { ...DNS_ENV, DEV_DOMAIN: domain });
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
    },
  );

  test("R4: on a re-run every step but destroy, cleanup and report exits 2 before any request; cleanup still cleans", async () => {
    const rerun = { GITHUB_RUN_ATTEMPT: "2" };
    for (const [step, env] of [
      ["upload-reach", DEPLOY_ENV],
      ["preflight", DNS_ENV],
      ["pages-on", DNS_ENV],
      ["worker-staged", DEPLOY_ENV],
      ["wait-watch", GH_ENV],
      ["detach", DNS_ENV],
      ["flip", DEPLOY_ENV],
      ["check", DNS_ENV],
      ["unflip", DEPLOY_ENV],
      ["attach", DNS_ENV],
      ["watch", GH_ENV],
    ] as const) {
      const result = await run([step, ...OUT], onPages(), { ...env, ...rerun });
      expect({ step, code: result.code, calls: result.calls.length }).toEqual({
        step,
        code: 2,
        calls: 0,
      });
    }
    // The Worker gone (destroy's part), cleanup removes the rest on any attempt.
    const w = onPages();
    w.records[SPARE] = [];
    w.workerDomains = [];
    const cleanup = await run(["cleanup", ...OUT], w, { ...DNS_ENV, ...rerun });
    expect(cleanup.code).toBe(0);
    expect(Object.keys(w.projects)).toEqual([]);
    expect(w.records[HOST]).toEqual([]);
  });

  test("R4a: upload-reach refuses a token reaching another account, or any zone", async () => {
    expect((await run(["upload-reach", ...OUT], world({ zones: [] }), DEPLOY_ENV)).code).toBe(0);
    const twoAccounts = await run(
      ["upload-reach", ...OUT],
      world({ zones: [], accounts: [ACCOUNT, "f".repeat(32)] }),
      DEPLOY_ENV,
    );
    expect(twoAccounts.code).toBe(1);
    const zoned = await run(["upload-reach", ...OUT], world(), DEPLOY_ENV);
    expect(zoned.code).toBe(1);
    expect(zoned.calls.every((call) => call.auth === `Bearer ${API_TOKEN}`)).toBe(true);
  });

  test("R5: preflight refuses, writing nothing, a token reaching two accounts or zones other than exactly DEV_DOMAIN", async () => {
    for (const w of [
      world({ accounts: [ACCOUNT, "f".repeat(32)] }),
      world({ zones: [] }),
      world({
        zones: [
          { id: ZONE_ID, name: DOMAIN, account: { id: ACCOUNT } },
          { id: "z2", name: "other.dev", account: { id: ACCOUNT } },
        ],
      }),
    ]) {
      const result = await run(["preflight", ...OUT], w, DNS_ENV);
      expect(result.code).toBe(1);
      expect(writes(result.calls)).toEqual([]);
    }
  });

  test("R6: preflight refuses, writing nothing, when the run's project exists or either host is held", async () => {
    for (const w of [
      world({ projects: { [PROJECT]: { domains: [] } } }),
      world({ projects: { "cire-host": { domains: [SPARE] } } }),
      world({ records: { [HOST]: [cname("r", HOST, "elsewhere")] } }),
      world({ records: { [SPARE]: [workerRecord(SPARE)] } }),
    ]) {
      const result = await run(["preflight", ...OUT], w, DNS_ENV);
      expect(result.code).toBe(1);
      expect(writes(result.calls)).toEqual([]);
    }
    // A TXT record routes nothing, so it holds no host.
    const w = world({
      records: { [HOST]: [{ id: "t", name: HOST, type: "TXT", content: "v=x" }] },
    });
    const clean = await run(["preflight", ...OUT], w, DNS_ENV);
    expect(clean.code).toBe(0);
    expect(
      writes(clean.calls).map((call) => [call.method, call.url.slice(API.length), call.body]),
    ).toEqual([
      ["POST", `/accounts/${ACCOUNT}/pages/projects`, { name: PROJECT, production_branch: "main" }],
    ]);
  });

  test("R7: preflight fails when the created project's subdomain is not <name>.pages.dev", async () => {
    const result = await run(
      ["preflight", ...OUT],
      world({ extra: { subdomain: `${PROJECT}-4xk.pages.dev` } }),
      DNS_ENV,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(`${PROJECT}-4xk.pages.dev`);
  });

  test("R8: pages-on makes the CNAME, then adds the domain, and waits for the Pages marker and an active domain", async () => {
    const w = world({ projects: { [PROJECT]: { domains: [`${PROJECT}.pages.dev`] } } });
    const result = await run(["pages-on", ...OUT], w, DNS_ENV);
    expect(result.code).toBe(0);
    expect(writes(result.calls).map((call) => [call.method, call.url.slice(API.length)])).toEqual([
      ["POST", `/zones/${ZONE_ID}/dns_records`],
      ["POST", `/accounts/${ACCOUNT}/pages/projects/${PROJECT}/domains`],
    ]);
    expect(events(result).firstPagesAnswerAt).toBeString();
    expect(events(result).pagesDomainActiveAt).toBeString();
    expect(result.fragment.edgeAddress).toBe(EDGE);
    // The Pages marker never answering in time fails the step.
    const never = await run(
      ["pages-on", ...OUT],
      world({ projects: { [PROJECT]: { domains: [] } } }),
      DNS_ENV,
      { probe: async () => ({ outcome: "error", error: "ERR_TLS_CERT_ALTNAME_INVALID" }) },
    );
    expect(never.code).toBe(1);
    expect(events(never).firstPagesAnswerAt).toBeUndefined();
  });

  test("R9: detach refuses, writing nothing, unless the host is on the run's project; it deletes only that CNAME and waits for nothing", async () => {
    for (const w of [
      world({ records: { [HOST]: [cname("r", HOST, PROJECT)] } }),
      world({
        projects: { other: { domains: [HOST] } },
        records: { [HOST]: [cname("r", HOST, "other")] },
      }),
    ]) {
      const refused = await run(["detach", ...OUT], w, DNS_ENV);
      expect(refused.code).toBe(1);
      expect(writes(refused.calls)).toEqual([]);
    }
    const w = onPages();
    w.records[HOST]?.push({ id: "txt", name: HOST, type: "TXT", content: "keep" });
    let probes = 0;
    const result = await run(["detach", ...OUT], w, DNS_ENV, {
      probe: async () => {
        probes += 1;
        return { outcome: "pages" };
      },
    });
    expect(result.code).toBe(0);
    expect(writes(result.calls).map((call) => [call.method, call.url.slice(API.length)])).toEqual([
      ["DELETE", `/accounts/${ACCOUNT}/pages/projects/${PROJECT}/domains/${HOST}`],
      ["DELETE", `/zones/${ZONE_ID}/dns_records/rec-cname`],
    ]);
    expect(w.records[HOST]?.map((record) => record.type)).toEqual(["TXT"]);
    expect(events(result).detachedAt).toBeString();
    expect(probes).toBe(0);
  });

  /** The fake Alchemy: moves the Worker's domain as the mode says, as Alchemy does. */
  const alchemyMoving =
    (w: World, log: { script: string; mode: string | undefined }[], exitCode = 0) =>
    async (script: string, env: Record<string, string | undefined>) => {
      log.push({ script, mode: env.REHEARSAL_MODE });
      if (script === "rehearsal:destroy") {
        w.workerDomains = [];
        w.worker = false;
        for (const host of [HOST, SPARE])
          w.records[host] = (w.records[host] ?? []).filter((r) => r.type !== "AAAA");
        return { exitCode, log: "" };
      }
      const target = env.REHEARSAL_MODE === "worker" ? HOST : SPARE;
      const other = target === HOST ? SPARE : HOST;
      w.workerDomains = [{ id: `wd-${target}`, hostname: target, service: REHEARSAL_WORKER }];
      w.records[other] = (w.records[other] ?? []).filter((r) => r.type !== "AAAA");
      w.records[target] = [...(w.records[target] ?? []), workerRecord(target)];
      w.worker = true;
      return { exitCode, log: `deployed with ${API_TOKEN} in ${ACCOUNT}` };
    };

  /** The dev account after detach: the host is on neither side. */
  const detached = (): World => {
    const w = onPages();
    if (w.projects[PROJECT] !== undefined) w.projects[PROJECT].domains = [`${PROJECT}.pages.dev`];
    w.records[HOST] = [];
    return w;
  };

  test("R10: flip runs Alchemy with REHEARSAL_MODE=worker, records when the domain first lists, and waits for the Worker marker", async () => {
    const w = detached();
    const log: { script: string; mode: string | undefined }[] = [];
    const result = await run(["flip", ...OUT], w, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(w, log),
    });
    expect(result.code).toBe(0);
    expect(log).toEqual([{ script: "rehearsal:deploy", mode: "worker" }]);
    expect(events(result).workerDomainListedAt).toBeString();
    expect(events(result).firstWorkerAnswerAt).toBeString();
    expect(events(result).alchemyExitCode).toBe(0);
    expect(result.calls.every((call) => call.auth === `Bearer ${API_TOKEN}`)).toBe(true);
    // An Alchemy failure fails the step, keeping the domains read and the log's tail, redacted.
    const w2 = detached();
    const failing = await run(["flip", ...OUT], w2, DEPLOY_ENV, {
      runAlchemy: async (script, env) => {
        await alchemyMoving(w2, [], 1)(script, env);
        w2.workerDomains = [];
        return {
          exitCode: 1,
          log: `HostnameAlreadyInUse for ${HOST} in ${ACCOUNT} with ${API_TOKEN}`,
        };
      },
    });
    expect(failing.code).toBe(1);
    expect(String(failing.fragment.alchemyLogTail)).toContain("HostnameAlreadyInUse");
    expect(JSON.stringify(failing.fragment)).not.toContain(API_TOKEN);
    expect(JSON.stringify(failing.fragment)).not.toContain(ACCOUNT);
    // The Worker marker never answering in time fails the step.
    const w3 = detached();
    const silent = await run(["flip", ...OUT], w3, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(w3, []),
      probe: async () => ({ outcome: "other", status: 522 }),
    });
    expect(silent.code).toBe(1);
  });

  test("R11: a wait is decided by the pinned edge alone; with no address at the zone's servers the step fails naming both hosts", async () => {
    const w = detached();
    const result = await run(["flip", ...OUT], w, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(w, []),
      dns: { ...dnsFromWorld(w), lookupSystem: async () => "ENOTFOUND" },
    });
    expect(result.code).toBe(0);
    const nowhere = world({ projects: { [PROJECT]: { domains: [] } } });
    const unpinned = await run(["flip", ...OUT], nowhere, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(nowhere, []),
      dns: { ...dnsFromWorld(nowhere), resolveAt: async () => [] },
    });
    expect(unpinned.code).toBe(1);
    expect(unpinned.output).toContain(HOST);
    expect(unpinned.output).toContain(SPARE);
  });

  test("R12: check passes a host that reads free, and fails one whose Worker record has an unknown shape, keeping the record", async () => {
    const w = detached();
    w.records[HOST] = [workerRecord(HOST)];
    w.workerDomains = [{ id: "wd", hostname: HOST, service: REHEARSAL_WORKER }];
    const free = await run(["check", ...OUT], w, DNS_ENV);
    expect(free.code).toBe(0);
    expect(free.fragment.state).toEqual({ kind: "free" });
    const odd = detached();
    odd.records[HOST] = [
      { id: "odd", name: HOST, type: "AAAA", content: "100::", meta: { managed_by: "workers" } },
    ];
    const unclear = await run(["check", ...OUT], odd, DNS_ENV);
    expect(unclear.code).toBe(1);
    expect((unclear.fragment.state as { kind: string }).kind).toBe("unclear");
    expect(JSON.stringify(unclear.fragment.calls)).toContain("managed_by");
  });

  test("R13: unflip passes only once the host stops answering the Worker and the spare answers it", async () => {
    const w = detached();
    await alchemyMoving(w, [])("rehearsal:deploy", { REHEARSAL_MODE: "worker" });
    const log: { script: string; mode: string | undefined }[] = [];
    const result = await run(["unflip", ...OUT], w, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(w, log),
    });
    expect(result.code).toBe(0);
    expect(log).toEqual([{ script: "rehearsal:deploy", mode: "staged" }]);
    const stuck = detached();
    await alchemyMoving(stuck, [])("rehearsal:deploy", { REHEARSAL_MODE: "worker" });
    const stays = await run(["unflip", ...OUT], stuck, DEPLOY_ENV, {
      runAlchemy: async () => ({ exitCode: 0, log: "" }),
    });
    expect(stays.code).toBe(1);
  });

  test("R14: attach refuses, writing nothing, while a Worker record holds the host; otherwise it puts the host back and waits for Pages", async () => {
    const held = detached();
    held.records[HOST] = [workerRecord(HOST)];
    const refused = await run(["attach", ...OUT], held, DNS_ENV);
    expect(refused.code).toBe(1);
    expect(writes(refused.calls)).toEqual([]);
    const w = detached();
    const result = await run(["attach", ...OUT], w, DNS_ENV);
    expect(result.code).toBe(0);
    expect(w.projects[PROJECT]?.domains).toContain(HOST);
    expect(events(result).firstPagesAnswerAt).toBeString();
    expect(events(result).attachedAt).toBeString();
  });

  test("R15: destroy deletes by API only the rehearsal Worker and its domains at the two hosts, runs Alchemy's destroy again, and treats a refused read as unknown", async () => {
    const w = onPages();
    w.workerDomains.push({ id: "wd-other", hostname: SPARE, service: "someone-else" });
    w.workerDomains.push({
      id: "wd-elsewhere",
      hostname: "api.cire.example.dev",
      service: REHEARSAL_WORKER,
    });
    const log: { script: string; mode: string | undefined }[] = [];
    const result = await run(["destroy", ...OUT], w, DEPLOY_ENV, {
      runAlchemy: async (script, env) => {
        log.push({ script, mode: env.REHEARSAL_MODE });
        return { exitCode: 1, log: "destroy failed" };
      },
    });
    expect(log.map((entry) => entry.script)).toEqual(["rehearsal:destroy", "rehearsal:destroy"]);
    expect(writes(result.calls).map((call) => [call.method, call.url.slice(API.length)])).toEqual([
      ["DELETE", `/accounts/${ACCOUNT}/workers/domains/wd-spare`],
      ["DELETE", `/accounts/${ACCOUNT}/workers/scripts/${REHEARSAL_WORKER}`],
    ]);
    expect(w.workerDomains.map((held) => held.id).toSorted()).toEqual(["wd-elsewhere", "wd-other"]);
    // Another Worker's domain at a rehearsal host is left, and so the step fails.
    expect(result.code).toBe(1);
    const w2 = onPages();
    const gone = await run(["destroy", ...OUT], w2, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(w2, []),
    });
    expect(gone.code).toBe(0);
    expect(writes(gone.calls)).toEqual([]);
    const w3 = onPages();
    w3.flaky[`GET /accounts/${ACCOUNT}/workers/scripts/${REHEARSAL_WORKER}/settings`] = [
      failed(403, 10000),
      failed(403, 10000),
    ];
    const unknown = await run(["destroy", ...OUT], w3, DEPLOY_ENV, {
      runAlchemy: alchemyMoving(w3, []),
    });
    expect(unknown.code).toBe(1);
  });

  test("R16: cleanup with nothing there writes nothing; with leftovers it removes only rehearsal projects and their CNAMEs at the two hosts", async () => {
    const empty = await run(["cleanup", ...OUT], world(), DNS_ENV);
    expect(empty.code).toBe(0);
    expect(writes(empty.calls)).toEqual([]);
    const old = rehearsalProject("123");
    const w = world({
      projects: {
        [PROJECT]: { domains: [`${PROJECT}.pages.dev`, HOST] },
        [old]: { domains: [`${old}.pages.dev`] },
        "cire-host": { domains: ["host.cire.example.dev"] },
      },
      records: {
        [HOST]: [
          cname("c1", HOST, PROJECT),
          { id: "a1", name: HOST, type: "A", content: "192.0.2.1" },
        ],
        [SPARE]: [cname("c2", SPARE, old)],
      },
    });
    const result = await run(["cleanup", ...OUT], w, DNS_ENV);
    expect(Object.keys(w.projects)).toEqual(["cire-host"]);
    expect(w.records[HOST]?.map((record) => record.id)).toEqual(["a1"]);
    expect(w.records[SPARE]).toEqual([]);
    // The A record at the host is not the rehearsal's to delete: it is left, and reported.
    expect(result.code).toBe(1);
    expect(result.output).toContain(HOST);
  });

  test("R17: the fragment never holds a token, the account id, an id, an account name, a zone owner, a name server or a project's settings", async () => {
    const w = onPages();
    w.zones = [
      {
        id: ZONE_ID,
        name: DOMAIN,
        account: { id: ACCOUNT, name: "Owner's Account" },
        owner: { email: "owner@example.com" },
      },
    ];
    w.flaky[`GET /accounts/${ACCOUNT}/pages/projects/${PROJECT}/domains`] = [
      failed(500, 0, `internal error for ${ACCOUNT} with ${DNS_TOKEN}`),
    ];
    w.records[HOST]?.push({
      id: "m",
      name: HOST,
      type: "TXT",
      content: "x",
      meta: { new_flag: true },
    });
    const result = await run(["check", ...OUT], w, DNS_ENV);
    const text = JSON.stringify(result.fragment);
    for (const hidden of [
      DNS_TOKEN,
      ACCOUNT,
      ZONE_ID,
      "someone@example.com",
      "Owner's Account",
      "owner@example.com",
      "ada.ns.cloudflare.com",
      "deployment_configs",
      "latest_deployment",
      "plain",
    ]) {
      expect({ hidden, held: text.includes(hidden) }).toEqual({ hidden, held: false });
    }
    // A record at a rehearsal host keeps every key, one nobody listed included.
    expect(text).toContain("new_flag");
    expect(text).toContain("<id>");
  });

  test("R18: the edge probe classifies each answer, sends SNI, Host and the CI user agent, follows no redirect, and refuses a certificate that does not cover the host", async () => {
    const socket = (options: {
      response?: string;
      error?: { code: string; message: string };
      authorized?: boolean;
      names?: string;
    }) => {
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      const written: string[] = [];
      const fake: EdgeSocket = {
        authorized: options.authorized ?? true,
        authorizationError: options.authorized === false ? new Error("self signed") : undefined,
        getPeerCertificate: () =>
          ({
            subject: { CN: options.names ?? HOST },
            subjectaltname: `DNS:${options.names ?? HOST}`,
          }) as never,
        on: (event, handler) => {
          (handlers[event] ??= []).push(handler as (value?: unknown) => void);
          return fake;
        },
        write: (text) => {
          written.push(String(text));
          queueMicrotask(() => {
            for (const handler of handlers.data ?? []) handler(Buffer.from(options.response ?? ""));
            for (const handler of handlers.end ?? []) handler();
          });
          return true;
        },
        destroy: () => fake,
      };
      const connect = (connectOptions: { host: string; servername: string }) => {
        seen.push(connectOptions);
        queueMicrotask(() => {
          if (options.error !== undefined) {
            for (const handler of handlers.error ?? [])
              handler(
                Object.assign(new Error(options.error.message), { code: options.error.code }),
              );
          } else {
            for (const handler of handlers.secureConnect ?? []) handler();
          }
        });
        return fake;
      };
      return { connect, written };
    };
    const seen: { host: string; servername: string }[] = [];
    const probe = async (options: Parameters<typeof socket>[0]) => {
      const fake = socket(options);
      const result = await edgeProbe({
        connect: fake.connect as never,
        checkIdentity: checkServerIdentity,
        address: EDGE,
        host: HOST,
        timeoutMs: 5_000,
      });
      return { result, written: fake.written.join("") };
    };
    const page = (marker: string) =>
      `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n<p>${marker}</p>`;
    const pages = await probe({ response: page(REHEARSAL_MARKERS.pages) });
    expect(pages.result).toEqual({ outcome: "pages", status: 200 });
    expect(pages.written).toContain(`Host: ${HOST}\r\n`);
    expect(pages.written).toContain(`User-Agent: ${CI_USER_AGENT}\r\n`);
    expect(seen.at(-1)).toMatchObject({ host: EDGE, servername: HOST });
    expect((await probe({ response: page(REHEARSAL_MARKERS.worker) })).result).toEqual({
      outcome: "worker",
      status: 200,
    });
    expect(
      (
        await probe({
          response: "HTTP/1.1 302 Found\r\nlocation: https://x.cloudflareaccess.com/\r\n\r\n",
        })
      ).result,
    ).toEqual({ outcome: "other", status: 302 });
    const tls = await probe({
      error: { code: "ERR_TLS_CERT_ALTNAME_INVALID", message: `x`.repeat(500) },
    });
    expect(tls.result.outcome).toBe("error");
    expect(tls.result.error?.startsWith("ERR_TLS_CERT_ALTNAME_INVALID")).toBe(true);
    expect((tls.result.error ?? "").length).toBeLessThanOrEqual(240);
    // An unauthorized socket, or a certificate for another name, is an error even with a marker.
    expect(
      (await probe({ authorized: false, response: page(REHEARSAL_MARKERS.worker) })).result.outcome,
    ).toBe("error");
    expect(
      (await probe({ names: "other.example.dev", response: page(REHEARSAL_MARKERS.worker) })).result
        .outcome,
    ).toBe("error");
  });

  test("R19: watch keeps run-length edge and DNS timelines and stops once the attach job completes, past a GitHub failure", async () => {
    const w = onPages();
    let ticks = 0;
    w.jobs = [{ name: ATTACH_JOB_NAME, status: "queued" }];
    w.flaky[`GET /repos/englishstreetventures/osn/actions/runs/${RUN}/attempts/1/jobs`] = [
      new Error("connection reset"),
    ];
    const result = await run(["watch", ...OUT], w, GH_ENV, {
      probe: async (_address, host) => {
        ticks += 1;
        if (ticks > 40) w.jobs = [{ name: ATTACH_JOB_NAME, status: "completed" }];
        return host === HOST && ticks > 20 ? { outcome: "worker" } : { outcome: "pages" };
      },
    });
    expect(result.code).toBe(0);
    const timeline = result.fragment.timeline as {
      view: string;
      host: string;
      outcome: string;
      count: number;
    }[];
    const edgeHost = timeline.filter((entry) => entry.view === "edge" && entry.host === HOST);
    expect(edgeHost.map((entry) => entry.outcome)).toEqual(["pages", "worker"]);
    expect(timeline.some((entry) => entry.view === "dns" && entry.outcome === "resolves")).toBe(
      true,
    );
    expect(
      result.calls
        .filter((call) => call.url.startsWith(GITHUB))
        .every((call) => call.auth === `Bearer ${GH_TOKEN}`),
    ).toBe(true);
    // With the attach job never completing, the cap stops it.
    const capped = await run(["watch", ...OUT], onPages(), GH_ENV);
    expect(capped.code).toBe(0);
    expect(String(capped.fragment.message)).toContain("cap");
  });

  test("R19a: wait-watch returns once the watch job is 45 s into its run, and gives up at its cap without failing", async () => {
    const started = new Date(Date.parse("2026-11-06T00:00:00Z") - 10_000).toISOString();
    const w = world({
      jobs: [{ name: WATCH_JOB_NAME, status: "in_progress", started_at: started }],
    });
    const ready = await run(["wait-watch", ...OUT], w, GH_ENV);
    expect(ready.code).toBe(0);
    expect(String(ready.fragment.message)).toContain("watching");
    const never = await run(["wait-watch", ...OUT], world({ jobs: [] }), GH_ENV);
    expect(never.code).toBe(0);
    expect(String(never.fragment.message)).toContain("cap");
    const broken = world();
    broken.flaky[`GET /repos/englishstreetventures/osn/actions/runs/${RUN}/attempts/1/jobs`] =
      Array.from({ length: 400 }, () => new Error("down"));
    expect((await run(["wait-watch", ...OUT], broken, GH_ENV)).code).toBe(0);
  });

  test("R19b: a poll that fails or meets a 429 while Alchemy runs is recorded and the step goes on", async () => {
    const w = detached();
    w.flaky[`GET /accounts/${ACCOUNT}/workers/domains`] = [
      failed(429, 10000),
      failed(429, 10000),
      failed(429, 10000),
      new Error("reset"),
    ];
    const result = await run(["flip", ...OUT], w, DEPLOY_ENV, { runAlchemy: alchemyMoving(w, []) });
    expect(result.code).toBe(0);
    expect(JSON.stringify(result.fragment.calls)).toContain("429");
  });

  test("R20: report computes each interval from the fragments, falls back to the detach for the gap's start, and lists what is missing", async () => {
    const at = (seconds: number) =>
      new Date(Date.parse("2026-11-06T00:00:00Z") + seconds * 1000).toISOString();
    const fragments = {
      "detach.json": JSON.stringify({
        step: "detach",
        exitCode: 0,
        startedAt: at(0),
        events: { detachedAt: at(10) },
      }),
      "flip.json": JSON.stringify({
        step: "flip",
        exitCode: 0,
        startedAt: at(60),
        events: {
          alchemyStartedAt: at(70),
          workerDomainListedAt: at(95),
          firstWorkerAnswerAt: at(130),
        },
      }),
      "unflip.json": JSON.stringify({
        step: "unflip",
        exitCode: 0,
        startedAt: at(300),
        events: {},
      }),
      "attach.json": JSON.stringify({
        step: "attach",
        exitCode: 0,
        startedAt: at(400),
        events: { attachedAt: at(410), firstPagesAnswerAt: at(470), pagesDomainActiveAt: at(500) },
      }),
      "watch.json": JSON.stringify({
        step: "watch",
        exitCode: 0,
        timeline: [
          { view: "edge", host: HOST, outcome: "pages", first: at(0), last: at(12), count: 7 },
          { view: "edge", host: HOST, outcome: "other", first: at(14), last: at(120), count: 50 },
          { view: "edge", host: HOST, outcome: "worker", first: at(122), last: at(300), count: 80 },
          { view: "dns", host: HOST, outcome: "resolves", first: at(0), last: at(20), count: 10 },
          {
            view: "dns",
            host: HOST,
            outcome: "ENOTFOUND",
            first: at(22),
            last: at(1800),
            count: 900,
          },
        ],
      }),
    };
    const result = await run(
      ["report", ...OUT],
      world(),
      { DEV_DOMAIN: DOMAIN },
      {
        readDir: () => fragments,
      },
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(
      result.files["/tmp/rehearsal/domain-move-rehearsal.json"] ?? "{}",
    ) as {
      intervals: Record<string, unknown>;
      missing: string[];
      steps: Record<string, { exitCode: number }>;
    };
    expect(report.intervals).toEqual({
      edgeGapMs: 110_000,
      edgeGapFrom: "watch",
      clientDnsGapMs: 1_778_000,
      gapMs: 120_000,
      workerDomainListedMs: 25_000,
      rollbackMs: 170_000,
      pagesServingMs: 60_000,
      pagesDomainActiveMs: 90_000,
    });
    expect(report.missing).toContain("preflight");
    expect(report.steps.flip?.exitCode).toBe(0);
    // With no watch sample before the detach, the gap runs from the detach.
    const late = await run(
      ["report", ...OUT],
      world(),
      { DEV_DOMAIN: DOMAIN },
      {
        readDir: () => ({
          ...fragments,
          "watch.json": JSON.stringify({
            step: "watch",
            timeline: [
              {
                view: "edge",
                host: HOST,
                outcome: "other",
                first: at(20),
                last: at(120),
                count: 40,
              },
              {
                view: "edge",
                host: HOST,
                outcome: "worker",
                first: at(122),
                last: at(300),
                count: 80,
              },
            ],
          }),
        }),
      },
    );
    const lateReport = JSON.parse(
      late.files["/tmp/rehearsal/domain-move-rehearsal.json"] ?? "{}",
    ) as {
      intervals: Record<string, unknown>;
    };
    expect(lateReport.intervals.edgeGapFrom).toBe("detach");
    expect(lateReport.intervals.edgeGapMs).toBe(112_000);
  });
});
