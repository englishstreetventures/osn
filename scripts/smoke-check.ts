#!/usr/bin/env bun
/**
 * Check a Worker straight after its deploy, and roll it back when it answers
 * wrongly.
 *
 * Runs as the step after `wrangler deploy` in every Worker job of
 * .github/workflows/deploy.yml (dev) and production-release.yml (production):
 *
 *   bun run scripts/smoke-check.ts <surface> <tier>
 *
 * from the repository root. `wrangler deploy` reports success when the upload
 * succeeds, not when the Worker can serve: a missing secret makes osn-api
 * answer 503 on every route while its job goes green. This asks the Worker's
 * own hosts (SMOKE_TARGETS) what a working one answers, every 10 seconds for a
 * minute, and calls the deploy healthy once every probe passes in two rounds
 * in a row.
 *
 * Two rounds, because no answer here names the version that gave it: a request
 * made the moment the deploy returns can still reach the version before it.
 * A second pass ten seconds later narrows that window; it does not close it.
 *
 * When the minute runs out and the Worker itself is still answering wrongly,
 * this runs `bunx wrangler rollback` with the same `--env` or `--config` the
 * deploy step used, so it restores the version Cloudflare ran before this
 * deploy, then probes once more to say whether that version answers. Either
 * way it exits 1, which fails the job, and GitHub marks the job's Deployment
 * record `failure`. scripts/release-plan.ts counts only records whose job
 * succeeded, so the next release offers the surface again.
 *
 * It does not roll back when nothing answered (DNS, TLS, a timeout) or when
 * Cloudflare answered in the Worker's place (Access, a bot challenge): a
 * rollback restores code, and code is not what failed. The step fails all the
 * same.
 *
 * A rollback restores the Worker's code, not its D1 database: the migrations
 * the job applied before deploying stay applied. That is why a migration must
 * keep working with the Worker version before it.
 *
 * Environment:
 *   SMOKE_FORCE_FAIL    "true" adds a probe of FORCED_FAILURE_PATH, which every
 *                       Worker answers 404, so the job rolls back and goes red:
 *                       the dry run of the rollback path. Dev only.
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 *                       a Cloudflare Access service token, sent only to a
 *                       target behind Access (the guest site's dev host).
 *                       Without both, that target's check is skipped.
 *   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT
 *                       name the run in the rollback message.
 *   GITHUB_STEP_SUMMARY receives a line when the check fails.
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *                       read by wrangler for the rollback; never by this file.
 *
 * Exit codes: 0 healthy, or skipped; 1 unhealthy; 2 a usage error, before any
 * request — nothing is rolled back.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { SurfaceKey, Tier } from "./deploy-surfaces";

// ── what each Worker answers ────────────────────────────────────────────────

export type Expectation =
  /** 200, a JSON body whose top-level fields equal these. */
  | { readonly kind: "json"; readonly fields: Readonly<Record<string, string | boolean>> }
  /** 200, a JWK set holding an ES256 key on P-256. */
  | { readonly kind: "jwks" }
  /** A 3xx whose Location is on this origin. */
  | { readonly kind: "redirect"; readonly to: string }
  /** A rendered HTML page, 200 or 404. */
  | { readonly kind: "page" };

export interface Probe {
  readonly url: string;
  readonly expects: Expectation;
}

export interface SmokeTarget {
  /** Where the deploy step runs wrangler, relative to the repository root. */
  readonly cwd: string;
  /** The arguments that pick the Worker, exactly as the deploy step passes them. */
  readonly wrangler: readonly string[];
  readonly probes: readonly Probe[];
  /** The host sits behind Cloudflare Access, so probes need a service token. */
  readonly access?: boolean;
}

export type WorkerSurface = Extract<
  SurfaceKey,
  "cire_api" | "cire_invites" | "osn_api" | "zap_api"
>;

const health = (origin: string): Probe => ({
  url: `${origin}/health`,
  expects: { kind: "json", fields: { status: "ok" } },
});

