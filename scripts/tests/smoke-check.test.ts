// scripts/smoke-check.ts runs after every Worker deploy in deploy.yml (dev)
// and production-release.yml (production): it asks the Worker's own hosts
// whether the new version answers, and rolls the Worker back when it does not.
// These drive it with an injected fetch, a fake clock and a fake process
// runner, so the rollback path — the one nobody wants to meet first in
// production — runs on every `bun test`.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FORCED_FAILURE_PATH,
  judge,
  type Outcome,
  probeOnce,
  type Probe,
  rollbackMessage,
  runSmokeCheck,
  SMOKE_TARGETS,
} from "../smoke-check";

// ── fixtures ────────────────────────────────────────────────────────────────

type Answer = Response | Error | ((call: number) => Response | Error);

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
    const value = typeof answer === "function" ? answer(call) : answer;
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

/** Records every command the script runs, answering each with `exitCode`. */
function fakeRunner(exitCode = 0) {
  const runs: { command: string[]; cwd: string }[] = [];
  return {
    run: async (command: readonly string[], cwd: string) => {
      runs.push({ command: [...command], cwd });
      return exitCode;
    },
    runs,
  };
}

const RUN_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "englishstreetventures/osn",
  GITHUB_RUN_ID: "38720122405",
  GITHUB_RUN_ATTEMPT: "2",
};

async function smoke(
  args: string[],
  answers: Record<string, Answer>,
  options: { env?: Record<string, string>; exitCode?: number } = {},
) {
  const http = fakeFetch(answers);
  const clock = fakeClock();
  const runner = fakeRunner(options.exitCode ?? 0);
  const lines: string[] = [];
  const code = await runSmokeCheck({
    args,
    env: { ...RUN_ENV, ...options.env },
    fetch: http.fetch,
    now: clock.now,
    sleep: clock.sleep,
    run: runner.run,
    root: "/repo",
    out: (text) => lines.push(text),
  });
  return {
    code,
    calls: http.calls,
    sleeps: clock.sleeps,
    runs: runner.runs,
    output: lines.join(""),
  };
}

const probe = (url: string, expects: Probe["expects"]): Probe => ({ url, expects });
const HEALTH = probe("https://id.musubi.social/health", { kind: "json", fields: { status: "ok" } });

// ── what counts as healthy ──────────────────────────────────────────────────

describe("judge", () => {
  const verdict = async (p: Probe, response: Response, access = false): Promise<Outcome> =>
    judge(p, response, await response.text(), access);

  test("a JSON probe passes on a 200 whose fields match", async () => {
    expect(await verdict(HEALTH, HEALTHY())).toEqual({ kind: "pass" });
  });

  test("a fail-closed 503 is a wrong answer, and the reason carries the status and the body", async () => {
    const outcome = await verdict(HEALTH, MISCONFIGURED());
    expect(outcome.kind).toBe("wrong");
    expect(outcome.kind !== "pass" && outcome.reason).toContain("503");
    expect(outcome.kind !== "pass" && outcome.reason).toContain("missing OSN_TOTP_ENCRYPTION_KEY");
  });

  test("a 200 with the wrong field, or no JSON at all, is wrong", async () => {
    expect((await verdict(HEALTH, json({ status: "degraded" }))).kind).toBe("wrong");
    expect((await verdict(HEALTH, html(200))).kind).toBe("wrong");
  });

  test("the session probe wants signedIn false", async () => {
    const session = probe("https://api.cireweddings.com/api/auth/session", {
      kind: "json",
      fields: { signedIn: false },
    });
    expect(await verdict(session, json({ signedIn: false }))).toEqual({ kind: "pass" });
    expect((await verdict(session, json({ error: "Not found" }, 404))).kind).toBe("wrong");
  });

  test("a JWKS probe wants an ES256 P-256 key", async () => {
    const jwks = probe("https://id.musubi.social/.well-known/jwks.json", { kind: "jwks" });
    expect(await verdict(jwks, JWKS())).toEqual({ kind: "pass" });
    expect((await verdict(jwks, json({ keys: [] }))).kind).toBe("wrong");
    expect((await verdict(jwks, json({ keys: [{ kty: "RSA", alg: "RS256" }] }))).kind).toBe(
      "wrong",
    );
    expect((await verdict(jwks, json({}))).kind).toBe("wrong");
  });

  test("a redirect probe wants a redirect to the expected origin", async () => {
    const root = probe("https://invite.cireweddings.com/", {
      kind: "redirect",
      to: "https://cireweddings.com",
    });
    expect(await verdict(root, redirect("https://cireweddings.com/"))).toEqual({ kind: "pass" });
    expect(await verdict(root, redirect("https://cireweddings.com", 307))).toEqual({
      kind: "pass",
    });
    expect((await verdict(root, redirect("https://evil.example/"))).kind).toBe("wrong");
    expect((await verdict(root, html(200))).kind).toBe("wrong");
    expect((await verdict(root, new Response(null, { status: 302 }))).kind).toBe("wrong");
  });

  test("a page probe takes a rendered 404 or 200, and nothing else", async () => {
    const page = probe("https://invite.cireweddings.com/smoke-check-no-such-wedding", {
      kind: "page",
    });
    expect(await verdict(page, html(404))).toEqual({ kind: "pass" });
    expect(await verdict(page, html(200))).toEqual({ kind: "pass" });
    expect((await verdict(page, html(500))).kind).toBe("wrong");
    expect((await verdict(page, json({ error: "x" }, 404))).kind).toBe("wrong");
  });

  test("Cloudflare Access answering is blocked, not wrong, on any host", async () => {
    const login = redirect(
      "https://wispy-sun-215a.cloudflareaccess.com/cdn-cgi/access/login/invite.dev.cireweddings.com?kid=1&meta=secretish",
    );
    const outcome = await verdict(HEALTH, login);
    expect(outcome.kind).toBe("blocked");
    // The login URL's query is noise at best; only its origin is reported.
    expect(outcome.kind !== "pass" && outcome.reason).not.toContain("meta=");
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
  });

  test("a Cloudflare bot challenge is blocked, not wrong", async () => {
    const challenge = new Response("<html>Just a moment...</html>", {
      status: 403,
      headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
    });
    expect((await verdict(HEALTH, challenge)).kind).toBe("blocked");
  });
});

