#!/usr/bin/env bun
/**
 * Times what the first D1 query of a request costs on the cire DEV tier, from
 * wherever this runs. `.github/workflows/cire-d1-latency-probe.yml` runs it on a
 * GitHub-hosted runner; it runs the same way from a laptop.
 *
 * Every request `cire-api` serves opens its D1 session `first-primary`
 * (`src/db/d1-session.ts`), so the first query of a request goes to the
 * primary, which is in Oceania. The probe times one route two ways:
 *
 * - control: `GET /api/claim/session` with no cookie. `sessionAuth` finds no
 *   token and answers 401 without touching D1.
 * - query: the same request with an unknown `cire_session` cookie. `sessionAuth`
 *   hashes it and runs one `SELECT` on `sessions`, finds nothing, and answers
 *   the same 401.
 *
 * Same route, same middleware, same status, same body: the only extra work is
 * that one `SELECT` (plus a SHA-256 of a short string). `tests/index.test.ts`
 * drives these exact requests through the Worker and asserts zero queries and
 * one, so a change to the route or the cookie name fails a test instead of
 * quietly turning the query arm into a second control.
 *
 * The target comes from `wrangler.toml`: `[env.dev.vars] CIRE_API_ORIGIN`, which
 * must be a host the dev Worker is routed on. Requests are spaced from the dev
 * `CLAIM_SESSION_RATE_LIMITER` budget in the same file. Nothing on the command
 * line can point it at production.
 *
 * Imports only Bun and web built-ins, so CI runs it with `bun --no-install`.
 * Output goes to stdout and, on GitHub Actions, to the step summary.
 *
 * @see wiki/shared/d1-read-replication.md — where the results are recorded.
 */

export const MIN_SAMPLES = 25;
export const MAX_SAMPLES = 100;
export const DEFAULT_SAMPLES = 50;
/** Pairs sent before measuring and thrown away: a cold isolate builds the whole app graph. */
export const WARM_UP_PAIRS = 3;
/**
 * A cost below this cannot include a D1 round trip: the smallest ever measured
 * is 33.0 ms (p10, a Sydney client against the Oceania primary). A result under
 * it means the query arm never reached D1 — most likely the cookie was lost.
 */
const FLOOR_MS = 5;
/** Space requests at two thirds of the limiter's budget. */
const PACING_HEADROOM = 1.5;
const PROBE_PATH = "/api/claim/session";
/** `GUEST_COOKIE_NAME` in `src/lib/cookie.ts`. */
const SESSION_COOKIE = "cire_session";
const LIMITER_BINDING = "CLAIM_SESSION_RATE_LIMITER";
const IMDS_LOCATION_URL =
  "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text";

export interface DevTarget {
  readonly origin: string;
  readonly limit: number;
  readonly periodSeconds: number;
}

export interface ProbeRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ProbePair {
  readonly control: ProbeRequest;
  readonly query: ProbeRequest;
}

export type Arm = keyof ProbePair;

export interface Pair {
  readonly control: number;
  readonly query: number;
}

export interface Spread {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
}

export interface Summary {
  readonly n: number;
  readonly control: Spread;
  readonly query: Spread;
  /** Percentiles of (query − control) taken pair by pair. */
  readonly difference: Spread;
  /** Median of the query arm minus median of the control arm. */
  readonly costOfOneQuery: number;
}

export interface ProbeRun {
  readonly url: string;
  readonly startedAt: Date;
  readonly windowSeconds: number;
  /** The runner's own report of its region; `null` when it gave none. */
  readonly region: string | null;
  /** Cloudflare colo → how many measured requests it served. */
  readonly colos: Readonly<Record<string, number>>;
  readonly spacingMs: number;
  readonly warmUpPairs: number;
  readonly pairs: readonly Pair[];
  /** The GitHub Actions run, or `null` for a local run. */
  readonly runUrl: string | null;
}

/**
 * Only the shape this reads. Fields stay `unknown`: the file is hand-edited,
 * and the checks below are what narrow them.
 */