const jwks = (origin: string): Probe => ({
  url: `${origin}/.well-known/jwks.json`,
  expects: { kind: "jwks" },
});

// cire-api has no /health. GET /api/auth/session answers a caller with no
// cookie `{signedIn: false}` without touching D1, and only after the Worker's
// fail-closed guard and the app build (cire/api/src/index.ts, `fetch`).
const cireSession = (origin: string): Probe => ({
  url: `${origin}/api/auth/session`,
  expects: { kind: "json", fields: { signedIn: false } },
});

// The guest site has no health route either, and a page named `health` would
// shadow a wedding of that slug. `/` redirects to the marketing site from the
// server render; an unknown slug renders `[slug].astro` and its design
// imports — 404 when cire-api says no such wedding, 200 when cire-api is down,
// so this probe does not depend on cire-api.
const guestSite = (origin: string, marketing: string): readonly Probe[] => [
  { url: `${origin}/`, expects: { kind: "redirect", to: marketing } },
  { url: `${origin}/smoke-check-no-such-wedding`, expects: { kind: "page" } },
];

/**
 * Hosts come from each Worker's route config (wrangler.toml, wrangler.jsonc,
 * and deploy.yml's retarget of the guest site's dev Worker); the marketing
 * origins from the jobs' PUBLIC_MARKETING_URL. scripts/tests/smoke-targets.test.ts
 * holds them equal.
 */
export const SMOKE_TARGETS = {
  cire_api: {
    production: {
      cwd: "cire/api",
      wrangler: ["--env", "production"],
      probes: [cireSession("https://api.cireweddings.com")],
    },
    dev: {
      cwd: "cire/api",
      wrangler: ["--env", "dev"],
      probes: [cireSession("https://api.dev.cireweddings.com")],
    },
  },
  cire_invites: {
    production: {
      cwd: "cire/invites",
      wrangler: ["--config", "dist/server/wrangler.json"],
      probes: guestSite("https://invite.cireweddings.com", "https://cireweddings.com"),
    },
    dev: {
      cwd: "cire/invites",
      wrangler: ["--config", "dist/server/wrangler.json"],
      probes: guestSite("https://invite.dev.cireweddings.com", "https://dev.cireweddings.com"),
      access: true,
    },
  },
  osn_api: {
    production: {
      cwd: "osn/api",
      wrangler: ["--env", "production"],
      probes: [health("https://id.musubi.social"), jwks("https://id.musubi.social")],
    },
    dev: {
      cwd: "osn/api",
      wrangler: ["--env", "dev"],
      probes: [health("https://id.dev.musubi.social"), jwks("https://id.dev.musubi.social")],
    },
  },
  zap_api: {
    production: {
      cwd: "zap/api",
      wrangler: ["--env", "production"],
      probes: [health("https://zap.cireweddings.com")],
    },
  },
} as const satisfies Record<
  WorkerSurface,
  { readonly dev?: SmokeTarget; readonly production: SmokeTarget }
>;

/** The target for a surface on a tier, or undefined when it has no Worker there. */
export function smokeTarget(surface: WorkerSurface, tier: Tier): SmokeTarget | undefined {
  const tiers: { readonly dev?: SmokeTarget; readonly production: SmokeTarget } =
    SMOKE_TARGETS[surface];
  return tiers[tier];
}

/** A path no Worker serves: the dry run's probe. */
export const FORCED_FAILURE_PATH = "/smoke-check-forced-failure";

// ── judging one answer ──────────────────────────────────────────────────────

export type Outcome =
  | { readonly kind: "pass" }
  /** The Worker answered, and the answer is not what a working one gives. */
  | { readonly kind: "wrong"; readonly reason: string }
  /** No answer: DNS, TLS, the connection, or the timeout. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** Cloudflare answered in the Worker's place: Access, or a bot challenge. */
  | { readonly kind: "blocked"; readonly reason: string };

