#!/usr/bin/env bun
/**
 * Check a Worker straight after its deploy, and roll it back when it answers
 * wrongly.
 *
 * Runs after every Worker deploy: in production-release.yml as the step after
 * each production Worker's `wrangler deploy`, and once per site after each
 * production stack's Alchemy deploy; in deploy.yml (dev) once per surface of
 * a stack, after the Alchemy deploy of that stack:
 *
 *   bun run scripts/smoke-check.ts <surface> <tier>
 *
 * A deploy reports success when the upload succeeds, not when the Worker can
 * serve: a missing secret makes osn-api answer 503 on every route while its
 * job goes green. This asks the Worker's own hosts (SMOKE_TARGETS) what a
 * working one answers, every 10 seconds for a minute, and calls the deploy
 * healthy once every probe passes in two rounds in a row. On dev every surface
 * is a Worker, the sites included, and each is checked.
 *
 * Two rounds, because no answer here names the version that gave it: a request
 * made the moment the deploy returns can still reach the version before it.
 * A second pass ten seconds later narrows that window; it does not close it.
 *
 * When the minute runs out and the Worker itself is still answering wrongly,
 * this restores the version that served before this deploy, through the
 * Cloudflare deployments API, then probes once more to say whether that version
 * answers. Either way it exits 1, which fails the job, and GitHub marks the
 * job's Deployment record `failure`. scripts/release-plan.ts counts only
 * records whose job succeeded, so the next release offers the surface again.
 *
 * The rollback is made here rather than by `wrangler rollback`, which in CI
 * answers its own "secrets have changed" prompt with yes and forces the
 * rollback through. Restoring a version whose secrets differ would put the old
 * secret values back — a rotated key, a revoked sign-in secret — so when
 * Cloudflare refuses for that reason, this leaves the Worker as it is and asks a
 * person. It reads the Worker's deployments before the first probe, and rolls
 * back only while the newest of them is the one this job made — on production
 * the version named in the output file the deploy step's wrangler wrote, on
 * dev the deployment id scripts/worker-deployments.ts found after the stack
 * deploy — so a deploy made by anything else, before or during the check, is
 * never overwritten. Each read of the deployments is tried up to three times,
 * 1 s then 2 s apart, after a network error, a timeout, a 429 or a 5xx; the
 * restore itself is sent once. On dev a Worker the stack deploy left unchanged is never
 * rolled back, and one still serving what an earlier smoke check restored
 * fails at once: the stack's state names code that Worker does not serve, and
 * the next run re-uploads it with --force. An unchanged Worker whose history
 * cannot be read fails the same way, unprobed, since the check cannot rule
 * that out.
 *
 * It does not roll back when nothing answered (DNS, TLS, a timeout) or when
 * Cloudflare answered in the Worker's place (Access, a bot challenge, a 429):
 * a rollback restores code, and code is not what failed. The step fails all
 * the same.
 *
 * On dev, a browser host sits behind Cloudflare Access, and each round also
 * asks its `/` once with no service token. Only Access's redirect to its
 * sign-in, a 301, 302, 303 or 307 to a `*.cloudflareaccess.com` host, passes.
 * Any other answer means Access does not guard the host, and fails the check
 * with an annotation naming Access. That failure never rolls back: the Worker
 * is not what failed.
 *
 * A rollback restores the Worker's code, not its D1 database: the migrations
 * the job applied before deploying stay applied. That is why a migration must
 * keep working with the Worker version before it.
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *                       the job's own Cloudflare credentials, sent only to
 *                       api.cloudflare.com, to read the Worker's deployments
 *                       and to roll it back. Without both, a check that fails
 *                       says so and rolls nothing back.
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 *                       a Cloudflare Access service token, sent only to a
 *                       target behind Access (the dev sites), and only when
 *                       both are set, on every probe but the one that asks
 *                       without it. Without them the check probes anyway,
 *                       and Access answering fails it, rolling nothing back.
 *   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT
 *                       name the run in the rollback message.
 *   GITHUB_STEP_SUMMARY receives a line when the check fails.
 * Production only:
 *   WRANGLER_OUTPUT_FILE_PATH
 *                       the file the deploy step's `wrangler deploy` wrote its
 *                       output to (the workflow sets it on both steps). Its
 *                       `deploy` entry names the version this job deployed.
 *                       Unset, as in a hand run, the newest deployment at the
 *                       first read is taken to be this job's.
 * A Worker a stack deploys (every dev surface, and each production site in
 * SMOKE_TARGETS' `productionSite`), each required:
 *   SMOKE_ORIGIN        the https:// origin of the surface's host, with no
 *                       path, query or trailing slash, from the stack job's
 *                       dev-hosts step on dev and its production-hosts step on
 *                       production.
 *   SMOKE_MARKETING_ORIGIN
 *                       the cire marketing site's origin, which the guest
 *                       site's `/` redirects to (cire_invites only).
 *   SMOKE_DEPLOYMENT    what scripts/worker-deployments.ts compare found: the
 *                       id of the deployment the stack deploy made, `unchanged`
 *                       when it made none, or `unknown` when it could not
 *                       read the Worker (then the check probes and never rolls
 *                       back).
 *
 * Exit codes: 0 healthy; 1 unhealthy; 2 a usage error, before any request —
 * nothing is rolled back.
 */

import { appendFileSync, readFileSync } from "node:fs";

