// scripts/smoke-check.ts runs after every Worker deploy in deploy.yml (dev)
// and production-release.yml (production): it asks the Worker's own hosts
// whether the new version answers, and rolls the Worker back when it does not.
// These drive it with an injected fetch — the Worker's hosts and the Cloudflare
// API both — and a fake clock, so the rollback path, the one nobody wants to
// meet first in production, runs on every `bun test`.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSurfaceKey } from "../deploy-surfaces";
import {
  annotation,
  CI_USER_AGENT,
  type Deployment,
  deployedVersion,
  devRestorePlan,
  devTarget,
  judge,
  type Outcome,
  probeOnce,
  type Probe,
  productionSiteTarget,
  productionTarget,
  restorePlan,
  rollbackMessage,
  runSmokeCheck,
  SECRETS_CHANGED,
  SMOKE_TARGETS,
} from "../smoke-check";

// ── fixtures ────────────────────────────────────────────────────────────────

type Answer =
  | Response
  | Error
  | ((call: number, init: RequestInit | undefined) => Response | Error | Promise<Response>);

/** A fetch that answers each URL from `answers`; an unlisted URL is a test bug. */
function fakeFetch(answers: Record<string, Answer>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const counts = new Map<string, number>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const call = (counts.get(url) ?? 0) + 1;
    counts.set(url, call);
    const answer = answers[url];
    if (answer === undefined) throw new Error(`test fetched an unlisted URL: ${url}`);
    const value = typeof answer === "function" ? await answer(call, init) : answer;
    if (value instanceof Error) throw value;
    return value.clone();
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status: number) =>
  new Response("<!doctype html><title>Invitation not found</title>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

const HEALTHY = () => json({ status: "ok", service: "osn-api" });
const MISCONFIGURED = () =>
  json({ error: "Worker misconfigured: missing OSN_TOTP_ENCRYPTION_KEY" }, 503);
const JWKS = () =>
  json({
    keys: [{ kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: "k1", x: "x", y: "y" }],
  });
const UNREACHABLE = () => new TypeError("fetch failed");
const STORE_OK = () => json({ ok: true });
const STORE_DOWN = () => json({ ok: false }, 503);

const OSN_PROD = {
  "https://id.musubi.social/health": HEALTHY,
  "https://id.musubi.social/.well-known/jwks.json": JWKS,
  "https://id.musubi.social/health/coordination": STORE_OK,
};

/** A clock that only moves when the script sleeps. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

// ── the Cloudflare API ──────────────────────────────────────────────────────

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-token-for-tests";
const deploymentsUrl = (worker: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}/deployments`;

const deployment = (
  id: string,
  createdOn: string,
  version: string,
  percentage = 100,
): Deployment => ({
  id,
  created_on: createdOn,
  versions: [{ version_id: version, percentage }],
});

// Deployment ids in the form the Cloudflare deployments API returns them.
const DEP_BEFORE = "5d1c6b0e-4a63-4f0e-9b41-0f6e2a7c9d10";
const DEP_THIS_JOB = "8f3a9c2d-17b4-4c5e-a6d8-3e2f1b0c4a97";

/** This job's deploy, and the one before it, listed oldest first to prove the sort. */
const HISTORY: readonly Deployment[] = [
  deployment(DEP_BEFORE, "2026-10-15T09:00:00Z", "v-before"),
  deployment(DEP_THIS_JOB, "2026-10-16T09:00:00Z", "v-this-job"),
];

interface ApiOptions {
  /** What GET answers, call by call; the last entry repeats. */
  readonly reads?: readonly (readonly Deployment[] | Error | Response)[];
  /** What the rollback's POST answers. */
  readonly rollback?: Response | Error;
}

const apiOk = (result: unknown) => json({ success: true, errors: [], messages: [], result });
const apiError = (code: number, message: string, status = 400) =>
  json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

/** The deployments endpoint of one Worker; records every POST body. */
function fakeApi(options: ApiOptions = {}) {
  const reads = options.reads ?? [HISTORY];
  const posts: { url: string; body: unknown; headers: Headers }[] = [];
  let read = 0;
  const answer: Answer = (_, init) => {
    if (init?.method === "POST") {
      posts.push({
        url: "",
        body: JSON.parse(String(init.body)) as unknown,
        headers: new Headers(init.headers),
      });
      return options.rollback ?? apiOk({ id: "dep-rollback" });
    }
    const value = reads[Math.min(read, reads.length - 1)]!;
    read += 1;
    return Array.isArray(value) ? apiOk({ deployments: value }) : (value as Response | Error);
  };
  return { answer, posts, reads: () => read };
}

/** What the osn-api Worker and its jobs hold as INTERNAL_SERVICE_SECRET, here. */
const SMOKE_SECRET = "internal-service-secret-for-tests";

const RUN_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "englishstreetventures/osn",
  GITHUB_RUN_ID: "38720122405",
  GITHUB_RUN_ATTEMPT: "2",
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  INTERNAL_SERVICE_SECRET: SMOKE_SECRET,
};

const workerOf = (args: readonly string[]) => {
  const [surface, tier] = args;
  if (surface === undefined || !isSurfaceKey(surface)) return undefined;
  if (tier === "dev") return devTarget(surface)?.worker;
  if (tier !== "production") return undefined;
  return (productionSiteTarget(surface) ?? productionTarget(surface))?.worker;
};

// Dev hosts come from the stack job's dev-hosts step, never from this script.
const CIRE_API_DEV = "https://api.cire.example.test";
const INVITES_DEV = "https://invite.cire.example.test";
const CIRE_LANDING_DEV = "https://cire.example.test";
const OSN_API_DEV = "https://id.musubi.example.test";

/** The env a stack job's smoke step passes: its origin and the deployment its deploy made. */
const devEnv = (origin: string, extra: Record<string, string | undefined> = {}) => ({
  SMOKE_ORIGIN: origin,
  SMOKE_DEPLOYMENT: DEP_THIS_JOB,
  ...extra,
});
const INVITES_ENV = (extra: Record<string, string | undefined> = {}) =>
  devEnv(INVITES_DEV, { SMOKE_MARKETING_ORIGIN: CIRE_LANDING_DEV, ...extra });

async function smoke(
  args: string[],
  answers: Record<string, Answer>,
  options: { env?: Record<string, string | undefined>; api?: ApiOptions } = {},
) {
  const api = fakeApi(options.api);
  const worker = workerOf(args);
  const http = fakeFetch({
    ...answers,
    ...(worker === undefined ? {} : { [deploymentsUrl(worker)]: api.answer }),
  });
  const clock = fakeClock();
  const lines: string[] = [];
  const code = await runSmokeCheck({
    args,
    env: { ...RUN_ENV, ...options.env },
    fetch: http.fetch,
    now: clock.now,
    sleep: clock.sleep,
    out: (text) => lines.push(text),
  });
  const isApi = (url: string) => url.startsWith("https://api.cloudflare.com/");
  return {
    code,
    calls: http.calls.filter((c) => !isApi(c.url)),
    apiCalls: http.calls.filter((c) => isApi(c.url)),
    sleeps: clock.sleeps,
    posts: api.posts,
    output: lines.join(""),
  };
}

const fetchesOf = (result: { calls: { url: string }[] }, url: string) =>
  result.calls.filter((c) => c.url === url).length;

const probe = (url: string, expects: Probe["expects"]): Probe => ({ url, expects });
const HEALTH = probe("https://id.musubi.social/health", { kind: "json", fields: { status: "ok" } });

/** A fetch that never answers until its signal aborts. */
const hanging = (_: number, init: RequestInit | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason as Error));
  });

// ── what counts as healthy ──────────────────────────────────────────────────