const PASS: Outcome = { kind: "pass" };

const oneLine = (text: string, max = 200) => text.replaceAll(/\s+/g, " ").trim().slice(0, max);

function locationOf(response: Response, base: string): URL | undefined {
  const location = response.headers.get("location");
  if (location === null || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

/** A JSON body's top-level fields that hold a string or a boolean. */
type ScalarFields = ReadonlyMap<string, string | boolean>;

/** The body's scalar top-level fields; empty when it is not a JSON object. */
function scalarFields(body: string): ScalarFields {
  try {
    const parsed = JSON.parse(body) as object | null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string | boolean] =>
          typeof entry[1] === "string" || typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return new Map();
  }
}

/** The fields of one JWK that say which algorithm and curve it is for. */
interface Jwk {
  readonly kty: string;
  readonly crv: string;
  readonly alg: string;
}

/** The keys of a JWK set; empty when the body is not one. */
function jwkSet(body: string): readonly Jwk[] {
  try {
    const parsed = JSON.parse(body) as { keys?: unknown } | null;
    if (!Array.isArray(parsed?.keys)) return [];
    return parsed.keys.map((item) => {
      const key = item as { kty?: unknown; crv?: unknown; alg?: unknown } | null;
      const text = (value: unknown) => (typeof value === "string" ? value : "");
      return { kty: text(key?.kty), crv: text(key?.crv), alg: text(key?.alg) };
    });
  } catch {
    return [];
  }
}

const isEs256 = (key: Jwk) => key.kty === "EC" && key.crv === "P-256" && key.alg === "ES256";

/**
 * What one answer says about the Worker. `access` marks a host behind
 * Cloudflare Access, where a 401 or 403 comes from Access, not the Worker.
 */
export function judge(probe: Probe, response: Response, body: string, access: boolean): Outcome {
  const { status } = response;
  const location = locationOf(response, probe.url);
  if (isRedirect(status) && location?.hostname.endsWith(".cloudflareaccess.com")) {
    return {
      kind: "blocked",
      reason: `Cloudflare Access answered (${status} to ${location.origin}), not the Worker`,
    };
  }
  if (response.headers.get("cf-mitigated") === "challenge") {
    return { kind: "blocked", reason: `Cloudflare answered ${status} with a bot challenge` };
  }
  if (access && (status === 401 || status === 403)) {
    return {
      kind: "blocked",
      reason: `Cloudflare Access refused the service token (${status})`,
    };
  }

  const wrong = (expected: string): Outcome => ({
    kind: "wrong",
    reason: `answered ${status}, expected ${expected}${body === "" ? "" : `: ${oneLine(body)}`}`,
  });
  const { expects } = probe;
  switch (expects.kind) {
    case "json": {
      const want = `200 with ${JSON.stringify(expects.fields)}`;
      if (status !== 200) return wrong(want);
      const fields = scalarFields(body);
      return Object.entries(expects.fields).every(([field, value]) => fields.get(field) === value)
        ? PASS
        : wrong(want);
    }
    case "jwks": {
      const want = "200 with an ES256 P-256 key";
      return status === 200 && jwkSet(body).some(isEs256) ? PASS : wrong(want);
    }
    case "redirect": {
      const want = `a redirect to ${expects.to}`;
      if (!isRedirect(status)) return wrong(want);
      if (location === undefined)
        return { kind: "wrong", reason: `answered ${status} with no Location` };
      return location.origin === new URL(expects.to).origin
        ? PASS
        : { kind: "wrong", reason: `answered ${status} to ${location.origin}, expected ${want}` };
    }
    case "page": {
      const type = response.headers.get("content-type") ?? "";
      return (status === 200 || status === 404) && type.startsWith("text/html")
        ? PASS
        : {
            kind: "wrong",
            reason: `answered ${status} ${type || "with no content type"}, expected an HTML page, 200 or 404`,
          };
    }
  }
}

/** Ask once. Never follows a redirect: a login page is not the Worker. */
export async function probeOnce(
  probe: Probe,
  options: {
    readonly fetch: typeof fetch;
    readonly headers: Readonly<Record<string, string>>;
    readonly access: boolean;
    readonly timeoutMs: number;
  },
): Promise<Outcome> {
  try {
    const response = await options.fetch(probe.url, {
      redirect: "manual",
      headers: { "user-agent": "osn-smoke-check", ...options.headers },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return judge(probe, response, await response.text(), options.access);
  } catch (error) {
    return {
      kind: "unreachable",
      reason: `no answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

/** How long the check keeps asking, how often, and how long one request may take. */
export const TIMING = { budgetMs: 60_000, intervalMs: 10_000, requestMs: 10_000 } as const;

/** Rounds in a row that must pass. */
const PASSES_NEEDED = 2;

/** wrangler's limit on a rollback message. */
const MESSAGE_LIMIT = 120;

export function rollbackMessage(env: Readonly<Record<string, string | undefined>>): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return "Smoke check failed outside GitHub Actions";
  const server = GITHUB_SERVER_URL || "https://github.com";
  const attempt = GITHUB_RUN_ATTEMPT ? `/attempts/${GITHUB_RUN_ATTEMPT}` : "";
  return `Smoke check failed: ${server}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`.slice(
    0,
    MESSAGE_LIMIT,
  );
}

export interface SmokeCheckInput {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs a command in `cwd` with this process's environment; resolves to its exit code. */
  readonly run: (command: readonly string[], cwd: string) => Promise<number>;
  /** The repository root. */
  readonly root: string;
  readonly out: (text: string) => void;
}

const isWorkerSurface = (value: string): value is WorkerSurface =>
  Object.hasOwn(SMOKE_TARGETS, value);

type Round = readonly Outcome[];

export async function runSmokeCheck(input: SmokeCheckInput): Promise<number> {
  const { env, out } = input;
  const usage = (message: string): number => {
    out(`::error::smoke-check: ${message}\n`);
    return 2;
  };

  if (input.args.length !== 2) return usage("usage: smoke-check.ts <surface> <tier>");
  const [surface = "", tier = ""] = input.args;
  if (!isWorkerSurface(surface)) {
    return usage(
      `'${surface}' is not a Worker surface; use one of ${Object.keys(SMOKE_TARGETS).join(", ")}`,
    );
  }
  if (tier !== "dev" && tier !== "production")
    return usage(`tier must be dev or production, not '${tier}'`);
  const target = smokeTarget(surface, tier);
  if (target === undefined) return usage(`${surface} has no ${tier} Worker`);

  const force = env.SMOKE_FORCE_FAIL ?? "";
  if (force !== "" && force !== "true" && force !== "false") {
    return usage(`SMOKE_FORCE_FAIL must be true or false, not '${force}'`);
  }
  const forced = force === "true";
  if (forced && tier === "production") {
    return usage("SMOKE_FORCE_FAIL is for dev; the dry run never rolls production back");
  }

  const label = `${surface} (${tier})`;
  const headers: Record<string, string> = {};
  if (target.access) {
    const id = env.CF_ACCESS_CLIENT_ID ?? "";
    const secret = env.CF_ACCESS_CLIENT_SECRET ?? "";
    if (id !== "" && secret !== "") {
      headers["cf-access-client-id"] = id;
      headers["cf-access-client-secret"] = secret;
    } else if (!forced) {
      out(
        `::warning::Smoke check skipped for ${label}: its host is behind Cloudflare Access and CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not both set on this Environment.\n`,
      );
      return 0;
    }
  }

  const probes: readonly Probe[] = forced
    ? [
        ...target.probes,
        {
          url: new URL(FORCED_FAILURE_PATH, target.probes[0]?.url).href,
          expects: { kind: "json", fields: { status: "ok" } },
        },
      ]
    : target.probes;
  const ask = (): Promise<Round> =>
    Promise.all(
      probes.map((probe) =>
        probeOnce(probe, {
          fetch: input.fetch,
          headers,
          access: target.access === true,
          timeoutMs: TIMING.requestMs,
        }),
      ),
    );
  const passed = (round: Round) => round.every((outcome) => outcome.kind === "pass");

  // Rounds until PASSES_NEEDED in a row pass. No new round starts past the
  // budget unless the one before it passed and needs confirming. Recursion,
  // not a loop: each round must wait for the one before it.
  const start = input.now();
  const check = async (
    rounds: number,
    streak: number,
  ): Promise<{ readonly healthy: boolean; readonly rounds: number; readonly last: Round }> => {
    const round = await ask();
    const next = passed(round) ? streak + 1 : 0;
    if (next >= PASSES_NEEDED) return { healthy: true, rounds: rounds + 1, last: round };
    if (next === 0 && input.now() - start + TIMING.intervalMs > TIMING.budgetMs) {
      return { healthy: false, rounds: rounds + 1, last: round };
    }
    await input.sleep(TIMING.intervalMs);
    return check(rounds + 1, next);
  };
  const result = await check(0, 0);
  if (result.healthy) {
    out(`Smoke check passed: ${label}, ${probes.length} probes, ${result.rounds} rounds.\n`);
    return 0;
  }

  const { last } = result;
  const failures = probes.flatMap((probe, index) => {
    const outcome = last[index];
    return outcome === undefined || outcome.kind === "pass" ? [] : [{ probe, outcome }];
  });
  for (const { probe, outcome } of failures) out(`::error::${probe.url}: ${outcome.reason}\n`);
  const summary = (line: string) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };

  if (!failures.some(({ outcome }) => outcome.kind === "wrong")) {
    out(
      `::error title=Smoke check failed::${label} did not answer as a working Worker does within ${TIMING.budgetMs / 1000} s, but the Worker never answered wrongly — not rolling back. See the probes above.\n`,
    );
    summary(
      `- **${label}**: smoke check failed without an answer from the Worker; not rolled back.`,
    );
    return 1;
  }

  const command = [
    "bunx",
    "wrangler",
    "rollback",
    ...target.wrangler,
    "--message",
    rollbackMessage(env),
    "--yes",
  ];
  out(
    `::error title=Smoke check failed::${label} answered wrongly for ${TIMING.budgetMs / 1000} s; rolling the Worker back.\n`,
  );
  const code = await input.run(command, join(input.root, target.cwd));
  if (code !== 0) {
    out(
      `::error title=Rollback failed::the rollback failed: wrangler rollback exited ${code}, so ${label} still runs the version this job deployed.\n`,
    );
    summary(`- **${label}**: smoke check failed and the rollback failed (exit ${code}).`);
    return 1;
  }

  await input.sleep(TIMING.intervalMs);
  const after = await ask();
  // The dry run's probe fails on every version; leave it out of the verdict.
  const restored = after.slice(0, target.probes.length);
  if (passed(restored)) {
    out(
      `::notice::${label} rolled back to its previous version; the restored version answers healthy.\n`,
    );
    summary(
      `- **${label}**: smoke check failed; rolled back, and the restored version answers healthy.`,
    );
  } else {
    out(
      `::error title=Still failing after rollback::${label} rolled back, and the restored version is still failing: the cause is not this deploy's code (a secret, a binding, D1, an upstream).\n`,
    );
    summary(
      `- **${label}**: smoke check failed; rolled back, and the restored version is still failing.`,
    );
  }
  return 1;
}

if (import.meta.main) {
  const code = await runSmokeCheck({
    args: process.argv.slice(2),
    env: process.env,
    fetch,
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    run: async (command, cwd) => {
      const proc = Bun.spawn([...command], { cwd, stdout: "inherit", stderr: "inherit" });
      return proc.exited;
    },
    root: process.cwd(),
    out: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