import type { SurfaceKey } from "./deploy-surfaces";

// ── what each Worker answers ────────────────────────────────────────────────

export type Expectation =
  /** 200, a JSON body whose top-level fields equal these. */
  | { readonly kind: "json"; readonly fields: Readonly<Record<string, string | boolean>> }
  /** 200, a JWK set holding an ES256 key on P-256. */
  | { readonly kind: "jwks" }
  /** A 3xx whose Location is on this origin. */
  | { readonly kind: "redirect"; readonly to: string }
  /** A rendered HTML page, 200 or 404. */
  | { readonly kind: "page" }
  /** 200, an HTML page. */
  | { readonly kind: "html" }
  /** 200, a body that parses to a JSON object. */
  | { readonly kind: "jsonObject" }
  /** 200, served as `application/json`, a body that parses to a JSON object: a static JSON file. */
  | { readonly kind: "jsonFile" }
  /**
   * Asked with no service token: a 301, 302, 303 or 307 to a
   * `*.cloudflareaccess.com` host, Cloudflare Access sending the caller to
   * its sign-in. Never the Worker's own answer.
   */
  | { readonly kind: "access" };

export interface Probe {
  readonly url: string;
  readonly expects: Expectation;
}

export interface SmokeTarget {
  /** The Cloudflare Worker this tier's deploy step deploys, by name. */
  readonly worker: string;
  /** Where the deploy step runs wrangler, relative to the repository root. */
  readonly cwd: string;
  /** The arguments that pick the Worker, exactly as the deploy step passes them. */
  readonly wrangler: readonly string[];
  readonly probes: readonly Probe[];
  /** The host sits behind Cloudflare Access, so probes need a service token. */
  readonly access?: boolean;
}

/** The origins a dev target's probes are built from, as the stack job passes them. */
export interface DevOrigins {
  readonly origin: string;
  readonly marketing?: string;
}

/** A dev Worker, which the stack deploys on a host the dev-hosts step derives. */
export interface DevSmokeTarget {
  /** The Worker's dev script name, which a rollback acts on. */
  readonly worker: string;
  /**
   * A browser host behind Cloudflare Access; never an API host. Its check
   * sends the service token, and also asks `/` without it to see Access answer.
   */
  readonly access: boolean;
  readonly probes: (origins: DevOrigins) => readonly Probe[];
  /** The probes need SMOKE_MARKETING_ORIGIN as well as SMOKE_ORIGIN. */
  readonly needsMarketing: boolean;
}

/**
 * A production site Worker the production stack deploys. Its host depends on
 * the site's mode (shared/infra/src/production-sites.ts), so the stack job
 * passes its origin, as on dev.
 */
export interface SiteSmokeTarget {
  /** The Worker's production script name, which a rollback acts on. */
  readonly worker: string;
  readonly probes: (origin: string) => readonly Probe[];
}

interface SmokeTargets {
  readonly dev?: DevSmokeTarget;
  /** A Worker production-release.yml deploys with Wrangler. */
  readonly production?: SmokeTarget;
  /** A site Worker the production stack deploys. */
  readonly productionSite?: SiteSmokeTarget;
}

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

/** A page a site Worker serves from its assets. */
const sitePage = (origin: string, path: string): Probe => ({
  url: `${origin}${path}`,
  expects: { kind: "html" },
});

/**
 * musubi social's Apple app-site association file, which iOS reads to offer
 * the app's passkeys on the site's host (osn/ios/project.yml). It is a hidden
 * file in the build, so an upload that drops dot-directories loses it.
 */
const appleAssociation = (origin: string): Probe => ({
  url: `${origin}/.well-known/apple-app-site-association`,
  expects: { kind: "jsonFile" },
});

/** `/` asked with no service token, which Access must answer on a host it guards. */
const accessGate = (origin: string): Probe => ({
  url: `${origin}/`,
  expects: { kind: "access" },
});

/** The marketing origin; runSmokeCheck refuses a guest-site check without one. */
function marketingOf(origins: DevOrigins): string {
  if (origins.marketing === undefined)
    throw new Error("the guest site's probes need its marketing origin");
  return origins.marketing;
}

/**
 * Production hosts come from each Worker's route config (wrangler.toml,
 * wrangler.jsonc), Worker names from the same files, and the marketing origin
 * from the job's PUBLIC_MARKETING_URL; scripts/tests/smoke-targets.test.ts
 * holds them equal. A dev target names no host: the stack job passes the
 * origin its dev-hosts step derives (SMOKE_ORIGIN). Its Worker is the dev
 * script name the stack declares.
 */
