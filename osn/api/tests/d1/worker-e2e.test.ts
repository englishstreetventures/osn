import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSchemaSql } from "@osn/db/testing";
import type { CoordinationStub } from "@shared/coordination";
import {
  Miniflare,
  Response as MiniflareResponse,
  type Request as MiniflareRequest,
} from "miniflare";

import { RECOVERY_LOCKOUT_THRESHOLD } from "../../src/lib/recovery-lockout-store";
import { DEV_PRINCIPAL } from "../../src/routes/auth/dev-login";
import { AUTH_RATE_LIMITS } from "../../src/routes/auth/limiters";
import { ROTATION_GRACE_MS } from "../../src/services/auth/constants";

/**
 * osn-api end to end on workerd: the bundle `wrangler deploy` uploads, with
 * the `COORDINATION` Durable Object, the native rate limits and D1 bound as
 * `wrangler.toml` binds them. Every other osn-api test runs the app under Bun
 * with the in-memory stores, and `tools/e2e` boots it under Bun too, so this is
 * the only place the Durable Object path runs as deployed: a step-up token
 * used once, a one-time code used once, an hour-window limiter that outlives a
 * restart, a recovery-code lockout and refresh-token reuse detection.
 *
 * It ends by writing `e2e-artifacts/osn-api-workerd/results.json`: each
 * request's step, method, path, status and error code, and the counts read
 * off the store. No token, code, timestamp or IP goes in it, so a rerun
 * writes the same bytes.
 */

const HOOK_TIMEOUT_MS = 120_000;
setDefaultTimeout(60_000);

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const ARTIFACT_DIR = join(REPO_ROOT, "e2e-artifacts", "osn-api-workerd");

interface WranglerToml {
  readonly compatibility_date: string;
  readonly compatibility_flags: string[];
  readonly vars: Readonly<Record<string, string>>;
  readonly durable_objects: {
    readonly bindings: readonly { readonly name: string; readonly class_name: string }[];
  };
  readonly migrations: readonly { readonly new_sqlite_classes?: readonly string[] }[];
  readonly ratelimits: readonly {
    readonly name: string;
    readonly namespace_id: string;
    readonly simple: { readonly limit: number; readonly period: 10 | 60 };
  }[];
}

const wrangler = Bun.TOML.parse(
  await Bun.file(join(PACKAGE_ROOT, "wrangler.toml")).text(),
) as WranglerToml;

/** The local tier's first browser origin: POSTs carry it past the origin guard. */
const ORIGIN = wrangler.vars["OSN_CORS_ORIGIN"]!.split(",")[0]!;
const API = wrangler.vars["OSN_ISSUER_URL"]!;
/** A loopback Resend stand-in; the Worker's outbound fetches land in `capture`. */
const RESEND_ORIGIN = "http://127.0.0.1:9";
const DEV_LOGIN_SECRET = "workerd-e2e-dev-login-secret";
// The bearer `/health/coordination` answers, as the smoke check sends it.
const INTERNAL_SERVICE_SECRET = "workerd-e2e-internal-service-secret";

// Documentation addresses (RFC 5737). The Worker reads them from
// `x-forwarded-for` under TRUSTED_PROXY_COUNT=1.
const MAIN_IP = "198.51.100.10";
const lockoutIp = (n: number) => `198.51.100.${20 + n}`;

interface Step {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly error?: string;
}

interface Mail {
  readonly to: readonly string[];
  readonly text: string;
}

let outdir: string;
let state: string;
let mf: Miniflare;
const steps: Step[] = [];
/** What the test read off store objects, by object (never the key's IP or id). */
const store: Record<string, number | string | null> = {};
const mail: Mail[] = [];
const strayOutbound: string[] = [];

async function capture(request: MiniflareRequest): Promise<MiniflareResponse> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.origin === RESEND_ORIGIN && url.pathname === "/emails") {
    const payload = (await request.json()) as { to?: string | string[]; text?: string };
    const to = typeof payload.to === "string" ? [payload.to] : [...(payload.to ?? [])];
    mail.push({ to, text: payload.text ?? "" });
    return MiniflareResponse.json({ id: `mail-${mail.length}` });
  }
  strayOutbound.push(`${request.method} ${url.origin}${url.pathname}`);
  return new MiniflareResponse("not found", { status: 404 });
}