describe("probeOnce", () => {
  test("never follows a redirect, sends the extra headers, and bounds the request", async () => {
    const http = fakeFetch({ "https://id.musubi.social/health": HEALTHY });
    const outcome = await probeOnce(HEALTH, {
      fetch: http.fetch,
      headers: { "cf-access-client-id": "id" },
      access: false,
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ kind: "pass" });
    const init = http.calls[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("cf-access-client-id")).toBe("id");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("no answer at all is unreachable, not wrong", async () => {
    const http = fakeFetch({ "https://id.musubi.social/health": new TypeError("fetch failed") });
    const outcome = await probeOnce(HEALTH, {
      fetch: http.fetch,
      headers: {},
      access: false,
      timeoutMs: 10_000,
    });
    expect(outcome.kind).toBe("unreachable");
    expect(outcome.kind !== "pass" && outcome.reason).toContain("fetch failed");
  });
});

// ── the run ─────────────────────────────────────────────────────────────────

describe("a healthy deploy", () => {
  test("passes on two rounds ten seconds apart and rolls nothing back", async () => {
    const result = await smoke(["osn_api", "production"], OSN_PROD);
    expect(result.code).toBe(0);
    expect(result.runs).toEqual([]);
    expect(result.sleeps).toEqual([10_000]);
    expect(result.calls.map((c) => c.url).toSorted()).toEqual(
      [...Object.keys(OSN_PROD), ...Object.keys(OSN_PROD)].toSorted(),
    );
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
    expect(result.runs).toEqual([]);
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
    expect(result.runs).toEqual([]);
  });
});

describe("a broken deploy", () => {
  test("retries for a minute, then rolls the Worker back with a message naming the run", async () => {
    const result = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": MISCONFIGURED,
    });
    expect(result.code).toBe(1);
    // Seven rounds: 0, 10, … 60 s.
    expect(result.sleeps.slice(0, 6)).toEqual(Array(6).fill(10_000));
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toEqual({
      command: [
        "bunx",
        "wrangler",
        "rollback",
        "--env",
        "production",
        "--message",
        "Smoke check failed: https://github.com/englishstreetventures/osn/actions/runs/38720122405/attempts/2",
        "--yes",
      ],
      cwd: "/repo/osn/api",
    });
    expect(result.output).toContain("::error");
    expect(result.output).toContain("https://id.musubi.social/health");
    expect(result.output).toContain("missing OSN_TOTP_ENCRYPTION_KEY");
  });

  test("rolls back the dev Worker on dev, and the generated config for the guest site", async () => {
    const dev = await smoke(["cire_api", "dev"], {
      "https://api.dev.cireweddings.com/api/auth/session": json({ error: "Not found" }, 404),
    });
    expect(dev.code).toBe(1);
    expect(dev.runs[0]?.command.slice(0, 5)).toEqual([
      "bunx",
      "wrangler",
      "rollback",
      "--env",
      "dev",
    ]);
    expect(dev.runs[0]?.cwd).toBe("/repo/cire/api");

    const invites = await smoke(["cire_invites", "production"], {
      "https://invite.cireweddings.com/": html(500),
      "https://invite.cireweddings.com/smoke-check-no-such-wedding": html(500),
    });
    expect(invites.code).toBe(1);
    expect(invites.runs[0]?.command.slice(0, 5)).toEqual([
      "bunx",
      "wrangler",
      "rollback",
      "--config",
      "dist/server/wrangler.json",
    ]);
    expect(invites.runs[0]?.cwd).toBe("/repo/cire/invites");
  });

  test("after the rollback, one more round says whether the restored version answers", async () => {
    // Every round of the check fails; the round after the rollback passes.
    const rounds = 7;
    const restored = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": (call) => (call <= rounds ? MISCONFIGURED() : HEALTHY()),
    });
    expect(restored.code).toBe(1);
    expect(restored.output).toContain("restored version answers");

    const still = await smoke(["osn_api", "production"], {
      ...OSN_PROD,
      "https://id.musubi.social/health": MISCONFIGURED,
    });
    expect(still.code).toBe(1);
    expect(still.output).toContain("still failing");
  });

  test("a rollback that fails is reported, and the step still fails", async () => {
    const result = await smoke(
      ["zap_api", "production"],
      { "https://zap.cireweddings.com/health": MISCONFIGURED },
      { exitCode: 1 },
    );
    expect(result.code).toBe(1);
    expect(result.runs).toHaveLength(1);
    expect(result.output).toContain("rollback failed");
    expect(result.output).not.toContain("restored version");
  });

  test("the run's summary records the rollback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smoke-check-"));
    try {
      const summary = join(dir, "summary.md");
      const result = await smoke(
        ["osn_api", "production"],
        { ...OSN_PROD, "https://id.musubi.social/health": MISCONFIGURED },
        { env: { GITHUB_STEP_SUMMARY: summary } },
      );
      expect(result.code).toBe(1);
      const text = await readFile(summary, "utf8");
      expect(text).toContain("osn_api");
      expect(text).toContain("rolled back");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a failure the Worker did not cause", () => {
  test("hosts that never answer fail the step without a rollback", async () => {
    const result = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": new TypeError("fetch failed"),
      "https://id.musubi.social/.well-known/jwks.json": new TypeError("fetch failed"),
    });
    expect(result.code).toBe(1);
    expect(result.runs).toEqual([]);
    expect(result.output).toContain("not rolling back");
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
    expect(result.runs).toEqual([]);
    expect(result.output).toContain("Cloudflare");
    expect(result.output).not.toContain("s3cret");
  });

  test("one wrong answer among unreachable ones still rolls back", async () => {
    const result = await smoke(["osn_api", "production"], {
      "https://id.musubi.social/health": MISCONFIGURED,
      "https://id.musubi.social/.well-known/jwks.json": new TypeError("fetch failed"),
    });
    expect(result.code).toBe(1);
    expect(result.runs).toHaveLength(1);
  });
});