export const SMOKE_TARGETS = {
  cire_api: {
    production: {
      worker: "cire-api-production",
      cwd: "cire/api",
      wrangler: ["--env", "production"],
      probes: [cireSession("https://api.cireweddings.com")],
    },
    dev: {
      worker: "cire-api-dev",
      access: false,
      probes: ({ origin }) => [cireSession(origin)],
      needsMarketing: false,
    },
  },
  cire_invites: {
    production: {
      worker: "cire-invites",
      cwd: "cire/invites",
      wrangler: ["--config", "dist/server/wrangler.json"],
      probes: guestSite("https://invite.cireweddings.com", "https://cireweddings.com"),
    },
    dev: {
      worker: "cire-invites-dev",
      access: true,
      probes: (origins) => guestSite(origins.origin, marketingOf(origins)),
      needsMarketing: true,
    },
  },
  osn_api: {
    production: {
      worker: "osn-api-production",
      cwd: "osn/api",
      wrangler: ["--env", "production"],
      probes: [health("https://id.musubi.social"), jwks("https://id.musubi.social")],
    },
    dev: {
      worker: "osn-api-dev",
      access: false,
      probes: ({ origin }) => [health(origin), jwks(origin)],
      needsMarketing: false,
    },
  },
  zap_api: {
    production: {
      worker: "zap-api-production",
      cwd: "zap/api",
      wrangler: ["--env", "production"],
      probes: [health("https://zap.cireweddings.com")],
    },
    dev: {
      worker: "zap-api-dev",
      access: false,
      probes: ({ origin }) => [health(origin)],
      needsMarketing: false,
    },
  },
  cire_host: {
    productionSite: { worker: "cire-host", probes: (origin) => [sitePage(origin, "/")] },
    dev: {
      worker: "cire-host-dev",
      access: true,
      probes: ({ origin }) => [sitePage(origin, "/")],
      needsMarketing: false,
    },
  },
  cire_vendor: {
    productionSite: { worker: "cire-vendor", probes: (origin) => [sitePage(origin, "/")] },
    dev: {
      worker: "cire-vendor-dev",
      access: true,
      probes: ({ origin }) => [sitePage(origin, "/")],
      needsMarketing: false,
    },
  },
  cire_landing: {
    productionSite: { worker: "cire-landing", probes: (origin) => [sitePage(origin, "/")] },
    dev: {
      worker: "cire-landing-dev",
      access: true,
      probes: ({ origin }) => [sitePage(origin, "/")],
      needsMarketing: false,
    },
  },
  osn_social: {
    productionSite: {
      worker: "osn-social",
      probes: (origin) => [
        sitePage(origin, "/"),
        sitePage(origin, "/smoke-check-deep-link"),
        appleAssociation(origin),
      ],
    },
    dev: {
      worker: "osn-social-dev",
      access: true,
      // A path no route names gets the single-page fallback: the app's shell.
      probes: ({ origin }) => [sitePage(origin, "/"), sitePage(origin, "/smoke-check-deep-link")],
      needsMarketing: false,
    },
  },
  musubi_landing: {
    productionSite: { worker: "musubi-landing", probes: (origin) => [sitePage(origin, "/")] },
    dev: {
      worker: "musubi-landing-dev",
      access: true,
      probes: ({ origin }) => [sitePage(origin, "/")],
      needsMarketing: false,
    },
  },
  pulse_landing: {
    productionSite: {
      worker: "pulse-landing",
      probes: (origin) => [
        sitePage(origin, "/"),
        { url: `${origin}/api/geo`, expects: { kind: "jsonObject" } },
      ],
    },
    dev: {
      worker: "pulse-landing-dev",
      access: true,
      // /api/geo is the Worker's own code, not an asset.
      probes: ({ origin }) => [
        sitePage(origin, "/"),
        { url: `${origin}/api/geo`, expects: { kind: "jsonObject" } },
      ],
      needsMarketing: false,
    },
  },
} as const satisfies Record<SurfaceKey, SmokeTargets>;

export type WorkerSurface = keyof typeof SMOKE_TARGETS;

/** The production target for a surface, or undefined when production deploys no Worker for it. */
export function productionTarget(surface: SurfaceKey): SmokeTarget | undefined {
  const tiers: SmokeTargets = SMOKE_TARGETS[surface];
  return tiers.production;
}

/** The production site target for a surface, or undefined when no production stack deploys a site Worker for it. */
export function productionSiteTarget(surface: SurfaceKey): SiteSmokeTarget | undefined {
  const tiers: SmokeTargets = SMOKE_TARGETS[surface];
  return tiers.productionSite;
}

/** The dev target for a surface, or undefined when dev deploys no Worker for it. */
export function devTarget(surface: SurfaceKey): DevSmokeTarget | undefined {
  const tiers: SmokeTargets = SMOKE_TARGETS[surface];
  return tiers.dev;
}

// ── judging one answer ──────────────────────────────────────────────────────

export type Outcome =
  | { readonly kind: "pass" }
  /** The Worker answered, and the answer is not what a working one gives. */
  | { readonly kind: "wrong"; readonly reason: string }
  /** No answer: DNS, TLS, the connection, the timeout, or a body cut off. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** Cloudflare answered in the Worker's place: Access, a bot challenge, a 429. */
  | { readonly kind: "blocked"; readonly reason: string }
  /** Access did not answer a request without the service token: the host may be open to anyone. */
  | { readonly kind: "open"; readonly reason: string };

const PASS: Outcome = { kind: "pass" };

/** Text on one line, at most `max` characters. */
export const oneLine = (text: string, max = 200) =>
  text.replaceAll(/\s+/g, " ").trim().slice(0, max);

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

/** The redirects Access answers a caller without a session or token with. */
const isAccessRedirect = (status: number) => [301, 302, 303, 307].includes(status);

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

