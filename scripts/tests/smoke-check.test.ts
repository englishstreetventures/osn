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

import {
  annotation,
  type Deployment,
  deployedVersion,
  FORCED_FAILURE_PATH,
  judge,
  type Outcome,
  probeOnce,
  type Probe,
  restorePlan,
  rollbackMessage,
  runSmokeCheck,
  SECRETS_CHANGED,
  SMOKE_TARGETS,
  smokeTarget,
  type WorkerSurface,
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

const OSN_PROD = {
  "https://id.musubi.social/health": HEALTHY,
  "https://id.musubi.social/.well-known/jwks.json": JWKS,
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

/** This job's deploy, and the one before it, listed oldest first to prove the sort. */
const HISTORY: readonly Deployment[] = [
  deployment("dep-before", "2026-10-15T09:00:00Z", "v-before"),
  deployment("dep-this-job", "2026-10-16T09:00:00Z", "v-this-job"),
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

const RUN_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "englishstreetventures/osn",
  GITHUB_RUN_ID: "38720122405",
  GITHUB_RUN_ATTEMPT: "2",
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
};

const workerOf = (args: readonly string[]) => {
  const [surface, tier] = args;
  if (surface === undefined || !(surface in SMOKE_TARGETS)) return undefined;
  if (tier !== "dev" && tier !== "production") return undefined;
  return smokeTarget(surface as WorkerSurface, tier)?.worker;
};

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

  test("Cloudflare Access answering is blocked, not wrong, on any host", async () => {
    const login = redirect(
      "https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/invite.dev.cireweddings.com?kid=1&meta=secretish",
    );
    const outcome = await verdict(HEALTH, login);
    expect(outcome.kind).toBe("blocked");
    // The login URL's query is noise at best; only its origin is reported.
    expect(reasonOf(outcome)).not.toContain("meta=");
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

  test("never follows a redirect, sends the extra headers, and bounds the request", async () => {
    const http = fakeFetch({ "https://id.musubi.social/health": HEALTHY });
    const outcome = await probeOnce(HEALTH, {
      ...options(http.fetch),
      headers: { "cf-access-client-id": "id" },
    });
    expect(outcome).toEqual({ kind: "pass" });
    const init = http.calls[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("cf-access-client-id")).toBe("id");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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

  test("the Cloudflare token goes to the Cloudflare API only, never to a probed host", async () => {
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": MISCONFIGURED,
    });
    for (const call of result.calls) {
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }
    expect(result.output).not.toContain(TOKEN);
  });

  test("rolls back the dev Worker on dev, and the guest site's own Worker", async () => {
    const dev = await smoke(["cire_api", "dev"], {
      "https://api.dev.cireweddings.com/api/auth/session": json({ error: "Not found" }, 404),
    });
    expect(dev.code).toBe(1);
    expect(dev.posts).toHaveLength(1);
    expect(dev.apiCalls.every((c) => c.url === deploymentsUrl("cire-api-dev"))).toBe(true);

    const invites = await smoke(["cire_invites", "production"], {
      "https://invite.cireweddings.com/": html(500),
      "https://invite.cireweddings.com/smoke-check-no-such-wedding": html(500),
    });
    expect(invites.code).toBe(1);
    expect(invites.posts).toHaveLength(1);
    expect(invites.apiCalls.every((c) => c.url === deploymentsUrl("cire-invites"))).toBe(true);
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

  test("a healthy run and a skipped one write nothing", async () => {
    expect((await summaryOf(OSN_PROD)).text).toBeUndefined();
    expect((await summaryOf({}, {}, ["cire_invites", "dev"])).text).toBeUndefined();
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
        "https://invite.dev.cireweddings.com/": login,
        "https://invite.dev.cireweddings.com/smoke-check-no-such-wedding": login,
      },
      { env: { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3cret" } },
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

describe("the guest site's dev host sits behind Cloudflare Access", () => {
  const TOKEN_ENV = { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3cret" };

  test("with no service token the check is skipped, with a warning, and asks nothing", async () => {
    const result = await smoke(["cire_invites", "dev"], {});
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.apiCalls).toEqual([]);
    expect(result.output).toContain("::warning");
    expect(result.output).toContain("CF_ACCESS_CLIENT_ID");
  });

  test.each([
    ["only the ID", { CF_ACCESS_CLIENT_ID: "id.access" }],
    ["only the secret", { CF_ACCESS_CLIENT_SECRET: "s3cret" }],
  ])("with %s the check is skipped too", async (_, env) => {
    const result = await smoke(["cire_invites", "dev"], {}, { env });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain("::warning::Smoke check skipped for cire_invites (dev)");
  });

  test("with a service token every probe carries it, and a healthy Worker passes", async () => {
    const result = await smoke(
      ["cire_invites", "dev"],
      {
        "https://invite.dev.cireweddings.com/": redirect("https://dev.cireweddings.com/"),
        "https://invite.dev.cireweddings.com/smoke-check-no-such-wedding": html(404),
      },
      { env: TOKEN_ENV },
    );
    expect(result.code).toBe(0);
    for (const call of result.calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("cf-access-client-id")).toBe("id.access");
      expect(headers.get("cf-access-client-secret")).toBe("s3cret");
    }
    for (const call of result.apiCalls) {
      expect(new Headers(call.init?.headers).has("cf-access-client-secret")).toBe(false);
    }
    expect(result.output).not.toContain("s3cret");
  });

  test.each([401, 403])(
    "Access refusing the token with a %i fails the step without a rollback",
    async (status) => {
      const refused = () => new Response("Forbidden", { status });
      const result = await smoke(
        ["cire_invites", "dev"],
        {
          "https://invite.dev.cireweddings.com/": refused,
          "https://invite.dev.cireweddings.com/smoke-check-no-such-wedding": refused,
        },
        { env: TOKEN_ENV },
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
        "https://id.dev.musubi.social/health": HEALTHY,
        "https://id.dev.musubi.social/.well-known/jwks.json": JWKS,
      },
      { env: TOKEN_ENV },
    );
    expect(result.code).toBe(0);
    for (const call of result.calls)
      expect(new Headers(call.init?.headers).has("cf-access-client-secret")).toBe(false);
  });
});

describe("the dry run", () => {
  test("SMOKE_FORCE_FAIL on dev asks for a path the Worker answers 404, rolls back, and reports the restored version healthy", async () => {
    const forced = `https://id.dev.musubi.social${FORCED_FAILURE_PATH}`;
    const result = await smoke(
      ["osn_api", "dev"],
      {
        "https://id.dev.musubi.social/health": HEALTHY,
        "https://id.dev.musubi.social/.well-known/jwks.json": JWKS,
        [forced]: new Response("NOT_FOUND", { status: 404 }),
      },
      { env: { SMOKE_FORCE_FAIL: "true" } },
    );
    expect(result.code).toBe(1);
    expect(fetchesOf(result, forced)).toBe(8);
    expect(result.posts).toHaveLength(1);
    expect(result.apiCalls.every((c) => c.url === deploymentsUrl("osn-api-dev"))).toBe(true);
    expect(result.output).toContain(forced);
    // The forced probe fails on every version; it is no verdict on the one restored.
    expect(result.output).toContain("the restored version answers healthy");
    expect(result.output).not.toContain("still failing");
  });

  test("SMOKE_FORCE_FAIL false is an ordinary check", async () => {
    const result = await smoke(
      ["osn_api", "dev"],
      {
        "https://id.dev.musubi.social/health": HEALTHY,
        "https://id.dev.musubi.social/.well-known/jwks.json": JWKS,
      },
      { env: { SMOKE_FORCE_FAIL: "false" } },
    );
    expect(result.code).toBe(0);
  });

  test("the dry run runs even with no Access token, and Access then fails it without a rollback", async () => {
    const login = redirect("https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/x");
    const result = await smoke(
      ["cire_invites", "dev"],
      {
        "https://invite.dev.cireweddings.com/": login,
        "https://invite.dev.cireweddings.com/smoke-check-no-such-wedding": login,
        [`https://invite.dev.cireweddings.com${FORCED_FAILURE_PATH}`]: login,
      },
      { env: { SMOKE_FORCE_FAIL: "true" } },
    );
    expect(result.code).toBe(1);
    expect(result.posts).toEqual([]);
  });

  test("production refuses the dry run before asking anything", async () => {
    const result = await smoke(["osn_api", "production"], OSN_PROD, {
      env: { SMOKE_FORCE_FAIL: "true" },
    });
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.apiCalls).toEqual([]);
  });
});

describe("usage", () => {
  test.each([
    [["osn_api"]],
    [["osn_api", "staging"]],
    [["osn_social", "production"]],
    [["zap_api", "dev"]],
    [["osn_api", "dev", "extra"]],
  ])("%j is refused with exit 2, asking nothing and rolling nothing back", async (args) => {
    const result = await smoke(args, {});
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.apiCalls).toEqual([]);
    expect(result.output).toContain("::error");
  });

  test("SMOKE_FORCE_FAIL takes true or false only", async () => {
    const result = await smoke(["osn_api", "dev"], {}, { env: { SMOKE_FORCE_FAIL: "yes" } });
    expect(result.code).toBe(2);
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
  test("covers exactly the Worker surfaces, production for all and dev for those with a dev Worker", () => {
    expect(Object.keys(SMOKE_TARGETS).toSorted()).toEqual([
      "cire_api",
      "cire_invites",
      "osn_api",
      "zap_api",
    ]);
    expect(Object.keys(SMOKE_TARGETS.zap_api)).toEqual(["production"]);
    for (const key of ["cire_api", "cire_invites", "osn_api"] as const)
      expect(Object.keys(SMOKE_TARGETS[key]).toSorted()).toEqual(["dev", "production"]);
  });

  test("checks osn-api's JWKS on both tiers", () => {
    for (const tier of ["dev", "production"] as const) {
      const kinds = SMOKE_TARGETS.osn_api[tier]?.probes.map((p) => p.expects.kind);
      expect(kinds).toContain("jwks");
    }
  });
});