describe("the guest site's dev host sits behind Cloudflare Access", () => {
  test("with no service token the check is skipped, with a warning, and asks nothing", async () => {
    const result = await smoke(["cire_invites", "dev"], {});
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.runs).toEqual([]);
    expect(result.output).toContain("::warning");
    expect(result.output).toContain("CF_ACCESS_CLIENT_ID");
  });

  test("with a service token every probe carries it, and a healthy Worker passes", async () => {
    const result = await smoke(
      ["cire_invites", "dev"],
      {
        "https://invite.dev.cireweddings.com/": redirect("https://dev.cireweddings.com/"),
        "https://invite.dev.cireweddings.com/smoke-check-no-such-wedding": html(404),
      },
      { env: { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3cret" } },
    );
    expect(result.code).toBe(0);
    for (const call of result.calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("cf-access-client-id")).toBe("id.access");
      expect(headers.get("cf-access-client-secret")).toBe("s3cret");
    }
    expect(result.output).not.toContain("s3cret");
  });

  test("a host with no Access never receives the token", async () => {
    const result = await smoke(
      ["osn_api", "dev"],
      {
        "https://id.dev.musubi.social/health": HEALTHY,
        "https://id.dev.musubi.social/.well-known/jwks.json": JWKS,
      },
      { env: { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3cret" } },
    );
    expect(result.code).toBe(0);
    for (const call of result.calls)
      expect(new Headers(call.init?.headers).has("cf-access-client-secret")).toBe(false);
  });
});

describe("the dry run", () => {
  test("SMOKE_FORCE_FAIL on dev asks for a path the Worker answers 404, and rolls back", async () => {
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
    expect(result.calls.some((call) => call.url === forced)).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.command.slice(0, 5)).toEqual([
      "bunx",
      "wrangler",
      "rollback",
      "--env",
      "dev",
    ]);
    expect(result.output).toContain(forced);
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
    expect(result.runs).toEqual([]);
  });

  test("production refuses the dry run before asking anything", async () => {
    const result = await smoke(["osn_api", "production"], OSN_PROD, {
      env: { SMOKE_FORCE_FAIL: "true" },
    });
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.runs).toEqual([]);
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
    expect(result.runs).toEqual([]);
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

  test("stays within wrangler's 120 characters", () => {
    const long = rollbackMessage({ ...RUN_ENV, GITHUB_REPOSITORY: `${"o".repeat(80)}/osn` });
    expect(long.length).toBeLessThanOrEqual(120);
  });

  test("says so when no run is known", () => {
    expect(rollbackMessage({})).toBe("Smoke check failed outside GitHub Actions");
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