async function boot(): Promise<Miniflare> {
  const sqliteClasses = new Set(wrangler.migrations.flatMap((m) => m.new_sqlite_classes ?? []));
  const instance = new Miniflare({
    // Listed rather than `scriptPath`: the bundle holds one `import()` of a
    // computed specifier (`@shared/db-utils`'s Bun-only driver, never reached
    // on workerd), which Miniflare refuses to follow when it walks the module.
    // Wrangler uploads the same single module.
    modulesRoot: outdir,
    modules: [{ type: "ESModule", path: join(outdir, "entry.js") }],
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    bindings: {
      ...wrangler.vars,
      TRUSTED_PROXY_COUNT: "1",
      DEV_LOGIN_SECRET,
      INTERNAL_SERVICE_SECRET,
      RESEND_API_KEY: "re_workerd_e2e",
      RESEND_API_URL: RESEND_ORIGIN,
    },
    d1Databases: { DB: "osn-workerd-e2e" },
    d1Persist: join(state, "d1"),
    durableObjects: Object.fromEntries(
      wrangler.durable_objects.bindings.map((binding) => [
        binding.name,
        { className: binding.class_name, useSQLite: sqliteClasses.has(binding.class_name) },
      ]),
    ),
    durableObjectsPersist: join(state, "do"),
    ratelimits: Object.fromEntries(
      wrangler.ratelimits.map((block) => [
        block.name,
        { namespace_id: block.namespace_id, simple: { ...block.simple } },
      ]),
    ),
    outboundService: capture,
  });
  await instance.ready;
  return instance;
}

interface CallOptions {
  readonly ip: string;
  readonly bearer?: string;
  readonly cookie?: string;
  readonly body?: Readonly<Record<string, string>>;
  readonly query?: string;
}

interface Answer {
  readonly status: number;
  readonly json: Readonly<Record<string, unknown>>;
  readonly setCookies: readonly string[];
}