describe("judge: a static JSON file", () => {
  const file = probe("https://next.musubi.social/.well-known/apple-app-site-association", {
    kind: "jsonFile",
  });
  const answer = (status: number, type: string, body: string) =>
    judge(file, new Response(body, { status, headers: { "content-type": type } }), body, false);

  test("SM3: passes 200 application/json holding an object, and nothing else", () => {
    expect(answer(200, "application/json", '{"applinks":{}}')).toEqual({ kind: "pass" });
    for (const [status, type, body] of [
      [200, "text/html; charset=utf-8", '{"applinks":{}}'],
      [200, "application/octet-stream", '{"applinks":{}}'],
      [200, "application/json", "[]"],
      [404, "application/json", '{"applinks":{}}'],
    ] as const) {
      expect({ status, type, body, kind: answer(status, type, body).kind }).toEqual({
        status,
        type,
        body,
        kind: "wrong",
      });
    }
  });
});

describe("judge", () => {
  const verdict = async (p: Probe, response: Response, access = false): Promise<Outcome> =>
    judge(p, response, await response.text(), access);
  const reasonOf = (outcome: Outcome) => (outcome.kind === "pass" ? "" : outcome.reason);

  test("a JSON probe passes on a 200 whose fields match", async () => {
    expect(await verdict(HEALTH, HEALTHY())).toEqual({ kind: "pass" });
  });

  test("a fail-closed 503 is a wrong answer, and the reason carries the status and the body", async () => {
    const outcome = await verdict(HEALTH, MISCONFIGURED());
    expect(outcome.kind).toBe("wrong");
    expect(reasonOf(outcome)).toContain("503");
    expect(reasonOf(outcome)).toContain("missing OSN_TOTP_ENCRYPTION_KEY");
  });

  test("a 200 with the wrong field, or no JSON at all, is wrong", async () => {
    expect((await verdict(HEALTH, json({ status: "degraded" }))).kind).toBe("wrong");
    expect((await verdict(HEALTH, html(200))).kind).toBe("wrong");
    expect((await verdict(HEALTH, json([{ status: "ok" }]))).kind).toBe("wrong");
  });

  test("the coordination probe wants ok true, the boolean, on a 200", async () => {
    const store = probe("https://id.musubi.social/health/coordination", {
      kind: "json",
      fields: { ok: true },
    });
    expect(await verdict(store, STORE_OK())).toEqual({ kind: "pass" });
    expect((await verdict(store, STORE_DOWN())).kind).toBe("wrong");
    expect((await verdict(store, json({ ok: "true" }))).kind).toBe("wrong");
    expect((await verdict(store, json({ ok: true }, 503))).kind).toBe("wrong");
    // Its own limiter refusing is not the Worker's code failing.
    expect((await verdict(store, json({ error: "rate_limited" }, 429))).kind).toBe("blocked");
  });

  test("the session probe wants signedIn false, the boolean", async () => {
    const session = probe("https://api.cireweddings.com/api/auth/session", {
      kind: "json",
      fields: { signedIn: false },
    });
    expect(await verdict(session, json({ signedIn: false }))).toEqual({ kind: "pass" });
    expect((await verdict(session, json({ signedIn: "false" }))).kind).toBe("wrong");
    expect((await verdict(session, json({ error: "Not found" }, 404))).kind).toBe("wrong");
  });

  test("a JWKS probe wants a 200 with an ES256 P-256 key", async () => {
    const jwks = probe("https://id.musubi.social/.well-known/jwks.json", { kind: "jwks" });
    expect(await verdict(jwks, JWKS())).toEqual({ kind: "pass" });
    expect((await verdict(jwks, json({ keys: [] }))).kind).toBe("wrong");
    expect((await verdict(jwks, json({ keys: [{ kty: "RSA", alg: "RS256" }] }))).kind).toBe(
      "wrong",
    );
    expect((await verdict(jwks, json({ keys: [{ kty: "EC", crv: "P-256" }] }))).kind).toBe("wrong");
    expect((await verdict(jwks, json({}))).kind).toBe("wrong");
    expect((await verdict(jwks, new Response("not json", { status: 200 }))).kind).toBe("wrong");
    const keysOn500 = new Response(await JWKS().text(), { status: 500 });
    expect((await verdict(jwks, keysOn500)).kind).toBe("wrong");
  });

  test("a redirect probe wants a redirect to the expected origin", async () => {
    const root = probe("https://invite.cireweddings.com/", {
      kind: "redirect",
      to: "https://cireweddings.com",
    });
    for (const status of [301, 302, 303, 307, 308]) {
      expect(await verdict(root, redirect("https://cireweddings.com/", status))).toEqual({
        kind: "pass",
      });
    }
    expect((await verdict(root, redirect("https://evil.example/"))).kind).toBe("wrong");
    // A relative Location stays on the guest site's own origin.
    expect((await verdict(root, redirect("/somewhere"))).kind).toBe("wrong");
    expect((await verdict(root, html(200))).kind).toBe("wrong");
    const none = await verdict(root, new Response(null, { status: 302 }));
    expect(reasonOf(none)).toBe("answered 302 with no Location");
    const unparseable = await verdict(root, redirect("http://["));
    expect(reasonOf(unparseable)).toBe("answered 302 with no Location");
  });

  test("a page probe takes a rendered 404 or 200, and nothing else", async () => {
    const page = probe("https://invite.cireweddings.com/smoke-check-no-such-wedding", {
      kind: "page",
    });
    expect(await verdict(page, html(404))).toEqual({ kind: "pass" });
    expect(await verdict(page, html(200))).toEqual({ kind: "pass" });
    expect((await verdict(page, html(500))).kind).toBe("wrong");
    expect((await verdict(page, json({ error: "x" }, 404))).kind).toBe("wrong");
    const plain = new Response("<p>hi</p>", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const untyped = await verdict(page, plain);
    expect(untyped.kind).toBe("wrong");
    expect(reasonOf(untyped)).toContain("text/plain");
    const bare = new Response(null, { status: 404 });
    expect(reasonOf(await verdict(page, bare))).toContain("with no content type");
  });

  test("an html probe wants a 200 HTML page: a 404 page is wrong", async () => {
    const page = probe(`${CIRE_LANDING_DEV}/`, { kind: "html" });
    expect(await verdict(page, html(200))).toEqual({ kind: "pass" });
    const missing = await verdict(page, html(404));
    expect(missing.kind).toBe("wrong");
    expect(reasonOf(missing)).toContain("404");
    expect((await verdict(page, json({ ok: true }))).kind).toBe("wrong");
  });

  test("a jsonObject probe wants a 200 whose body is a JSON object: any other 200 is wrong", async () => {
    const geo = probe("https://pulse.example.test/api/geo", { kind: "jsonObject" });
    expect(await verdict(geo, json({ country: "AU" }))).toEqual({ kind: "pass" });
    expect(await verdict(geo, json({}))).toEqual({ kind: "pass" });
    expect((await verdict(geo, html(200))).kind).toBe("wrong");
    expect((await verdict(geo, json([{ country: "AU" }]))).kind).toBe("wrong");
    expect((await verdict(geo, json(null))).kind).toBe("wrong");
    expect((await verdict(geo, json({ country: "AU" }, 500))).kind).toBe("wrong");
  });

  test("Cloudflare Access answering is blocked, not wrong, on any host", async () => {
    const login = redirect(
      "https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/invite.dev.cireweddings.com?kid=1&meta=secretish",
    );
    const outcome = await verdict(HEALTH, login);
    expect(outcome.kind).toBe("blocked");
    // The login URL's query is noise at best; only its origin is reported.
    expect(reasonOf(outcome)).not.toContain("meta=");
  });

  test("AC1: the Access probe passes only on a 301, 302, 303 or 307 to a cloudflareaccess.com host; anything else is open, never wrong", async () => {
    const gate = probe("https://invite.cire.example.test/", { kind: "access" });
    const login =
      "https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/x?meta=secretish";
    for (const status of [301, 302, 303, 307]) {
      expect(await verdict(gate, redirect(login, status), true)).toEqual({ kind: "pass" });
    }
    const open = [
      redirect(login, 308),
      html(200),
      redirect("https://cire.example.test/"),
      redirect("https://cloudflareaccess.com.evil.example/login"),
      redirect("/cdn-cgi/access/login"),
      new Response("Forbidden", { status: 403 }),
      new Response("error code: 1027", { status: 429 }),
    ];
    for (const response of open) {
      const outcome = await verdict(gate, response, true);
      expect(outcome.kind).toBe("open");
      expect(reasonOf(outcome)).toContain("Cloudflare Access");
    }
    // Only an origin is reported, never a login URL's query.
    expect(reasonOf(await verdict(gate, redirect(`${login}`, 308), true))).not.toContain("meta=");
  });

  test("a 401 or 403 is Access on an Access-protected host, and a wrong answer elsewhere", async () => {
    const page = probe("https://invite.dev.cireweddings.com/", {
      kind: "redirect",
      to: "https://dev.cireweddings.com",
    });
    expect((await verdict(page, new Response("Forbidden", { status: 403 }), true)).kind).toBe(
      "blocked",
    );
    expect((await verdict(page, new Response("no", { status: 401 }), true)).kind).toBe("blocked");
    expect((await verdict(HEALTH, new Response("Forbidden", { status: 403 }))).kind).toBe("wrong");
    expect((await verdict(HEALTH, new Response("no", { status: 401 }))).kind).toBe("wrong");
  });

  test("Cloudflare answering in the Worker's place is blocked, not wrong", async () => {
    const challenge = new Response("<html>Just a moment...</html>", {
      status: 403,
      headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
    });
    expect((await verdict(HEALTH, challenge)).kind).toBe("blocked");
    const block = new Response("blocked", { status: 403, headers: { "cf-mitigated": "block" } });
    expect((await verdict(HEALTH, block)).kind).toBe("blocked");
  });

  test("a 429 is blocked on every host: the daily request cap is not the Worker's code", async () => {
    const capped = new Response("error code: 1027", { status: 429 });
    expect((await verdict(HEALTH, capped)).kind).toBe("blocked");
    const page = probe("https://invite.cireweddings.com/x", { kind: "page" });
    expect((await verdict(page, new Response("", { status: 429 }))).kind).toBe("blocked");
  });

  test("the reason is one line, and the body in it at most 200 characters", async () => {
    const page = `<html>\n<body>\n${"<p>stack frame</p>\n".repeat(400)}</body>\n</html>`;
    const outcome = await verdict(HEALTH, new Response(page, { status: 500 }));
    const reason = reasonOf(outcome);
    expect(reason).not.toMatch(/[\r\n]/);
    const body = reason.slice(reason.indexOf(": ") + 2);
    expect(body.length).toBeLessThanOrEqual(200);
  });
});

describe("probeOnce", () => {
  const options = (fetch: typeof globalThis.fetch, timeoutMs = 10_000) => ({
    fetch,
    headers: {},
    access: false,
    timeoutMs,
  });

  test("never follows a redirect, sends the CI user agent and the extra headers, and bounds the request", async () => {
    const http = fakeFetch({ "https://id.musubi.social/health": HEALTHY });
    const outcome = await probeOnce(HEALTH, {
      ...options(http.fetch),
      headers: { "cf-access-client-id": "id" },
    });
    expect(outcome).toEqual({ kind: "pass" });
    const init = http.calls[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("user-agent")).toBe(CI_USER_AGENT);
    expect(new Headers(init?.headers).get("cf-access-client-id")).toBe("id");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("the CI user agent is not Bun's own, which Bot Fight Mode challenges from a GitHub runner", () => {
    expect(CI_USER_AGENT).not.toBe("");
    expect(CI_USER_AGENT).not.toMatch(/^Bun\//);
  });

  test("no answer at all is unreachable, not wrong", async () => {
    const http = fakeFetch({ "https://id.musubi.social/health": UNREACHABLE() });
    const outcome = await probeOnce(HEALTH, options(http.fetch));
    expect(outcome.kind).toBe("unreachable");
    expect(outcome.kind !== "pass" && outcome.reason).toContain("fetch failed");
  });

  test("a request that never answers is cut off at the timeout, and is unreachable", async () => {
    const http = fakeFetch({ "https://id.musubi.social/health": hanging });
    const outcome = await probeOnce(HEALTH, options(http.fetch, 5));
    expect(outcome.kind).toBe("unreachable");
    expect(outcome.kind !== "pass" && outcome.reason).toMatch(/timed out/i);
  });

  test("a body cut off part-way is no answer, not a wrong one", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200 },
      );
    const http = fakeFetch({ "https://id.musubi.social/health": broken });
    const outcome = await probeOnce(HEALTH, options(http.fetch));
    expect(outcome.kind).toBe("unreachable");
  });
});

// ── what a rollback restores ────────────────────────────────────────────────

describe("restorePlan", () => {
  const history = [
    deployment("d3", "2026-10-16T09:00:00Z", "v3"),
    deployment("d2", "2026-10-15T09:00:00Z", "v2", 50),
    deployment("d1", "2026-10-14T09:00:00Z", "v1"),
  ];

  test("restores the newest version that served all traffic before the newest deployment", () => {
    expect(restorePlan(history, undefined)).toEqual({ ok: true, newest: "d3", version: "v1" });
    expect(restorePlan(history, "v3")).toEqual({ ok: true, newest: "d3", version: "v1" });
  });

  test("refuses when the newest deployment is not the version this job deployed", () => {
    const plan = restorePlan(history, "v-this-job");
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.refused).toBe(true);
    expect(plan.ok === false && plan.reason).toContain("not v-this-job");
  });

  test("a Worker with one deployment has nothing to restore", () => {
    const plan = restorePlan([deployment("d1", "2026-10-16T09:00:00Z", "v1")], "v1");
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.refused).toBe(false);
    expect(plan.ok === false && plan.reason).toContain("first deploy");
    expect(restorePlan([], undefined).ok).toBe(false);
  });
});