type DevConfig = {
  readonly env?: {
    readonly dev?: {
      readonly vars?: { readonly CIRE_API_ORIGIN?: unknown };
      readonly routes?: readonly { readonly pattern?: unknown }[];
      readonly unsafe?: {
        readonly bindings?: readonly {
          readonly name?: unknown;
          readonly simple?: { readonly limit?: unknown; readonly period?: unknown };
        }[];
      };
    };
  };
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** The dev API origin and the budget of the limiter the probed route sits behind. */
export function readDevTarget(toml: string): DevTarget {
  const dev = (Bun.TOML.parse(toml) as DevConfig).env?.dev;

  const origin = dev?.vars?.CIRE_API_ORIGIN;
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new Error("wrangler.toml has no [env.dev.vars] CIRE_API_ORIGIN");
  }
  const url = new URL(origin);
  if (url.protocol !== "https:") {
    throw new Error(`CIRE_API_ORIGIN must be https, got ${origin}`);
  }
  if (url.origin !== origin.replace(/\/$/, "")) {
    throw new Error(`CIRE_API_ORIGIN must be a bare origin, got ${origin}`);
  }
  const routed = (dev?.routes ?? []).some((route) => route.pattern === url.host);
  if (!routed) {
    throw new Error(`${url.host} is not a pattern in [[env.dev.routes]]`);
  }

  const limiter = (dev?.unsafe?.bindings ?? []).find((binding) => binding.name === LIMITER_BINDING);
  if (!limiter) {
    throw new Error(`[[env.dev.unsafe.bindings]] has no ${LIMITER_BINDING}`);
  }
  const limit = limiter.simple?.limit;
  const period = limiter.simple?.period;
  if (!isPositiveInteger(limit)) {
    throw new Error(`${LIMITER_BINDING} simple.limit must be a positive whole number`);
  }
  if (!isPositiveInteger(period)) {
    throw new Error(`${LIMITER_BINDING} simple.period must be a positive whole number`);
  }

  return { origin: url.origin, limit, periodSeconds: period };
}

/** Milliseconds between requests, so a run stays well inside the limiter. */
export function spacingMs(target: DevTarget): number {
  return Math.ceil(((target.periodSeconds * 1000) / target.limit) * PACING_HEADROOM);
}

/** Pairs to measure. Blank means the default; anything else must be 25 to 100. */
export function parseSampleCount(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return DEFAULT_SAMPLES;
  const count = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!(count >= MIN_SAMPLES && count <= MAX_SAMPLES)) {
    throw new Error(`samples must be a whole number from 25 to 100, got "${raw}"`);
  }
  return count;
}

/** The two requests the probe times. */
export function probeRequests(origin: string, token: string): ProbePair {
  const url = `${origin}${PROBE_PATH}`;
  return {
    control: { url, headers: {} },
    query: { url, headers: { cookie: `${SESSION_COOKIE}=${token}` } },
  };
}

/** Linear interpolation between closest ranks (Hyndman–Fan type 7, numpy's default). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of an empty sample");
  const sorted = values.toSorted((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const below = Math.floor(rank);
  const above = Math.ceil(rank);
  const low = sorted[below] ?? Number.NaN;
  const high = sorted[above] ?? Number.NaN;
  return low + (high - low) * (rank - below);
}

const spread = (values: readonly number[]): Spread => ({
  p10: percentile(values, 0.1),
  p50: percentile(values, 0.5),
  p90: percentile(values, 0.9),
});

export function summarise(pairs: readonly Pair[]): Summary {
  const control = spread(pairs.map((pair) => pair.control));
  const query = spread(pairs.map((pair) => pair.query));
  return {
    n: pairs.length,
    control,
    query,
    difference: spread(pairs.map((pair) => pair.query - pair.control)),
    costOfOneQuery: query.p50 - control.p50,
  };
}

/** True when the measured cost is too small to include any D1 round trip. */
export function isBelowFloor(summary: Summary): boolean {
  return summary.costOfOneQuery < FLOOR_MS;
}