/** Whether the body parses to a JSON object (not an array, not null). */
function isJsonObject(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as object | null;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
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
 *
 * A 429 is never the Worker's verdict on itself: no probed route rate-limits,
 * and Cloudflare answers 429 for every Worker on the account once its daily
 * request cap is spent — which anyone can bring about from the public hosts.
 * Counting it as wrong would let them turn a release into a rollback.
 */
export function judge(probe: Probe, response: Response, body: string, access: boolean): Outcome {
  const { status } = response;
  const location = locationOf(response, probe.url);
  const { expects } = probe;
  if (expects.kind === "access") {
    return isAccessRedirect(status) && location?.hostname.endsWith(".cloudflareaccess.com") === true
      ? PASS
      : {
          kind: "open",
          reason: `answered ${status}${location === undefined ? "" : ` to ${location.origin}`} to a request with no service token, where Cloudflare Access redirects to its sign-in on a cloudflareaccess.com host`,
        };
  }
  if (isRedirect(status) && location?.hostname.endsWith(".cloudflareaccess.com")) {
    return {
      kind: "blocked",
      reason: `Cloudflare Access answered (${status} to ${location.origin}), not the Worker`,
    };
  }
  const mitigated = response.headers.get("cf-mitigated");
  if (mitigated !== null) {
    return {
      kind: "blocked",
      reason: `Cloudflare answered ${status} in the Worker's place (cf-mitigated: ${oneLine(mitigated, 40)})`,
    };
  }
  if (status === 429) {
    return {
      kind: "blocked",
      reason:
        "answered 429: a rate limit or the account's daily request cap, not the Worker's code",
    };
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
            reason: `answered ${status} ${oneLine(type, 80) || "with no content type"}, expected an HTML page, 200 or 404`,
          };
    }
    case "html": {
      const type = response.headers.get("content-type") ?? "";
      return status === 200 && type.startsWith("text/html")
        ? PASS
        : {
            kind: "wrong",
            reason: `answered ${status} ${oneLine(type, 80) || "with no content type"}, expected a 200 HTML page`,
          };
    }
    case "jsonObject":
      return status === 200 && isJsonObject(body) ? PASS : wrong("200 with a JSON object");
    case "jsonFile": {
      const type = response.headers.get("content-type") ?? "";
      return status === 200 && type.startsWith("application/json") && isJsonObject(body)
        ? PASS
        : {
            kind: "wrong",
            reason: `answered ${status} ${oneLine(type, 80) || "with no content type"}, expected 200 application/json holding a JSON object`,
          };
    }
  }
}