describe("devRestorePlan", () => {
  test("restores the newest version that served all traffic before the deployment this run made", () => {
    const history = [
      deployment("d3", "2026-10-16T09:00:00Z", "v3"),
      deployment("d2", "2026-10-15T09:00:00Z", "v2", 50),
      deployment("d1", "2026-10-14T09:00:00Z", "v1"),
    ];
    expect(devRestorePlan(history, "d3", "osn-api-dev")).toEqual({
      ok: true,
      newest: "d3",
      version: "v1",
    });
  });
});

describe("deployedVersion", () => {
  test("reads the last deploy entry of wrangler's output file", () => {
    const ndjson = [
      JSON.stringify({ type: "wrangler-session", version: 1 }),
      "not json",
      JSON.stringify({ type: "deploy", version: 1, version_id: "v-first" }),
      "",
      JSON.stringify({ type: "deploy", version: 1, version_id: "v-this-job" }),
    ].join("\n");
    expect(deployedVersion(ndjson)).toBe("v-this-job");
  });

  test("names nothing when no entry is a deploy", () => {
    expect(deployedVersion(JSON.stringify({ type: "deploy" }))).toBeUndefined();
    expect(deployedVersion("")).toBeUndefined();
  });
});

// ── the run ─────────────────────────────────────────────────────────────────

describe("a healthy deploy", () => {
  test("passes on two rounds ten seconds apart and rolls nothing back", async () => {
    const result = await smoke(["osn_api", "production"], OSN_PROD);
    expect(result.code).toBe(0);
    expect(result.posts).toEqual([]);
    expect(result.sleeps).toEqual([10_000]);
    expect(result.calls.map((c) => c.url).toSorted()).toEqual(
      [...Object.keys(OSN_PROD), ...Object.keys(OSN_PROD)].toSorted(),
    );
    // The deployments are read once, before the first probe.
    expect(result.apiCalls.map((c) => c.init?.method)).toEqual(["GET"]);
    expect(result.output).toContain("Smoke check passed");
  });

  test("a pass that the next round contradicts does not count", async () => {
    // Round 1 passes (the version before still answering), round 2 fails,
    // rounds 3 and 4 pass: healthy after round 4.
    const flapping = (call: number) => (call === 2 ? MISCONFIGURED() : HEALTHY());
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": flapping,
    });
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(result.posts).toEqual([]);
  });

  test("a pass in the last round gets its confirming round past the minute", async () => {
    // Fails for the whole minute, passes at 60 s and again at 70 s.
    const late = (call: number) => (call < 7 ? MISCONFIGURED() : HEALTHY());
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": late,
    });
    expect(result.code).toBe(0);
    expect(result.sleeps.reduce((a, b) => a + b, 0)).toBe(70_000);
    expect(result.posts).toEqual([]);
  });

  test("a healthy check passes without Cloudflare credentials, which only a rollback needs", async () => {
    const result = await smoke(["osn_api", "production"], OSN_PROD, {
      env: { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined },
    });
    expect(result.code).toBe(0);
    expect(result.apiCalls).toEqual([]);
  });
});