/** One request to the Worker, recorded as a step of the artifact. */
async function call(
  step: string,
  method: "GET" | "POST",
  path: string,
  options: CallOptions,
): Promise<Answer> {
  const headers = new Headers({ "x-forwarded-for": options.ip });
  if (method === "POST") {
    headers.set("origin", ORIGIN);
    headers.set("content-type", "application/json");
  }
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  const res = await mf.dispatchFetch(`${API}${path}${options.query ?? ""}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: recorded by status alone.
  }
  const error = typeof json["error"] === "string" ? json["error"] : undefined;
  steps.push(
    error === undefined
      ? { step, method, path, status: res.status }
      : { step, method, path, status: res.status, error },
  );
  return { status: res.status, json, setCookies: res.headers.getSetCookie() };
}

/** The session cookie's value out of a response's `Set-Cookie` headers. */
function sessionCookie(answer: Answer): string {
  const header = answer.setCookies.find((cookie) => cookie.startsWith("osn_session="));
  const value = header?.slice("osn_session=".length).split(";")[0];
  if (!value) throw new Error("no osn_session cookie in the response");
  return `osn_session=${value}`;
}

/** The six-digit code in the newest mail to `to` that arrived after `after` mails. */
function codeMailedTo(to: string, after: number): string {
  const sent = mail.slice(after).filter((m) => m.to.includes(to));
  const code = sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  if (code === undefined) throw new Error(`no one-time code mailed to ${to}`);
  return code;
}

/** A store object, reached through the binding the Worker uses. */
async function storeObject(objectName: string): Promise<Pick<CoordinationStub, "count" | "read">> {
  const ns = await mf.getDurableObjectNamespace("COORDINATION");
  // SAFETY: the binding's class is `CoordinationStore`, whose RPC surface is
  // `CoordinationStub`; Miniflare types the stub without its methods.
  return ns.get(ns.idFromName(objectName)) as unknown as Pick<CoordinationStub, "count" | "read">;
}

/** The `jti` claim of a JWT, read without verifying it. */
function jtiOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
    jti?: unknown;
  };
  if (typeof payload.jti !== "string") throw new Error("step-up token has no jti");
  return payload.jti;
}

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "osn-api-workerd-build-"));
  state = await mkdtemp(join(tmpdir(), "osn-api-workerd-state-"));
  // Wrangler's own bundle, the artefact a deploy uploads, built as `bun run
  // build` builds it but into a directory of this test's own.
  const build = Bun.spawnSync(
    ["bunx", "wrangler", "deploy", "--dry-run", "--env=", "--outdir", outdir],
    { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`wrangler build failed: ${build.stderr.toString()}`);

  mf = await boot();
  const db = await mf.getD1Database("DB");
  for (const statement of createSchemaSql()) {
    // eslint-disable-next-line no-await-in-loop -- DDL in foreign-key order
    await db.prepare(statement).run();
  }
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const results = { steps, coordinationStore: store, strayOutbound };
  await writeFile(join(ARTIFACT_DIR, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await mf?.dispose();
  await Promise.all(
    [outdir, state].map((dir) => (dir ? rm(dir, { recursive: true, force: true }) : undefined)),
  );
}, HOOK_TIMEOUT_MS);

describe("osn-api on workerd, with the coordination store on its Durable Object", () => {
  let access = "";
  let session = "";
  let otp = "";
  let stepUpToken = "";
  let recoveryCodes: string[] = [];

  it("evaluates the bundle and round-trips the coordination store", async () => {
    const res = await call("store round trip", "GET", "/health/coordination", {
      ip: MAIN_IP,
      bearer: INTERNAL_SERVICE_SECRET,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it("signs in as the dev principal", async () => {
    const res = await call("dev sign-in", "GET", "/dev/login", {
      ip: MAIN_IP,
      query: `?secret=${DEV_LOGIN_SECRET}`,
    });
    expect(res.status).toBe(200);
    const tokens = res.json["session"] as { access_token: string };
    access = tokens.access_token;
    session = sessionCookie(res);
  });

  it("mints a step-up token from an emailed one-time code, once", async () => {
    const before = mail.length;
    const begin = await call("step-up code sent", "POST", "/step-up/otp/begin", {
      ip: MAIN_IP,
      bearer: access,
    });
    expect(begin.status).toBe(200);
    otp = codeMailedTo(DEV_PRINCIPAL.email, before);

    const complete = await call("step-up code accepted", "POST", "/step-up/otp/complete", {
      ip: MAIN_IP,
      bearer: access,
      body: { code: otp, purpose: "recovery_generate" },
    });
    expect(complete.status).toBe(200);
    stepUpToken = complete.json["step_up_token"] as string;
    expect(stepUpToken.length).toBeGreaterThan(0);
  });

  it("accepts a step-up token once", async () => {
    const first = await call("recovery codes with the token", "POST", "/recovery/generate", {
      ip: MAIN_IP,
      bearer: access,
      body: { step_up_token: stepUpToken },
    });
    expect(first.status).toBe(200);
    recoveryCodes = first.json["recoveryCodes"] as string[];
    expect(recoveryCodes).toHaveLength(10);

    // The token's id is claimed on its own store object.
    const claim = await storeObject(`step_up_jti:${jtiOf(stepUpToken)}`);
    store["step_up_jti, after first use"] = await claim.read();
    expect(store["step_up_jti, after first use"]).toBe("1");

    const again = await call("recovery codes with the same token", "POST", "/recovery/generate", {
      ip: MAIN_IP,
      bearer: access,
      body: { step_up_token: stepUpToken },
    });
    expect(again.status).toBe(400);
    expect(again.json["error"]).toBe("invalid_request");
  });

  it("accepts a one-time code once", async () => {
    const replay = await call("step-up code replayed", "POST", "/step-up/otp/complete", {
      ip: MAIN_IP,
      bearer: access,
      body: { code: otp, purpose: "recovery_generate" },
    });
    expect(replay.status).toBe(400);
    expect(replay.json["error"]).toBe("invalid_request");
  });

  it("refuses recovery-code generation from one IP once its hour's budget is spent", async () => {
    const budget = AUTH_RATE_LIMITS.recoveryGenerate.maxRequests;
    // Two calls above came from this IP; the rest of the budget is refused
    // only for want of a step-up token, which the limiter runs before.
    for (let n = 3; n <= budget; n++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      const res = await call(`recovery codes, call ${n}`, "POST", "/recovery/generate", {
        ip: MAIN_IP,
        bearer: access,
      });
      expect(res.status).toBe(403);
    }
    const over = await call(`recovery codes, call ${budget + 1}`, "POST", "/recovery/generate", {
      ip: MAIN_IP,
      bearer: access,
    });
    expect(over.status).toBe(429);

    const limiter = await storeObject(`auth.${AUTH_RATE_LIMITS.recoveryGenerate.ns}:${MAIN_IP}`);
    store["auth.recovery_generate, before restart"] = await limiter.count();
    expect(store["auth.recovery_generate, before restart"]).toBe(budget + 1);
  });

  it("keeps the count across a restart on the same storage", async () => {
    await mf.dispose();
    mf = await boot();
    const res = await call("recovery codes after restart", "POST", "/recovery/generate", {
      ip: MAIN_IP,
    });
    expect(res.status).toBe(429);
    const limiter = await storeObject(`auth.${AUTH_RATE_LIMITS.recoveryGenerate.ns}:${MAIN_IP}`);
    store["auth.recovery_generate, after restart"] = await limiter.count();
    expect(store["auth.recovery_generate, after restart"]).toBe(
      AUTH_RATE_LIMITS.recoveryGenerate.maxRequests + 2,
    );
  });

  it("refuses the right recovery code once wrong ones from other IPs lock the account", async () => {
    for (let n = 1; n <= RECOVERY_LOCKOUT_THRESHOLD; n++) {
      // eslint-disable-next-line no-await-in-loop -- each failure counts in order
      const wrong = await call(`wrong recovery code ${n}`, "POST", "/login/recovery/complete", {
        ip: lockoutIp(n),
        body: { identifier: DEV_PRINCIPAL.handle, code: `wrong-code-${n}` },
      });
      expect(wrong.status).toBe(400);
    }
    const lockout = await storeObject(`recovery_lockout:${DEV_PRINCIPAL.accountId}`);
    store["recovery_lockout, after the wrong codes"] = await lockout.count();
    expect(store["recovery_lockout, after the wrong codes"]).toBe(RECOVERY_LOCKOUT_THRESHOLD);

    const right = await call("right recovery code, locked", "POST", "/login/recovery/complete", {
      ip: lockoutIp(RECOVERY_LOCKOUT_THRESHOLD + 1),
      body: { identifier: DEV_PRINCIPAL.handle, code: recoveryCodes[0]! },
    });
    expect(right.status).toBe(400);
    expect(right.json["error"]).toBe("invalid_request");
    expect(right.setCookies.some((cookie) => cookie.startsWith("osn_session="))).toBe(false);

    // The refused code was not spent: all ten are still unused. The restart
    // changed the local tier's signing key, so this needs a fresh sign-in.
    const signIn = await call("dev sign-in after restart", "GET", "/dev/login", {
      ip: MAIN_IP,
      query: `?secret=${DEV_LOGIN_SECRET}`,
    });
    expect(signIn.status).toBe(200);
    const fresh = (signIn.json["session"] as { access_token: string }).access_token;
    const status = await call("recovery code count", "GET", "/recovery/status", {
      ip: MAIN_IP,
      bearer: fresh,
    });
    expect(status.status).toBe(200);
    expect(status.json["active"]).toBe(10);
  });

  it("ends the session family when a rotated refresh token comes back after the grace window", async () => {
    const rotated = await call("refresh", "POST", "/token", {
      ip: MAIN_IP,
      cookie: session,
      body: { grant_type: "refresh_token" },
    });
    expect(rotated.status).toBe(200);
    const next = sessionCookie(rotated);
    expect(next).not.toBe(session);

    // Past the grace window by moving the rotation back in D1 rather than
    // waiting it out: the replay below lands outside it by construction.
    const db = await mf.getD1Database("DB");
    await db
      .prepare("UPDATE rotated_sessions SET rotated_at = rotated_at - ?")
      .bind(ROTATION_GRACE_MS + 1_000)
      .run();

    const replay = await call("refresh with the rotated-out token", "POST", "/token", {
      ip: MAIN_IP,
      cookie: session,
      body: { grant_type: "refresh_token" },
    });
    expect(replay.status).toBe(400);
    expect(replay.json["error"]).toBe("invalid_grant");

    const successor = await call("refresh with its successor", "POST", "/token", {
      ip: MAIN_IP,
      cookie: next,
      body: { grant_type: "refresh_token" },
    });
    expect(successor.status).toBe(400);
    expect(successor.json["error"]).toBe("invalid_grant");
  });

  it("sent nothing anywhere but the Resend stand-in", () => {
    expect(strayOutbound).toEqual([]);
  });
});