/** The Cloudflare colo that served a response, from the suffix of its `cf-ray`. */
export function coloFromRay(ray: string | null): string | null {
  const suffix = ray?.slice(ray.lastIndexOf("-") + 1) ?? "";
  return ray?.includes("-") && /^[A-Z]{3}$/.test(suffix) ? suffix : null;
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

/** One colo by its code alone; several with how many requests each served. */
const coloList = (colos: Readonly<Record<string, number>>) => {
  const entries = Object.entries(colos).toSorted(([, a], [, b]) => b - a);
  return entries.length === 1
    ? (entries[0]?.[0] ?? "")
    : entries.map(([colo, count]) => `${colo} ×${count}`).join(", ");
};

/** Markdown for stdout and the step summary, ending with lines to paste into the wiki. */
export function renderReport(run: ProbeRun): string {
  const summary = summarise(run.pairs);
  const colos = coloList(run.colos);
  const region = run.region ?? "not reported";
  const date = run.startedAt.toISOString().slice(0, 10);
  const row = (label: string, s: Spread) =>
    `| ${label} | ${ms(s.p10)} | ${ms(s.p50)} | ${ms(s.p90)} |`;

  const client = run.runUrl ? `GitHub-hosted runner (${region})` : "Local run";
  const marker = run.runUrl
    ? `*Measured ${date} — [\`cire-d1-latency-probe.yml\` run](${run.runUrl}), runner region ${region}, colo ${colos}, n=${summary.n}*`
    : `*Measured ${date} — \`bun --no-install cire/api/scripts/d1-latency-probe.ts\` from a local client, colo ${colos}, n=${summary.n}*`;
  const d = summary.difference;

  return [
    "## cire dev D1: what the first query costs",
    "",
    `\`GET ${run.url}\` with no cookie (control) and with an unknown \`${SESSION_COOKIE}\` cookie (one \`SELECT\` on \`sessions\`). Every request opens a \`first-primary\` D1 session, so that \`SELECT\` is the first query and goes to the primary.`,
    "",
    "| | |",
    "|---|---|",
    `| Runner region (as the runner reports it) | ${region} |`,
    `| Cloudflare colo (from \`cf-ray\`; ×N counts requests) | ${colos} |`,
    `| Pairs | ${summary.n} measured, ${run.warmUpPairs} warm-up pairs discarded, arm order alternating |`,
    `| Spacing | ${run.spacingMs} ms between requests |`,
    `| Window | from ${run.startedAt.toISOString()}, ${Math.round(run.windowSeconds)} s |`,
    "",
    "| Measure | p10 | p50 | p90 |",
    "|---|---|---|---|",
    row("Control (no D1 query)", summary.control),
    row("One extra `SELECT`", summary.query),
    row("Paired difference", summary.difference),
    "",
    `**Cost of one query: ${ms(summary.costOfOneQuery)}** — the median of the \`SELECT\` arm minus the median of the control.`,
    "",
    "The paired difference carries the network jitter of both requests and any cold isolate, so its tails are wider than the D1 cost's own, and its p10 can go below zero. All samples come from one window; they say nothing about other times of day.",
    "",
    "### For `wiki/shared/d1-read-replication.md`",
    "",
    "```markdown",
    `| ${client} | ${colos} | ${ms(summary.control.p50)} | ${ms(summary.query.p50)} | **${ms(summary.costOfOneQuery)}** | ${d.p10.toFixed(1)} / ${d.p50.toFixed(1)} / ${d.p90.toFixed(1)} ms | ${summary.n} |`,
    "",
    marker,
    "```",
    "",
    "<details><summary>Raw pairs (control, query) in ms</summary>",
    "",
    ...run.pairs.map((pair) => `${pair.control.toFixed(1)}, ${pair.query.toFixed(1)}`),
    "",
    "</details>",
    "",
  ].join("\n");
}

/** Azure's instance metadata names the region; GitHub-hosted runners are Azure VMs. Best effort. */
async function runnerRegion(): Promise<string | null> {
  if (process.env.GITHUB_ACTIONS !== "true") return null;
  try {
    const response = await fetch(IMDS_LOCATION_URL, {
      headers: { Metadata: "true" },
      signal: AbortSignal.timeout(2000),
    });
    const text = (await response.text()).trim();
    return response.ok && /^[a-z0-9]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

export interface Timed {
  readonly ms: number;
  readonly colo: string;
}

/**
 * The colo that served a probe response, or an error naming what went wrong.
 * Anything but a 401 means the Worker did not run the route the probe times,
 * and a response with no colo cannot say where the Worker ran.
 */
export function checkProbeResponse(arm: Arm, response: Response): string {
  if (response.status !== 401) {
    const mitigated = response.headers.get("cf-mitigated");
    const hint =
      response.status === 429
        ? "the limiter refused it: requests came faster than its budget, or another client shares this IP"
        : mitigated
          ? `Cloudflare answered a ${mitigated} instead of the Worker`
          : "dev may be mid-deploy or mid-rebuild; try again later";
    throw new Error(
      `${arm} request answered ${response.status}, expected 401 — ${hint}. Nothing was recorded.`,
    );
  }
  const colo = coloFromRay(response.headers.get("cf-ray"));
  if (!colo) {
    throw new Error(
      `${arm} response carried no cf-ray colo, so where the Worker ran is unknown. Nothing was recorded.`,
    );
  }
  return colo;
}

async function timeOne(arm: Arm, request: ProbeRequest): Promise<Timed> {
  const started = performance.now();
  const response = await fetch(request.url, { headers: request.headers, redirect: "manual" });
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  return { ms: elapsed, colo: checkProbeResponse(arm, response) };
}

export interface PairRun {
  readonly pairs: readonly Pair[];
  /** Cloudflare colo → how many measured requests it served. */
  readonly colos: Readonly<Record<string, number>>;
}

/**
 * Time `warmUp + samples` pairs one after another and keep the last `samples`.
 * The arm that goes first alternates, so neither arm always follows a pause,
 * and every request is followed by `sleep(spacing)` so the run stays inside
 * the limiter's budget.
 */
export async function measurePairs({
  warmUp,
  samples,
  time,
  sleep,
  onPair = () => {},
}: {
  readonly warmUp: number;
  readonly samples: number;
  readonly time: (arm: Arm) => Promise<Timed>;
  readonly sleep: () => Promise<void>;
  readonly onPair?: (done: number, total: number) => void;
}): Promise<PairRun> {
  const pairs: Pair[] = [];
  const colos: Record<string, number> = {};
  const total = warmUp + samples;

  const measurePair = async (first: Arm, second: Arm) => {
    const a = await time(first);
    await sleep();
    const b = await time(second);
    await sleep();
    const control = first === "control" ? a : b;
    const query = first === "control" ? b : a;
    return { pair: { control: control.ms, query: query.ms }, seen: [a.colo, b.colo] };
  };

  for (let index = 0; index < total; index += 1) {
    const [first, second]: readonly [Arm, Arm] =
      index % 2 === 0 ? ["control", "query"] : ["query", "control"];
    // Pairs must run one after another: overlapping requests would time each
    // other, and would spend the limiter's budget all at once.
    // eslint-disable-next-line no-await-in-loop
    const { pair, seen } = await measurePair(first, second);
    if (index >= warmUp) {
      pairs.push(pair);
      for (const colo of seen) colos[colo] = (colos[colo] ?? 0) + 1;
    }
    onPair(index + 1, total);
  }
  return { pairs, colos };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<number> {
  const target = readDevTarget(await Bun.file(new URL("../wrangler.toml", import.meta.url)).text());
  const samples = parseSampleCount(process.env.SAMPLES);
  const spacing = spacingMs(target);
  const requests = probeRequests(target.origin, randomToken());
  const region = await runnerRegion();

  const startedAt = new Date();
  const started = performance.now();
  const { pairs, colos } = await measurePairs({
    warmUp: WARM_UP_PAIRS,
    samples,
    time: (arm) => timeOne(arm, requests[arm]),
    sleep: () => Bun.sleep(spacing),
    onPair: (done, total) => process.stderr.write(`pair ${done}/${total}\r`),
  });
  process.stderr.write("\n");

  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_STEP_SUMMARY } = process.env;
  const report = renderReport({
    url: requests.control.url,
    startedAt,
    windowSeconds: (performance.now() - started) / 1000,
    region,
    colos,
    spacingMs: spacing,
    warmUpPairs: WARM_UP_PAIRS,
    pairs,
    runUrl:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : null,
  });
  process.stdout.write(report);
  if (GITHUB_STEP_SUMMARY) {
    const summaryFile = Bun.file(GITHUB_STEP_SUMMARY);
    const existing = (await summaryFile.exists()) ? await summaryFile.text() : "";
    await Bun.write(summaryFile, existing + report);
  }

  if (isBelowFloor(summarise(pairs))) {
    process.stderr.write(
      `The cost is under ${FLOOR_MS} ms, below any D1 round trip measured so far. The query arm most likely never reached D1: check that the ${SESSION_COOKIE} cookie reaches the Worker. Do not record this result.\n`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `d1-latency-probe: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