describe("a broken deploy", () => {
  test("retries for a minute, then restores the version before this deploy", async () => {
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": MISCONFIGURED,
    });
    expect(result.code).toBe(1);
    // Seven rounds at 0, 10, … 60 s, then one more after the rollback.
    expect(result.sleeps).toEqual(Array(7).fill(10_000));
    expect(fetchesOf(result, "https://id.musubi.social/health")).toBe(8);
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.body).toEqual({
      strategy: "percentage",
      versions: [{ version_id: "v-before", percentage: 100 }],
      annotations: {
        "workers/message":
          "Smoke check failed: https://github.com/englishstreetventures/osn/actions/runs/38720122405/attempts/2",
      },
    });
    // Read before the check, read again before the rollback, then the rollback.
    expect(result.apiCalls.map((c) => [c.init?.method, c.url])).toEqual([
      ["GET", deploymentsUrl("osn-api-production")],
      ["GET", deploymentsUrl("osn-api-production")],
      ["POST", deploymentsUrl("osn-api-production")],
    ]);
    expect(result.posts[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(result.output).toContain("::error title=Smoke check failed::");
    expect(result.output).toContain("https://id.musubi.social/health");
    expect(result.output).toContain("missing OSN_TOTP_ENCRYPTION_KEY");
  });

  test("a store the Worker cannot reach fails the check and rolls back, with /health still ok", async () => {
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health/coordination": STORE_DOWN,
    });
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    // Eight asks in the minute and the round after the rollback: under the
    // route's ten a minute, so its own limiter never answers the check.
    expect(fetchesOf(result, "https://id.musubi.social/health/coordination")).toBe(8);
    expect(result.output).toContain("https://id.musubi.social/health/coordination");
    expect(result.output).toContain('{"ok":false}');
  });

  test("the Cloudflare token goes to the Cloudflare API only, never to a probed host", async () => {
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": MISCONFIGURED,
    });
    for (const call of result.calls) {
      // The coordination probe's only authorization is its own bearer.
      expect(new Headers(call.init?.headers).get("authorization") ?? "").not.toContain(TOKEN);
    }
    expect(result.output).not.toContain(TOKEN);
  });

  test("rolls back the dev Worker on dev, and the guest site's own Worker", async () => {
    const dev = await smoke(
      ["cire_api", "dev"],
      { [`${CIRE_API_DEV}/api/auth/session`]: json({ error: "Not found" }, 404) },
      { env: devEnv(CIRE_API_DEV) },
    );
    expect(dev.code).toBe(1);
    expect(dev.posts).toHaveLength(1);
    expect(dev.posts[0]?.body).toMatchObject({ versions: [{ version_id: "v-before" }] });
    expect(dev.apiCalls.every((c) => c.url === deploymentsUrl("cire-api-dev"))).toBe(true);

    const invites = await smoke(["cire_invites", "production"], {
      "https://invite.cireweddings.com/": html(500),
      "https://invite.cireweddings.com/smoke-check-no-such-wedding": html(500),
    });
    expect(invites.code).toBe(1);
    expect(invites.posts).toHaveLength(1);
    expect(invites.apiCalls.every((c) => c.url === deploymentsUrl("cire-invites"))).toBe(true);
  });

  test("rolls back osn-api's dev Worker on dev, and reports the restored version healthy", async () => {
    // Every round of the check fails; the round after the rollback passes.
    const rounds = 7;
    const health = `${OSN_API_DEV}/health`;
    const result = await smoke(
      ["osn_api", "dev"],
      {
        [health]: (call) => (call <= rounds ? MISCONFIGURED() : HEALTHY()),
        [`${OSN_API_DEV}/.well-known/jwks.json`]: JWKS,
        [`${OSN_API_DEV}/health/coordination`]: STORE_OK,
      },
      { env: devEnv(OSN_API_DEV) },
    );
    expect(result.code).toBe(1);
    expect(fetchesOf(result, health)).toBe(rounds + 1);
    expect(result.posts).toHaveLength(1);
    expect(result.apiCalls.map((c) => c.url)).toEqual(Array(3).fill(deploymentsUrl("osn-api-dev")));
    expect(result.output).toContain("the restored version answers healthy");
    expect(result.output).not.toContain("still failing");
  });

  test("after the rollback, one more round says whether the restored version answers", async () => {
    // Every round of the check fails; the round after the rollback passes.
    const rounds = 7;
    const restored = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": (call) => (call <= rounds ? MISCONFIGURED() : HEALTHY()),
    });
    expect(restored.code).toBe(1);
    expect(restored.output).toContain("restored version answers healthy");
    expect(restored.output).toContain("v-before");

    const still = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": MISCONFIGURED,
    });
    expect(still.code).toBe(1);
    expect(still.output).toContain("::error title=Still failing after rollback::");

    // The restored version is judged on every probe, not the first one alone.
    const keyless = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": (call) => (call <= rounds ? MISCONFIGURED() : HEALTHY()),
      "https://id.musubi.social/.well-known/jwks.json": () => json({ keys: [] }),
    });
    expect(keyless.code).toBe(1);
    expect(keyless.posts).toHaveLength(1);
    expect(keyless.output).toContain("::error title=Still failing after rollback::");
    expect(keyless.output).not.toContain("answers healthy");
  });

  test("Cloudflare's refusal over changed secrets is kept: nothing is forced through", async () => {
    const result = await smoke(
      ["osn_api", "production"],
      { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
      {
        api: {
          rollback: apiError(
            SECRETS_CHANGED,
            "A rollback cannot be performed. The following secrets have changed: DEV_LOGIN_SECRET",
          ),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.apiCalls.some((c) => c.url.includes("force"))).toBe(false);
    expect(result.output).toContain("::error title=Rollback refused::");
    expect(result.output).toContain("old values back");
    expect(result.output).toContain("DEV_LOGIN_SECRET");
    expect(result.output).not.toContain("restored version");
  });

  test("a Worker deployed again during the check is not rolled back", async () => {
    const later = [...HISTORY, deployment("dep-secret-put", "2026-10-16T09:00:30Z", "v-secret")];
    const result = await smoke(
      ["osn_api", "production"],
      { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
      { api: { reads: [HISTORY, later] } },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("::error title=Rollback refused::");
    expect(result.output).toContain("deployed again during the check");
  });

  test.each([
    [
      "the API refuses for another reason",
      { rollback: apiError(10_000, "Authentication error", 403) },
      "Authentication error",
    ],
    [
      "the API never answers",
      { rollback: new TypeError("fetch failed") },
      "no answer from the Cloudflare API",
    ],
    [
      "the deployments cannot be read before the check",
      { reads: [apiError(10_007, "Worker not found", 404)] },
      "Worker not found",
    ],
    ["the Worker has no earlier version", { reads: [[HISTORY[1]!]] }, "first deploy"],
  ] as const)(
    "a rollback that cannot run is reported, and the step still fails: %s",
    async (_, api, reason) => {
      const result = await smoke(
        ["zap_api", "production"],
        { "https://zap.cireweddings.com/health": MISCONFIGURED },
        { api },
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain("::error title=Rollback failed::");
      expect(result.output).toContain(reason);
      expect(result.output).not.toContain("restored version");
    },
  );

  // A repeated restore could race a deploy, so a failed POST is reported,
  // never sent again.
  test.each([
    ["a 503", apiError(10_000, "Service unavailable", 503)],
    ["a network error", new TypeError("fetch failed")],
  ] as const)("DR5: the rollback's POST meeting %s is sent once", async (_, rollback) => {
    const result = await smoke(
      ["osn_api", "production"],
      { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
      { api: { rollback } },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.apiCalls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
    expect(result.sleeps.filter((ms) => ms !== 10_000)).toEqual([]);
    expect(result.output).toContain("::error title=Rollback failed::");
  });

  test("DR1: the rollback's read of the deployments retries a 503 through the injected sleep, then rolls back", async () => {
    const result = await smoke(
      ["osn_api", "production"],
      { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
      { api: { reads: [HISTORY, apiError(10_000, "Service unavailable", 503), HISTORY] } },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.sleeps.filter((ms) => ms !== 10_000)).toEqual([1_000]);
    expect(result.output).toContain("v-before");
  });

  test("with no Cloudflare credentials, the check says so and rolls nothing back", async () => {
    const result = await smoke(
      ["osn_api", "production"],
      { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
      { env: { CLOUDFLARE_API_TOKEN: "" } },
    );
    expect(result.code).toBe(1);
    expect(result.apiCalls).toEqual([]);
    expect(result.output).toContain("::error title=Rollback failed::");
    expect(result.output).toContain(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both set",
    );
  });

  test("an account ID that is not one is never put in a URL", async () => {
    const result = await smoke(
      ["osn_api", "production"],
      { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
      { env: { CLOUDFLARE_ACCOUNT_ID: "../../zones" } },
    );
    expect(result.code).toBe(1);
    expect(result.apiCalls).toEqual([]);
    expect(result.output).toContain("CLOUDFLARE_ACCOUNT_ID is not an account ID");
  });

  test("an answer cannot write a workflow command of its own", async () => {
    const hostile = () =>
      new Response("oops\n::add-mask::nothing\n::error::injected\r\n%0A::warning::encoded", {
        status: 500,
      });
    const result = await smoke(["zap_api", "production"], {
      "https://zap.cireweddings.com/health": hostile,
    });
    expect(result.code).toBe(1);
    // The runner reads a command only at the start of a line.
    const lines = result.output.split("\n").filter((line) => line !== "");
    for (const line of lines) {
      if (line.startsWith("::")) expect(line).toMatch(/^::(error|warning|notice)( title=[^:]+)?::/);
      expect(line.startsWith("::add-mask")).toBe(false);
      expect(line.startsWith("::error::injected")).toBe(false);
      expect(line.startsWith("::warning::encoded")).toBe(false);
    }
    expect(result.output).toContain("%250A::warning::encoded");
  });
});

describe("the rollback restores only what served before this job's deploy", () => {
  const BROKEN = { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED };

  async function withOutput(contents: string | undefined, api?: ApiOptions) {
    const dir = await mkdtemp(join(tmpdir(), "smoke-check-output-"));
    try {
      const file = join(dir, "wrangler-deploy.ndjson");
      if (contents !== undefined) await Bun.write(file, contents);
      return await smoke(["osn_api", "production"], BROKEN, {
        env: { WRANGLER_OUTPUT_FILE_PATH: file },
        api,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const deployEntry = (version: string) =>
    `${JSON.stringify({ type: "deploy", version: 1, version_id: version })}\n`;

  test("rolls back when the newest deployment is the version the deploy step reported", async () => {
    const result = await withOutput(deployEntry("v-this-job"));
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
  });

  test("refuses when another deploy landed before the check began", async () => {
    const result = await withOutput(deployEntry("v-this-job"), {
      reads: [[...HISTORY, deployment("dep-other", "2026-10-16T09:00:05Z", "v-other")]],
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("::error title=Rollback refused::");
    expect(result.output).toContain("serves v-other, not v-this-job");
  });

  test.each([
    ["is missing", undefined, "cannot be read"],
    [
      "names no deploy",
      `${JSON.stringify({ type: "wrangler-session" })}\n`,
      "names no deployed version",
    ],
  ])("fails, rolling nothing back, when the output file %s", async (_, contents, reason) => {
    const result = await withOutput(contents);
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("::error title=Rollback failed::");
    expect(result.output).toContain(reason);
  });

  test("a refused or failed rollback names the version to restore by hand, and claims nothing about what serves", async () => {
    const refused = await smoke(["osn_api", "production"], BROKEN, {
      api: { rollback: apiError(SECRETS_CHANGED, "secrets have changed: X") },
    });
    expect(refused.output).toContain("`bunx wrangler rollback v-before`");
    expect(refused.output).toContain("Check what osn-api-production serves");
    expect(refused.output).not.toContain("still runs");

    const timedOut = await smoke(["osn_api", "production"], BROKEN, {
      api: { rollback: new DOMException("The operation timed out.", "TimeoutError") },
    });
    expect(timedOut.output).toContain("::error title=Rollback failed::");
    expect(timedOut.output).toContain("Check what osn-api-production serves");
    expect(timedOut.output).not.toContain("still runs");
  });
});

describe("the step summary", () => {
  const BROKEN = { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED };
  const DOWN = {
    "https://id.musubi.social/health": UNREACHABLE,
    "https://id.musubi.social/.well-known/jwks.json": UNREACHABLE,
  };
  const label = "- **osn_api (production)**: ";

  async function summaryOf(
    answers: Record<string, Answer>,
    options: { env?: Record<string, string>; api?: ApiOptions } = {},
    args = ["osn_api", "production"],
  ) {
    const dir = await mkdtemp(join(tmpdir(), "smoke-check-"));
    try {
      const file = join(dir, "summary.md");
      const result = await smoke(args, answers, {
        ...options,
        env: { ...options.env, GITHUB_STEP_SUMMARY: file },
      });
      return { result, text: existsSync(file) ? await readFile(file, "utf8") : undefined };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test.each([
    [
      "nothing answered",
      DOWN,
      {},
      "smoke check failed without a wrong answer from the Worker; not rolled back.",
    ],
    [
      "rolled back, restored version healthy",
      {
        ...OSN_PROD,
        "https://id.musubi.social/health": (call: number) =>
          call <= 7 ? MISCONFIGURED() : HEALTHY(),
      },
      {},
      "smoke check failed; rolled back, and the restored version answers healthy.",
    ],
    [
      "rolled back, restored version still failing",
      BROKEN,
      {},
      "smoke check failed; rolled back, and the restored version is still failing.",
    ],
    [
      "rollback failed",
      BROKEN,
      { api: { rollback: apiError(10_000, "Authentication error", 403) } },
      "smoke check failed, and the rollback failed: Authentication error [code: 10000].",
    ],
    [
      "rollback refused",
      BROKEN,
      { api: { rollback: apiError(SECRETS_CHANGED, "secrets have changed: X") } },
      "smoke check failed; rollback refused: the secrets of osn-api-production changed since version v-before served, and restoring it would put the old values back (secrets have changed: X [code: 10220]).",
    ],
  ] as const)("%s writes exactly its line", async (_, answers, options, line) => {
    const { result, text } = await summaryOf(answers as Record<string, Answer>, options);
    expect(result.code).toBe(1);
    expect(text).toBe(`${label}${line}\n`);
  });

  test("a healthy run writes nothing", async () => {
    expect((await summaryOf(OSN_PROD)).text).toBeUndefined();
  });
});

describe("a failure the Worker did not cause", () => {
  test("hosts that never answer fail the step without a rollback", async () => {
    const result = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": UNREACHABLE,
      "https://id.musubi.social/.well-known/jwks.json": UNREACHABLE,
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("not rolling back");
  });

  test("requests that time out fail the step without a rollback", async () => {
    const timedOut = () => new DOMException("The operation timed out.", "TimeoutError");
    const result = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": timedOut,
      "https://id.musubi.social/.well-known/jwks.json": timedOut,
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("not rolling back");
  });

  test("a 429 on every probe — the account's request cap — fails the step without a rollback", async () => {
    const capped = () => new Response("error code: 1027", { status: 429 });
    const result = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": capped,
      "https://id.musubi.social/.well-known/jwks.json": capped,
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
  });

  test("Cloudflare Access answering fails the step without a rollback", async () => {
    const login = redirect("https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/x");
    const result = await smoke(
      ["cire_invites", "dev"],
      {
        [`${INVITES_DEV}/`]: login,
        [`${INVITES_DEV}/smoke-check-no-such-wedding`]: login,
      },
      { env: INVITES_ENV({ CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3cret" }) },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("Cloudflare");
    expect(result.output).not.toContain("s3cret");
  });

  test("one wrong answer among unreachable ones still rolls back", async () => {
    const result = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": MISCONFIGURED,
      "https://id.musubi.social/.well-known/jwks.json": UNREACHABLE,
    });
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
  });

  test("only the last round decides whether to roll back", async () => {
    // Wrong for six rounds, then no answer at all: no rollback.
    const fadesOut = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": (call) => (call <= 6 ? MISCONFIGURED() : UNREACHABLE()),
      "https://id.musubi.social/.well-known/jwks.json": UNREACHABLE,
    });
    expect(fadesOut.code).toBe(1);
    expect(fadesOut.posts).toEqual([]);

    // No answer for six rounds, then a wrong one: rolled back.
    const turnsWrong = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": (call) => (call <= 6 ? UNREACHABLE() : MISCONFIGURED()),
      "https://id.musubi.social/.well-known/jwks.json": UNREACHABLE,
    });
    expect(turnsWrong.code).toBe(1);
    expect(turnsWrong.posts).toHaveLength(1);
  });
});

describe("a dev site behind Cloudflare Access", () => {
  const TOKEN_ENV = { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3cret" };
  const login = () =>
    redirect("https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/x");
  const hasToken = (init: RequestInit | undefined) =>
    new Headers(init?.headers).has("cf-access-client-id");
  /** A host Access guards: the Worker answers a request with the service token, Access any other. */
  const guarded =
    (worker: () => Response): Answer =>
    (_, init) =>
      hasToken(init) ? worker() : login();
  /** The guest site's two routes, healthy, with `/` as `root` answers it. */
  const invites = (root: Answer): Record<string, Answer> => ({
    [`${INVITES_DEV}/`]: root,
    [`${INVITES_DEV}/smoke-check-no-such-wedding`]: guarded(() => html(404)),
  });
  const workerRoot = () => redirect(`${CIRE_LANDING_DEV}/`);

  test.each([
    ["no service token", {}],
    ["only the ID", { CF_ACCESS_CLIENT_ID: "id.access" }],
    ["only the secret", { CF_ACCESS_CLIENT_SECRET: "s3cret" }],
  ])(
    "with %s it probes without the token, and Access answering fails the step without a rollback",
    async (_, env) => {
      const result = await smoke(
        ["cire_invites", "dev"],
        {
          [`${INVITES_DEV}/`]: login,
          [`${INVITES_DEV}/smoke-check-no-such-wedding`]: login,
        },
        { env: INVITES_ENV(env) },
      );
      expect(result.code).toBe(1);
      expect(result.calls.length).toBeGreaterThan(0);
      for (const call of result.calls) {
        const headers = new Headers(call.init?.headers);
        expect(headers.has("cf-access-client-id")).toBe(false);
        expect(headers.has("cf-access-client-secret")).toBe(false);
      }
      expect(result.posts).toEqual([]);
      expect(result.output).toContain("CF_ACCESS_CLIENT_ID");
      expect(result.output).toContain("CF_ACCESS_CLIENT_SECRET");
      expect(result.output).not.toContain("s3cret");
    },
  );

  test("with a service token every Worker probe carries it, the Access probe of / does not, and a healthy guarded Worker passes", async () => {
    const result = await smoke(["cire_invites", "dev"], invites(guarded(workerRoot)), {
      env: INVITES_ENV(TOKEN_ENV),
    });
    expect(result.code).toBe(0);
    // Two rounds of the guest site's two probes, and the Access probe in each.
    const bare = result.calls.filter((call) => !hasToken(call.init));
    expect(bare.map((call) => call.url)).toEqual([`${INVITES_DEV}/`, `${INVITES_DEV}/`]);
    for (const call of bare) {
      expect(new Headers(call.init?.headers).has("cf-access-client-secret")).toBe(false);
      expect(call.init?.redirect).toBe("manual");
    }
    const tokened = result.calls.filter((call) => hasToken(call.init));
    expect(tokened).toHaveLength(4);
    for (const call of tokened) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("cf-access-client-id")).toBe("id.access");
      expect(headers.get("cf-access-client-secret")).toBe("s3cret");
    }
    for (const call of result.apiCalls) {
      expect(new Headers(call.init?.headers).has("cf-access-client-secret")).toBe(false);
    }
    expect(result.output).not.toContain("s3cret");
  });

  test.each([
    ["the Worker's own answer", workerRoot],
    ["a redirect to a host that is not Access", () => redirect("https://login.example.com/")],
    ["a 308 to Access", () => redirect("https://wispy-sun-215a.cloudflareaccess.com/x", 308)],
  ])(
    "AC1: / answering a request with no service token with %s fails the check, naming Access, and rolls nothing back",
    async (_, root) => {
      const result = await smoke(
        ["cire_invites", "dev"],
        invites((call, init) => (hasToken(init) ? workerRoot() : root())),
        { env: INVITES_ENV(TOKEN_ENV) },
      );
      expect(result.code).toBe(1);
      expect(result.posts).toEqual([]);
      expect(result.apiCalls.every((call) => call.init?.method !== "POST")).toBe(true);
      expect(result.output).toContain("::error title=Cloudflare Access::");
      expect(result.output).toContain("not rolling back");
      expect(result.output).not.toContain("rolling the Worker back");
      expect(result.output).not.toContain("s3cret");
    },
  );

  test("AC1: a Worker that answers wrongly is still rolled back when Access is missing too, and the restored version is judged on its own probes", async () => {
    const result = await smoke(
      ["cire_invites", "dev"],
      {
        // Access is missing: every request reaches the Worker. The guest
        // site's unknown-slug page fails until the rollback, then recovers.
        [`${INVITES_DEV}/`]: workerRoot,
        [`${INVITES_DEV}/smoke-check-no-such-wedding`]: (call) =>
          call <= 7 ? html(500) : html(404),
      },
      { env: INVITES_ENV(TOKEN_ENV) },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.output).toContain("::error title=Cloudflare Access::");
    expect(result.output).toContain("the restored version answers healthy");
  });

  test("AC1: a dev target with no Access makes no Access probe", async () => {
    for (const [surface, origin, answers] of [
      [
        "cire_api",
        CIRE_API_DEV,
        { [`${CIRE_API_DEV}/api/auth/session`]: json({ signedIn: false }) },
      ],
      [
        "osn_api",
        OSN_API_DEV,
        {
          [`${OSN_API_DEV}/health`]: HEALTHY,
          [`${OSN_API_DEV}/.well-known/jwks.json`]: JWKS,
          [`${OSN_API_DEV}/health/coordination`]: STORE_OK,
        },
      ],
      [
        "zap_api",
        "https://zap.cire.example.test",
        { "https://zap.cire.example.test/health": json({ status: "ok", service: "zap-api" }) },
      ],
    ] as const) {
      expect(devTarget(surface)?.access).toBe(false);
      const result = await smoke([surface, "dev"], answers, { env: devEnv(origin, TOKEN_ENV) });
      expect({ surface, code: result.code }).toEqual({ surface, code: 0 });
      expect(result.calls.map((call) => call.url)).not.toContain(`${origin}/`);
      expect(new Set(result.calls.map((call) => call.url))).toEqual(new Set(Object.keys(answers)));
    }
  });

  test.each([401, 403])(
    "Access refusing the token with a %i fails the step without a rollback",
    async (status) => {
      const refused = () => new Response("Forbidden", { status });
      const result = await smoke(
        ["cire_invites", "dev"],
        {
          [`${INVITES_DEV}/`]: refused,
          [`${INVITES_DEV}/smoke-check-no-such-wedding`]: refused,
        },
        { env: INVITES_ENV(TOKEN_ENV) },
      );
      expect(result.code).toBe(1);
      expect(result.posts).toEqual([]);
      expect(result.output).toContain("Cloudflare Access refused the service token");
    },
  );

  test("a host with no Access never receives the token", async () => {
    const result = await smoke(
      ["osn_api", "dev"],
      {
        [`${OSN_API_DEV}/health`]: HEALTHY,
        [`${OSN_API_DEV}/.well-known/jwks.json`]: JWKS,
        [`${OSN_API_DEV}/health/coordination`]: STORE_OK,
      },
      { env: devEnv(OSN_API_DEV, TOKEN_ENV) },
    );
    expect(result.code).toBe(0);
    for (const call of result.calls)
      expect(new Headers(call.init?.headers).has("cf-access-client-secret")).toBe(false);
  });
});

describe("dev learns its host and its deployment from the stack job", () => {
  const BROKEN_CIRE_API = { [`${CIRE_API_DEV}/api/auth/session`]: json({ error: "x" }, 500) };

  test("without SMOKE_ORIGIN, or the guest site without SMOKE_MARKETING_ORIGIN, it exits 2 asking nothing", async () => {
    for (const [args, env] of [
      [["cire_api", "dev"], { SMOKE_DEPLOYMENT: DEP_THIS_JOB }],
      [["cire_api", "dev"], devEnv("")],
      [["cire_invites", "dev"], devEnv(INVITES_DEV)],
    ] as const) {
      const result = await smoke([...args], {}, { env });
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.apiCalls).toEqual([]);
      expect(result.output).toContain("SMOKE_");
    }
  });

  test.each([
    "http://api.cire.example.test",
    "https://api.cire.example.test/",
    "https://api.cire.example.test/api",
    "https://api.cire.example.test?x=1",
    "https://user@api.cire.example.test",
    "api.cire.example.test",
    " https://api.cire.example.test",
  ])("SMOKE_ORIGIN %j is not an https origin: exit 2, asking nothing", async (origin) => {
    const result = await smoke(["cire_api", "dev"], {}, { env: devEnv(origin) });
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.apiCalls).toEqual([]);
    expect(result.output).toContain("SMOKE_ORIGIN");
  });

  test.each([
    undefined,
    "",
    "dep this job",
    "unchanged\nx=1",
    "-dep",
    "Unchanged",
    "UNKNOWN",
    "none",
    "dep-this-job",
    `${DEP_THIS_JOB}0`,
  ])(
    "SMOKE_DEPLOYMENT %j is not a deployment id or a known word: exit 2, asking nothing",
    async (value) => {
      const result = await smoke(
        ["cire_api", "dev"],
        {},
        { env: devEnv(CIRE_API_DEV, { SMOKE_DEPLOYMENT: value }) },
      );
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.apiCalls).toEqual([]);
      expect(result.output).toContain("SMOKE_DEPLOYMENT");
    },
  );

  test("a Worker this run deployed nothing to is never rolled back", async () => {
    const result = await smoke(["cire_api", "dev"], BROKEN_CIRE_API, {
      env: devEnv(CIRE_API_DEV, { SMOKE_DEPLOYMENT: "unchanged" }),
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("::error title=Rollback refused::");
    expect(result.output).toContain("this run deployed nothing to cire-api-dev");
  });

  test.each([
    ["holds only the deployment this run made", [HISTORY[1]!], "first deploy"],
    ["is empty", [], "has no deployments"],
  ] as const)(
    "Q18: a dev Worker failing its check when its history %s is not rolled back, and the step says why",
    async (_, history, reason) => {
      const result = await smoke(["cire_api", "dev"], BROKEN_CIRE_API, {
        env: devEnv(CIRE_API_DEV),
        api: { reads: [history] },
      });
      expect(result.code).toBe(1);
      expect(result.posts).toEqual([]);
      expect(result.output).toContain("::error title=Rollback failed::");
      expect(result.output).toContain(reason);
      expect(result.output).not.toContain("restored version");
    },
  );

  test("a deployment that is no longer the newest is never rolled back", async () => {
    const result = await smoke(["cire_api", "dev"], BROKEN_CIRE_API, {
      env: devEnv(CIRE_API_DEV, { SMOKE_DEPLOYMENT: DEP_BEFORE }),
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("::error title=Rollback refused::");
    expect(result.output).toContain("deployed again since this run");
  });

  test("an unchanged Worker still serving an earlier smoke check's rollback fails at once, naming the fix", async () => {
    const restored: Deployment = {
      ...deployment("dep-restored", "2026-10-16T10:00:00Z", "v-before"),
      annotations: { "workers/message": rollbackMessage(RUN_ENV) },
    };
    const result = await smoke(
      ["cire_api", "dev"],
      { [`${CIRE_API_DEV}/api/auth/session`]: json({ signedIn: false }) },
      {
        env: devEnv(CIRE_API_DEV, { SMOKE_DEPLOYMENT: "unchanged" }),
        api: { reads: [[...HISTORY, restored]] },
      },
    );
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("an earlier smoke check restored cire-api-dev");
    expect(result.output).toContain("--force");
  });

  test.each([
    ["Cloudflare refuses the read", { api: { reads: [apiError(10_000, "Internal error", 500)] } }],
    [
      "the job has no Cloudflare credentials",
      { env: { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined } },
    ],
  ] as const)(
    "an unchanged Worker whose history cannot be read fails without a probe or a rollback: %s",
    async (_, options) => {
      const env = {
        ...devEnv(CIRE_API_DEV, { SMOKE_DEPLOYMENT: "unchanged" }),
        ...("env" in options ? options.env : {}),
      };
      const result = await smoke(
        ["cire_api", "dev"],
        { [`${CIRE_API_DEV}/api/auth/session`]: json({ signedIn: false }) },
        { env, api: "api" in options ? options.api : undefined },
      );
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.posts).toEqual([]);
      expect(result.output).toContain("could not be read");
      expect(result.output).toContain("earlier smoke check restored cire-api-dev");
    },
  );

  test("an unreadable deployment is probed but never rolled back", async () => {
    const env = devEnv(CIRE_API_DEV, { SMOKE_DEPLOYMENT: "unknown" });
    const broken = await smoke(["cire_api", "dev"], BROKEN_CIRE_API, { env });
    expect(broken.code).toBe(1);
    expect(broken.calls.length).toBeGreaterThan(0);
    expect(broken.posts).toEqual([]);
    expect(broken.output).toContain("could not be read");

    const healthy = await smoke(
      ["cire_api", "dev"],
      { [`${CIRE_API_DEV}/api/auth/session`]: json({ signedIn: false }) },
      { env },
    );
    expect(healthy.code).toBe(0);
    expect(healthy.output).toContain("could not be read");
  });
});

describe("a production site the production stack deployed", () => {
  const STAGED_SOCIAL = "https://next.musubi.social";
  const siteEnv = (extra: Record<string, string | undefined> = {}) => ({
    SMOKE_ORIGIN: STAGED_SOCIAL,
    SMOKE_DEPLOYMENT: DEP_THIS_JOB,
    ...extra,
  });
  const appFile = (type: string, body: string) =>
    new Response(body, { status: 200, headers: { "content-type": type } });
  const SOCIAL = (association: Response) => ({
    [`${STAGED_SOCIAL}/`]: html(200),
    [`${STAGED_SOCIAL}/smoke-check-deep-link`]: html(200),
    [`${STAGED_SOCIAL}/.well-known/apple-app-site-association`]: association,
  });

  test("SM1: probes the host the stack job names, the app's deep link and its app-site association, with no Access token", async () => {
    const result = await smoke(
      ["osn_social", "production"],
      SOCIAL(appFile("application/json", '{"webcredentials":{"apps":["X.social.musubi"]}}')),
      { env: siteEnv({ CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret" }) },
    );
    expect(result.code).toBe(0);
    expect([...new Set(result.calls.map((call) => call.url))].toSorted()).toEqual(
      Object.keys(SOCIAL(html(200))).toSorted(),
    );
    for (const call of result.calls) {
      expect(new Headers(call.init?.headers).get("cf-access-client-id")).toBeNull();
    }
    expect(result.posts).toEqual([]);
  });

  test("SM3: an app-site association not served as application/json fails the check and rolls back this run's deployment", async () => {
    const result = await smoke(["osn_social", "production"], SOCIAL(appFile("text/html", "<p>")), {
      env: siteEnv(),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("expected 200 application/json");
    expect(result.posts).toHaveLength(1);
  });

  test("a refused rollback names the version that served before, and never tells anyone to roll the stack's Worker back by hand", async () => {
    const result = await smoke(["osn_social", "production"], SOCIAL(appFile("text/html", "<p>")), {
      env: siteEnv(),
      api: { rollback: apiError(SECRETS_CHANGED, "secrets have changed: X") },
    });
    expect(result.code).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.output).toContain("::error title=Rollback refused::");
    expect(result.output).toContain("The version that served before this deploy is v-before.");
    expect(result.output).not.toContain("wrangler rollback");
  });

  test("SM2: without an https SMOKE_ORIGIN or a SMOKE_DEPLOYMENT it exits 2, asking nothing", async () => {
    for (const env of [
      { SMOKE_DEPLOYMENT: DEP_THIS_JOB },
      siteEnv({ SMOKE_ORIGIN: "http://next.musubi.social" }),
      siteEnv({ SMOKE_DEPLOYMENT: undefined }),
      siteEnv({ SMOKE_DEPLOYMENT: "latest" }),
    ]) {
      const result = await smoke(["osn_social", "production"], {}, { env });
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.apiCalls).toEqual([]);
      expect(result.output).toContain("SMOKE_");
    }
  });
});

describe("usage", () => {
  test.each([
    [["osn_api"]],
    [["osn_api", "staging"]],
    [["osn_social", "production"]],
    [["no_such_surface", "dev"]],
    [["osn_api", "dev", "extra"]],
  ])("%j is refused with exit 2, asking nothing and rolling nothing back", async (args) => {
    const result = await smoke(args, {});
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.apiCalls).toEqual([]);
    expect(result.output).toContain("::error");
  });
});

describe("rollbackMessage", () => {
  test("names the run and its attempt", () => {
    expect(rollbackMessage(RUN_ENV)).toBe(
      "Smoke check failed: https://github.com/englishstreetventures/osn/actions/runs/38720122405/attempts/2",
    );
  });

  test("stays within 120 characters", () => {
    const long = rollbackMessage({ ...RUN_ENV, GITHUB_REPOSITORY: `${"o".repeat(80)}/osn` });
    expect(long.length).toBeLessThanOrEqual(120);
  });

  test("falls back to github.com, and leaves out an unknown attempt", () => {
    expect(
      rollbackMessage({ GITHUB_REPOSITORY: "englishstreetventures/osn", GITHUB_RUN_ID: "7" }),
    ).toBe("Smoke check failed: https://github.com/englishstreetventures/osn/actions/runs/7");
  });

  test("says so when no run is known", () => {
    expect(rollbackMessage({})).toBe("Smoke check failed outside GitHub Actions");
    expect(rollbackMessage({ GITHUB_REPOSITORY: "englishstreetventures/osn" })).toBe(
      "Smoke check failed outside GitHub Actions",
    );
  });
});

describe("annotation", () => {
  test("escapes what would end the line or be read as a command", () => {
    expect(annotation("error", "a\nb\r%c")).toBe("::error::a%0Ab%0D%25c\n");
    expect(annotation("error", "x", "a: b, c")).toBe("::error title=a%3A b%2C c::x\n");
  });
});

describe("SMOKE_TARGETS", () => {
  test("covers every surface on dev, and production for the four Workers production deploys", () => {
    const keys = Object.keys(SMOKE_TARGETS) as (keyof typeof SMOKE_TARGETS)[];
    expect(keys.filter((key) => devTarget(key) === undefined)).toEqual([]);
    expect(keys.filter((key) => productionTarget(key) !== undefined).toSorted()).toEqual([
      "cire_api",
      "cire_invites",
      "osn_api",
      "zap_api",
    ]);
  });

  test("SM1: names the Worker each production site stack deploys, by its production name", () => {
    const keys = Object.keys(SMOKE_TARGETS) as (keyof typeof SMOKE_TARGETS)[];
    expect(
      Object.fromEntries(
        keys.flatMap((key) => {
          const worker = productionSiteTarget(key)?.worker;
          return worker === undefined ? [] : [[key, worker]];
        }),
      ),
    ).toEqual({
      cire_host: "cire-host",
      cire_vendor: "cire-vendor",
      cire_landing: "cire-landing",
      osn_social: "osn-social",
      musubi_landing: "musubi-landing",
      pulse_landing: "pulse-landing",
    });
    // No surface is both: a site Worker is the stack's, an API Worker Wrangler's.
    expect(keys.filter((key) => productionSiteTarget(key) && productionTarget(key))).toEqual([]);
  });

  test("checks osn-api's JWKS on both tiers", () => {
    const dev = devTarget("osn_api")?.probes({ origin: OSN_API_DEV });
    const production = productionTarget("osn_api")?.probes;
    for (const probes of [dev, production]) {
      expect(probes?.map((p) => p.expects.kind)).toContain("jwks");
    }
  });

  test("checks osn-api's coordination store round trip on both tiers", () => {
    const dev = devTarget("osn_api")?.probes({ origin: OSN_API_DEV });
    const production = productionTarget("osn_api")?.probes;
    expect(dev).toContainEqual({
      url: `${OSN_API_DEV}/health/coordination`,
      expects: { kind: "json", fields: { ok: true } },
      bearer: "INTERNAL_SERVICE_SECRET",
    });
    expect(production).toContainEqual({
      url: "https://id.musubi.social/health/coordination",
      expects: { kind: "json", fields: { ok: true } },
      bearer: "INTERNAL_SERVICE_SECRET",
    });
  });
});

describe("the coordination probe's bearer", () => {
  const COORDINATION = "https://id.musubi.social/health/coordination";
  const authorizationOf = (init: RequestInit | undefined) =>
    new Headers(init?.headers).get("authorization");

  test("goes to the coordination probe alone, and never into the output", async () => {
    const result = await smoke(["osn_api", "production"], OSN_PROD);
    expect(result.code).toBe(0);
    for (const call of result.calls) {
      expect(authorizationOf(call.init)).toBe(
        call.url === COORDINATION ? `Bearer ${SMOKE_SECRET}` : null,
      );
    }
    expect(result.output).not.toContain(SMOKE_SECRET);
  });

  test("goes nowhere on a surface whose probes name none", async () => {
    const result = await smoke(["cire_api", "production"], {
      "https://api.cireweddings.com/api/auth/session": () => json({ signedIn: false }),
    });
    expect(result.code).toBe(0);
    expect(result.calls.map((call) => authorizationOf(call.init))).toEqual([null, null]);
  });

  test("a 401 to it fails the check without rolling the Worker back", async () => {
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      [COORDINATION]: () => json({ error: "unauthorized" }, 401),
    });
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
    expect(result.output).toContain("INTERNAL_SERVICE_SECRET");
  });

  test("without INTERNAL_SERVICE_SECRET, osn-api's check is a usage error before any request", async () => {
    for (const value of [undefined, ""]) {
      const result = await smoke(["osn_api", "production"], OSN_PROD, {
        env: { INTERNAL_SERVICE_SECRET: value },
      });
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.apiCalls).toEqual([]);
      expect(result.output).toContain("INTERNAL_SERVICE_SECRET is not set");
    }
  });
});