/**
 * Ask once. Never follows a redirect: a login page is not the Worker. A body
 * cut off part-way counts as no answer, the same as a connection that drops.
 */
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
      reason: `no answer: ${oneLine(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

// ── rolling back ────────────────────────────────────────────────────────────

/** How long the check keeps asking, how often, and how long one request may take. */
export const TIMING = { budgetMs: 60_000, intervalMs: 10_000, requestMs: 10_000 } as const;

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's refusal to restore a version whose secrets have changed since. */
export const SECRETS_CHANGED = 10_220;

/** One entry of a Worker's deployment history. */
export interface Deployment {
  readonly id: string;
  readonly created_on: string;
  readonly versions: readonly { readonly version_id: string; readonly percentage: number }[];
  /** `workers/message` is the note a deploy or a rollback was made with. */
  readonly annotations?: { readonly "workers/message"?: string };
}

/** The start of the note a smoke-check rollback leaves on the deployment it makes. */
export const ROLLBACK_MESSAGE_PREFIX = "Smoke check failed";

/** Whether a deployment is a smoke check's rollback, by the note rollbackMessage writes. */
export function isSmokeRollback(deployment: Deployment): boolean {
  return deployment.annotations?.["workers/message"]?.startsWith(ROLLBACK_MESSAGE_PREFIX) === true;
}

/**
 * A deployment id as the Cloudflare deployments API returns it: a UUID.
 * Anything else in SMOKE_DEPLOYMENT (bar `unchanged` and `unknown`), or read
 * back from the API, is refused rather than compared or written to
 * $GITHUB_OUTPUT, so a typo is never taken for an id.
 */
export const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiAnswer<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly codes: readonly number[]; readonly reason: string };

export interface Cloudflare {
  readonly fetch: typeof fetch;
  /** How a read of the deployments waits before its next attempt. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly token: string;
  readonly account: string;
}

/** The job's Cloudflare credentials, or why there are none. */
export function cloudflareCredentials(
  env: Readonly<Record<string, string | undefined>>,
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Cloudflare | string {
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (token === "" || account === "") {
    return "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both set";
  }
  if (!/^[0-9a-f]{32}$/i.test(account)) return "CLOUDFLARE_ACCOUNT_ID is not an account ID";
  return { fetch: fetcher, sleep, token, account };
}

/** The waits before a deployments read's second and third attempts. */
export const READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

type DeploymentsCall =
  | { readonly method: "GET" }
  | { readonly method: "POST"; readonly body: unknown };

/** One attempt's answer, and whether it failed in a way a later attempt could get past. */
interface Attempt<T> {
  readonly answer: ApiAnswer<T>;
  readonly transient: boolean;
}

/**
 * A call to the Cloudflare API on a Worker's deployments. A GET changes
 * nothing, so it is tried again after a network error, a timeout, a 429 or a
 * 5xx, waiting each of READ_RETRY_DELAYS_MS in turn. A POST restores a
 * version and is sent once: sent again it could restore twice or race a
 * deploy.
 */
async function deploymentsApi<T>(
  api: Cloudflare,
  worker: string,
  init: DeploymentsCall,
): Promise<ApiAnswer<T>> {
  const first = await attemptDeployments<T>(api, worker, init);
  if (init.method === "POST") return first.answer;
  const retry = async (attempt: Attempt<T>, delays: readonly number[]): Promise<ApiAnswer<T>> => {
    const [delay, ...rest] = delays;
    if (!attempt.transient || delay === undefined) return attempt.answer;
    await api.sleep(delay);
    return retry(await attemptDeployments<T>(api, worker, init), rest);
  };
  return retry(first, READ_RETRY_DELAYS_MS);
}

/** One attempt at a call to the Cloudflare API on a Worker's deployments. */
async function attemptDeployments<T>(
  api: Cloudflare,
  worker: string,
  init: DeploymentsCall,
): Promise<Attempt<T>> {
  const url = `${CLOUDFLARE_API}/accounts/${api.account}/workers/scripts/${encodeURIComponent(worker)}/deployments`;
  try {
    const response = await api.fetch(url, {
      method: init.method,
      headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
      body: init.method === "POST" ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMING.requestMs),
    });
    const envelope = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: readonly { code?: number; message?: string }[];
      result?: T;
    };
    if (response.ok && envelope.success === true) {
      return { answer: { ok: true, result: envelope.result as T }, transient: false };
    }
    const errors = envelope.errors ?? [];
    return {
      answer: {
        ok: false,
        codes: errors.flatMap((e) => (typeof e.code === "number" ? [e.code] : [])),
        reason: oneLine(
          errors.map((e) => `${e.message ?? "error"} [code: ${e.code ?? "none"}]`).join("; ") ||
            `Cloudflare answered ${response.status}`,
        ),
      },
      transient: response.status === 429 || response.status >= 500,
    };
  } catch (error) {
    return {
      answer: {
        ok: false,
        codes: [],
        reason: `no answer from the Cloudflare API: ${oneLine(error instanceof Error ? error.message : String(error))}`,
      },
      transient: true,
    };
  }
}

/** A Worker's deployments, newest first, as `wrangler rollback` orders them. */
export async function readDeployments(
  api: Cloudflare,
  worker: string,
): Promise<ApiAnswer<readonly Deployment[]>> {
  const answer = await deploymentsApi<{ deployments?: readonly Deployment[] }>(api, worker, {
    method: "GET",
  });
  if (!answer.ok) return answer;
  const deployments = answer.result.deployments ?? [];
  return {
    ok: true,
    result: deployments.toSorted((a, b) => b.created_on.localeCompare(a.created_on)),
  };
}

/**
 * The version a `wrangler deploy` reports in its output file: the last
 * `deploy` entry's `version_id`. Undefined when the file names none.
 */
export function deployedVersion(ndjson: string): string | undefined {
  const versions = ndjson.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { type?: unknown; version_id?: unknown } | null;
      return entry?.type === "deploy" && typeof entry.version_id === "string"
        ? [entry.version_id]
        : [];
    } catch {
      return [];
    }
  });
  return versions.at(-1);
}

/** The version named in the deploy step's output file, or why it cannot be read. */
function readDeployedVersion(path: string): string | { readonly error: string } {
  try {
    const version = deployedVersion(readFileSync(path, "utf8"));
    return version ?? { error: "the deploy step's wrangler output names no deployed version" };
  } catch {
    return {
      error: "the deploy step's wrangler output (WRANGLER_OUTPUT_FILE_PATH) cannot be read",
    };
  }
}

/**
 * What a rollback would restore, read before the first probe: the newest
 * deployment, which must be this job's, and the version that served at 100%
 * in the newest one before it — the choice `wrangler rollback` makes.
 * `refused` marks a plan that a deploy by something else made unsafe.
 */
export type RestorePlan =
  | { readonly ok: true; readonly newest: string; readonly version: string }
  | { readonly ok: false; readonly refused: boolean; readonly reason: string };

export function restorePlan(
  newestFirst: readonly Deployment[],
  deployed: string | undefined,
): RestorePlan {
  const [newest, ...earlier] = newestFirst;
  if (newest === undefined) {
    return { ok: false, refused: false, reason: "the Worker has no deployments" };
  }
  const serving = newest.versions.find((v) => v.percentage === 100)?.version_id;
  if (deployed !== undefined && serving !== deployed) {
    return {
      ok: false,
      refused: true,
      reason: `the newest deployment serves ${serving ?? "a split of versions"}, not ${deployed}, the version this job deployed`,
    };
  }
  const before = earlier
    .map((deployment) => deployment.versions.find((v) => v.percentage === 100))
    .find((version) => version !== undefined);
  return before === undefined
    ? {
        ok: false,
        refused: false,
        reason: "no earlier version served all traffic — a first deploy has none",
      }
    : { ok: true, newest: newest.id, version: before.version_id };
}

/**
 * What a rollback on dev would restore, read before the first probe, judged by
 * the deployment the stack deploy made (SMOKE_DEPLOYMENT): never a Worker the
 * deploy left unchanged or could not read, never once another deployment has
 * replaced this run's, and otherwise the version that served at 100% in the
 * newest deployment before it.
 */
export function devRestorePlan(
  newestFirst: readonly Deployment[],
  deployment: string,
  worker: string,
): RestorePlan {
  if (deployment === "unchanged") {
    return { ok: false, refused: true, reason: `this run deployed nothing to ${worker}` };
  }
  if (deployment === "unknown") {
    return {
      ok: false,
      refused: true,
      reason: `the deployment this run made to ${worker} could not be read, so what to restore is not known`,
    };
  }
  const [newest, ...earlier] = newestFirst;
  if (newest === undefined) {
    return { ok: false, refused: false, reason: "the Worker has no deployments" };
  }
  if (newest.id !== deployment) {
    return {
      ok: false,
      refused: true,
      reason: `${worker} was deployed again since this run deployed ${deployment} (its newest deployment is ${newest.id})`,
    };
  }
  const before = earlier
    .map((d) => d.versions.find((v) => v.percentage === 100))
    .find((version) => version !== undefined);
  return before === undefined
    ? {
        ok: false,
        refused: false,
        reason: "no earlier version served all traffic — a first deploy has none",
      }
    : { ok: true, newest: newest.id, version: before.version_id };
}

type Rollback =
  | { readonly kind: "done"; readonly version: string }
  /** Cloudflare or this script declined; the Worker is as the check found it. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

async function rollBack(
  api: Cloudflare | string,
  worker: string,
  plan: RestorePlan | undefined,
  message: string,
): Promise<Rollback> {
  if (typeof api === "string") return { kind: "failed", reason: api };
  if (plan === undefined) return { kind: "failed", reason: "the deployments were never read" };
  if (!plan.ok) return { kind: plan.refused ? "refused" : "failed", reason: plan.reason };
  const now = await readDeployments(api, worker);
  if (!now.ok) return { kind: "failed", reason: `reading the deployments: ${now.reason}` };
  const newest = now.result[0]?.id;
  if (newest !== plan.newest) {
    return {
      kind: "refused",
      reason: `${worker} was deployed again during the check (deployment ${newest ?? "none"}), so the version to restore is no longer known`,
    };
  }
  // No `?force=true`: Cloudflare refuses a version whose secrets have changed
  // since, and that refusal is the one check that compares secret values.
  const answer = await deploymentsApi<unknown>(api, worker, {
    method: "POST",
    body: {
      strategy: "percentage",
      versions: [{ version_id: plan.version, percentage: 100 }],
      annotations: { "workers/message": message },
    },
  });
  if (answer.ok) return { kind: "done", version: plan.version };
  if (answer.codes.includes(SECRETS_CHANGED)) {
    return {
      kind: "refused",
      reason: `the secrets of ${worker} changed since version ${plan.version} served, and restoring it would put the old values back (${answer.reason})`,
    };
  }
  return { kind: "failed", reason: answer.reason };
}

// ── the run ─────────────────────────────────────────────────────────────────

/** Rounds in a row that must pass. */
const PASSES_NEEDED = 2;

/** The longest rollback message wrangler takes, kept for the same dashboard. */
const MESSAGE_LIMIT = 120;

export function rollbackMessage(env: Readonly<Record<string, string | undefined>>): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
    return `${ROLLBACK_MESSAGE_PREFIX} outside GitHub Actions`;
  }
  const server = GITHUB_SERVER_URL || "https://github.com";
  const attempt = GITHUB_RUN_ATTEMPT ? `/attempts/${GITHUB_RUN_ATTEMPT}` : "";
  return `${ROLLBACK_MESSAGE_PREFIX}: ${server}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`.slice(
    0,
    MESSAGE_LIMIT,
  );
}

const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/**
 * A GitHub workflow command on one line, escaped as @actions/core escapes it,
 * so no text from an answer can end the line and start a command of its own.
 */
export function annotation(
  level: "error" | "warning" | "notice",
  message: string,
  title?: string,
): string {
  const property = (value: string) =>
    escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
  return `::${level}${title === undefined ? "" : ` title=${property(title)}`}::${escapeData(message)}\n`;
}

export interface SmokeCheckInput {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (text: string) => void;
}

const isWorkerSurface = (value: string): value is WorkerSurface =>
  Object.hasOwn(SMOKE_TARGETS, value);

/** An https:// origin exactly: no path, query, fragment, credentials or trailing slash. */
function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/** What the run checks, once the arguments and the environment are read. */
interface Checked {
  readonly worker: string;
  readonly probes: readonly Probe[];
  readonly access: boolean;
  /** On dev, a host behind Access: `/` asked without the service token. */
  readonly gate: Probe | undefined;
}

type Round = readonly Outcome[];

export async function runSmokeCheck(input: SmokeCheckInput): Promise<number> {
  const { env, out } = input;
  const usage = (message: string): number => {
    out(annotation("error", `smoke-check: ${message}`));
    return 2;
  };

  if (input.args.length !== 2) return usage("usage: smoke-check.ts <surface> <tier>");
  const [surface = "", tier = ""] = input.args;
  if (!isWorkerSurface(surface)) {
    return usage(
      `'${surface}' is not a surface; use one of ${Object.keys(SMOKE_TARGETS).join(", ")}`,
    );
  }
  if (tier !== "dev" && tier !== "production")
    return usage(`tier must be dev or production, not '${tier}'`);

  // The origins on dev, and the deployment the stack deploy made, are the
  // stack job's to pass; a check guessing either would judge the wrong host or
  // roll back the wrong deployment.
  const origin = (name: string): string | undefined => {
    const value = env[name] ?? "";
    return isHttpsOrigin(value) ? value : undefined;
  };
  const badOrigin = (name: string): number =>
    usage(
      env[name] === undefined || env[name] === ""
        ? `${name} is not set: the stack job passes each dev check its origin`
        : `${name} must be an https:// origin with no path, query or trailing slash, not '${oneLine(env[name] ?? "", 100)}'`,
    );

  /** SMOKE_DEPLOYMENT, as the stack job's compare step wrote it; a usage error's exit code otherwise. */
  const readDeployment = (): string | number => {
    const value = env.SMOKE_DEPLOYMENT ?? "";
    if (value !== "unchanged" && value !== "unknown" && !DEPLOYMENT_ID.test(value)) {
      return usage(
        `SMOKE_DEPLOYMENT must be the deployment id worker-deployments.ts compare wrote, 'unchanged' or 'unknown', not '${oneLine(value, 100)}'`,
      );
    }
    return value;
  };

  let checked: Checked;
  let deployment: string | undefined;
  const site = tier === "production" ? productionSiteTarget(surface) : undefined;
  if (site !== undefined) {
    // A site Worker the production stack deployed, on the host its mode
    // gives it; the stack job passes that origin and what its compare found.
    const siteOrigin = origin("SMOKE_ORIGIN");
    if (siteOrigin === undefined) return badOrigin("SMOKE_ORIGIN");
    const found = readDeployment();
    if (typeof found === "number") return found;
    deployment = found;
    checked = {
      worker: site.worker,
      probes: site.probes(siteOrigin),
      access: false,
      gate: undefined,
    };
  } else if (tier === "production") {
    const target = productionTarget(surface);
    if (target === undefined) return usage(`${surface} has no production Worker`);
    checked = {
      worker: target.worker,
      probes: target.probes,
      access: target.access === true,
      gate: undefined,
    };
  } else {
    const target = devTarget(surface);
    if (target === undefined) return usage(`${surface} has no dev Worker`);
    const devOrigin = origin("SMOKE_ORIGIN");
    if (devOrigin === undefined) return badOrigin("SMOKE_ORIGIN");
    const marketing = target.needsMarketing ? origin("SMOKE_MARKETING_ORIGIN") : undefined;
    if (target.needsMarketing && marketing === undefined)
      return badOrigin("SMOKE_MARKETING_ORIGIN");
    const found = readDeployment();
    if (typeof found === "number") return found;
    deployment = found;
    checked = {
      worker: target.worker,
      probes: target.probes(
        marketing === undefined ? { origin: devOrigin } : { origin: devOrigin, marketing },
      ),
      access: target.access,
      gate: target.access ? accessGate(devOrigin) : undefined,
    };
  }

  const label = `${surface} (${tier})`;
  const summary = (line: string) => {
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `- **${label}**: ${line}\n`);
    }
  };
  const accessId = env.CF_ACCESS_CLIENT_ID ?? "";
  const accessSecret = env.CF_ACCESS_CLIENT_SECRET ?? "";
  const accessToken = accessId !== "" && accessSecret !== "";
  const headers: Record<string, string> = {};
  if (checked.access && accessToken) {
    headers["cf-access-client-id"] = accessId;
    headers["cf-access-client-secret"] = accessSecret;
  }
  if (deployment === "unknown") {
    out(
      annotation(
        "warning",
        `${label}: the deployment this run made to ${checked.worker} could not be read, so the check probes it but rolls nothing back.`,
      ),
    );
  }

  // An unchanged Worker may still serve an earlier smoke check's rollback,
  // which only its history shows. Unread, a healthy answer would record
  // success for code the Worker may not serve, so the check fails unprobed.
  const unreadableUnchanged = (reason: string): number => {
    out(
      annotation(
        "error",
        `${label}: this run deployed nothing to ${checked.worker}, and its deployment history could not be read (${reason}), so the check cannot tell whether an earlier smoke check restored ${checked.worker}. Not probed and not rolled back; dispatch Deploy to check it again.`,
        "Smoke check failed",
      ),
    );
    summary("this run deployed nothing, and the deployment history could not be read; not probed.");
    return 1;
  };

  // Read before the first probe, so a rollback restores what served before
  // this deploy and can tell whether anything deployed the Worker since.
  const api = cloudflareCredentials(env, input.fetch, input.sleep);
  if (deployment === "unchanged" && typeof api === "string") return unreadableUnchanged(api);
  let plan: RestorePlan | undefined;
  if (typeof api !== "string") {
    const output = deployment === undefined ? (env.WRANGLER_OUTPUT_FILE_PATH ?? "") : "";
    const deployed = output === "" ? undefined : readDeployedVersion(output);
    if (typeof deployed === "object") {
      plan = { ok: false, refused: false, reason: deployed.error };
    } else {
      const deployments = await readDeployments(api, checked.worker);
      if (deployment === "unchanged" && !deployments.ok) {
        return unreadableUnchanged(deployments.reason);
      }
      const [newest] = deployments.ok ? deployments.result : [];
      if (deployment === "unchanged" && newest !== undefined && isSmokeRollback(newest)) {
        out(
          annotation(
            "error",
            `${label}: an earlier smoke check restored ${checked.worker}, and this run deployed nothing over it, so it does not serve what this commit declares. The next run sees that rollback and re-uploads the Worker with --force; dispatch Deploy to run it now.`,
            "Smoke check failed",
          ),
        );
        summary(
          "an earlier smoke check's rollback still serves, and this run deployed nothing over it; not probed.",
        );
        return 1;
      }
      if (!deployments.ok) {
        plan = {
          ok: false,
          refused: false,
          reason: `reading the deployments before the check: ${deployments.reason}`,
        };
      } else {
        plan =
          deployment === undefined
            ? restorePlan(deployments.result, deployed)
            : devRestorePlan(deployments.result, deployment, checked.worker);
      }
    }
  }

  // The Worker's own probes come first: the round after a rollback judges
  // the restored version on those alone.
  const probes: Probe[] = [...checked.probes];
  if (checked.gate !== undefined) probes.push(checked.gate);
  const ask = (): Promise<Round> =>
    Promise.all(
      probes.map((probe) =>
        probeOnce(probe, {
          fetch: input.fetch,
          // The Access probe asks without the token, as any visitor would.
          headers: probe.expects.kind === "access" ? {} : headers,
          access: checked.access,
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

  // Only the last round decides: a Worker that answered wrongly earlier but
  // no longer answers at all is judged on what it does now.
  const { last } = result;
  const failures = probes.flatMap((probe, index) => {
    const outcome = last[index];
    return outcome === undefined || outcome.kind === "pass" ? [] : [{ probe, outcome }];
  });
  for (const { probe, outcome } of failures) {
    out(annotation("error", `${probe.url}: ${outcome.reason}`));
  }
  if (checked.access && failures.some(({ outcome }) => outcome.kind === "blocked")) {
    out(
      annotation(
        "error",
        accessToken
          ? `${label}: Cloudflare answered in the Worker's place. Check that CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET on this Environment hold a service token the Access application allows.`
          : `${label}: Cloudflare answered in the Worker's place, and CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are not both set on this Environment. A host behind Cloudflare Access needs that service token for its check.`,
        "Cloudflare Access",
      ),
    );
  }

  if (failures.some(({ outcome }) => outcome.kind === "open")) {
    out(
      annotation(
        "error",
        `${label}: ${checked.gate?.url ?? "/"} answered a request with no service token without Cloudflare Access's sign-in, so the host may be open to anyone. Check that a dev Access application covers this host. The Worker is not what failed, so this never rolls it back.`,
        "Cloudflare Access",
      ),
    );
  }

  if (!failures.some(({ outcome }) => outcome.kind === "wrong")) {
    const accessOnly = failures.every(({ outcome }) => outcome.kind === "open");
    out(
      annotation(
        "error",
        accessOnly
          ? `${label}: the Worker answers as a working one does, but Cloudflare Access does not guard its host — not rolling back.`
          : `${label} did not answer as a working Worker does within ${TIMING.budgetMs / 1000} s, but the Worker never answered wrongly — not rolling back. See the probes above.`,
        "Smoke check failed",
      ),
    );
    summary(
      accessOnly
        ? "the Worker answers as it should, but Cloudflare Access does not guard its host; not rolled back."
        : "smoke check failed without a wrong answer from the Worker; not rolled back.",
    );
    return 1;
  }

  out(
    annotation(
      "error",
      `${label} answered wrongly for ${TIMING.budgetMs / 1000} s; rolling the Worker back.`,
      "Smoke check failed",
    ),
  );
  const rollback = await rollBack(api, checked.worker, plan, rollbackMessage(env));
  // What the Worker runs now is not known here — a request that timed out may
  // still have landed — so the person is told what to check, and what served
  // before this deploy when that is known. A rollback by hand of a Worker a
  // stack deploys (every dev Worker, and the production sites) leaves the
  // stack's state naming code the Worker does not serve, which no later run
  // would see, so only a Worker Wrangler deploys is told how to make one.
  const lookFirst = `Check what ${checked.worker} serves (its Deployments tab) before acting.`;
  const byHand =
    plan?.ok !== true
      ? lookFirst
      : deployment === undefined
        ? `${lookFirst} The version that served before this deploy is ${plan.version}; to restore it by hand, run \`bunx wrangler rollback ${plan.version}\` with the Worker's selector.`
        : `${lookFirst} The version that served before this deploy is ${plan.version}.`;
  if (rollback.kind === "refused") {
    out(annotation("error", `Not rolled back: ${rollback.reason}. ${byHand}`, "Rollback refused"));
    summary(`smoke check failed; rollback refused: ${rollback.reason}.`);
    return 1;
  }
  if (rollback.kind === "failed") {
    out(
      annotation("error", `The rollback failed: ${rollback.reason}. ${byHand}`, "Rollback failed"),
    );
    summary(`smoke check failed, and the rollback failed: ${rollback.reason}.`);
    return 1;
  }

  await input.sleep(TIMING.intervalMs);
  const after = await ask();
  // The Access probe judges the host, not the Worker; leave it out of the
  // restored version's verdict.
  const restored = after.slice(0, checked.probes.length);
  if (passed(restored)) {
    out(
      annotation(
        "notice",
        `${label} rolled back to version ${rollback.version}; the restored version answers healthy.`,
      ),
    );
    summary("smoke check failed; rolled back, and the restored version answers healthy.");
  } else {
    out(
      annotation(
        "error",
        `${label} rolled back to version ${rollback.version}, and the restored version is still failing: the cause is not this deploy's code (a secret, a binding, D1, an upstream).`,
        "Still failing after rollback",
      ),
    );
    summary("smoke check failed; rolled back, and the restored version is still failing.");
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
    out: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
