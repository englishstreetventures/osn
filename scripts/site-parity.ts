#!/usr/bin/env bun
/**
 * Compare each staged production site as its Worker serves it with the same
 * site as its Pages project serves it today, before the site's domain moves.
 *
 * While a site is `staged` (shared/infra/src/production-sites.ts) the
 * production stack deploys its production build to a Worker on the site's
 * spare host in its own zone, and the Pages project keeps the production
 * host. This asks both hosts the same paths and reports where their answers
 * differ: the status, the Location (without its own origin), every header
 * the build's `_headers` names, and a fixed list besides. The paths are `/`,
 * an unknown path, musubi social's deep link, every `_headers` rule and every
 * `_redirects` source, a wildcard filled from a file the build holds.
 *
 * Two differences are expected and accepted unless a real path relies on
 * them: an unknown path that Pages answers 200 with the single-page fallback
 * and the Worker answers 404, and Pages' `access-control-allow-origin: *`.
 * The owner reads the report before each site's flip.
 *
 *   bun run scripts/site-parity.ts --stack <cire|musubi> --out <report.json> [--root <dir>]
 *
 * `--root` is the checkout holding the built sites (default: the working
 * directory). It holds no credential and needs none: both hosts are public.
 * The report is the same for the same answers: keys in one order, paths and
 * headers sorted, no time.
 *
 * Every request carries smoke-check's CI_USER_AGENT, since Cloudflare's Bot
 * Fight Mode challenges Bun's own from a GitHub runner. An answer Cloudflare
 * gives in a site's place compares nothing about the site: a challenge
 * (`cf-mitigated`), an Access redirect or a 429, which `judge()` in
 * smoke-check.ts calls `blocked`, and a 403 carrying Cloudflare's own error
 * page, which its Block action and its other 1xxx errors answer.
 *
 * `/` must also answer both hosts as the site's own page: a 2xx with an HTML
 * content type. A zone's custom error page or custom block response carries
 * no mark of Cloudflare, so two of them would compare as alike; `/` is a
 * page on every staged site, so on `/` anything else is refused, no answer
 * included. A redirect counts as no page, even to the same path on both
 * hosts: redirects are not followed, so it proves no page answered, and a
 * zone's redirect rule answers both hosts alike. On any other path such an
 * answer is compared as the site's own.
 *
 * A path refused either way is asked again on both hosts once: RETRY_MS
 * later, all such paths at once; after a 429, once the longest wait its
 * answers name has passed (its `Retry-After` in seconds, at most
 * RATE_LIMIT_MAX_MS, else RATE_LIMIT_RETRY_MS), one path at a time. If
 * either side still answers so, the run refuses: the report's `refused` list
 * names the site, the side and the path, and an error says why.
 *
 * Imports only node built-ins and the repository's import-free files.
 *
 * Exit codes: 0 every answer matches; 1 a difference, or a host that did not
 * answer a path other than `/`; 2 a usage error, before any request; 3
 * Cloudflare answered in a site's place, or `/` did not answer both hosts as
 * the site's own page, whatever else differs; 4 an error stopped the run, and
 * the report may be missing. The report is written before every 0, 1 or 3.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  PRODUCTION_SITE_MODES,
  productionHost,
  SITE_BUILDS,
  SITE_SURFACES,
  siteDomain,
  type PerSite,
  type SiteMode,
  type SiteSurface,
  type SomeSites,
} from "../shared/infra/src/production-sites";
import { PRODUCTION_STACKS, surface } from "./deploy-surfaces";
import { CI_USER_AGENT, judge, oneLine } from "./smoke-check";

/** Headers compared on every answer, beside those the build's `_headers` names. */
export const ALWAYS_COMPARED: readonly string[] = [
  "access-control-allow-origin",
  "cache-control",
  "content-type",
  "referrer-policy",
  "x-content-type-options",
];

/** A path no site serves. */
export const UNKNOWN_PATH = "/site-parity-no-such-page";

/** How long a path Cloudflare answered in a site's place waits before it is asked again. */
export const RETRY_MS = 2_000;

/** How long a path answered 429 waits before it is asked again, when the 429 names no wait. */
export const RATE_LIMIT_RETRY_MS = 15_000;

/** The longest a path answered 429 waits, whatever its `Retry-After` names. */
export const RATE_LIMIT_MAX_MS = 30_000;

/**
 * The element every Cloudflare error page holds: its Block action's "Sorry,
 * you have been blocked", its 1xxx errors (1020, an IP Access rule, Zone
 * Lockdown) and its 5xx pages, in the older template and the newer one.
 */
const CLOUDFLARE_PAGE_MARKER = 'id="cf-error-details"';

/** musubi social routes in the browser, so a deep link must reach its shell. */
const DEEP_LINKS: SomeSites<readonly string[]> = {
  osn_social: ["/site-parity-deep-link"],
};

export interface HeaderRule {
  readonly path: string;
  readonly names: readonly string[];
}

/** The rules of a `_headers` file: each path line and the header names under it. */
export function headerRules(text: string): HeaderRule[] {
  const rules: { path: string; names: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), names: [] });
      continue;
    }
    const header = /^\s+!?\s*([A-Za-z0-9-]+)\s*:?/.exec(line);
    if (header !== null) rules.at(-1)?.names.push((header[1] ?? "").toLowerCase());
  }
  return rules;
}

/** The sources of a `_redirects` file. */
export function redirectSources(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((source) => source.startsWith("/"));
}

/** The platform's config files: read, never served. */
const CONFIG_FILES: ReadonlySet<string> = new Set(["/_headers", "/_redirects", "/.assetsignore"]);

/** Every file under `dir` the site serves, as a URL path. */
function filePaths(dir: string): string[] {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const path = join(at, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() ? [`/${relative(dir, path).split(sep).join("/")}`] : [];
    });
  return walk(dir)
    .filter((path) => !CONFIG_FILES.has(path))
    .toSorted();
}

/**
 * `pattern` as a path to ask: itself when it has no wildcard, otherwise the
 * first file the build holds that it matches, or undefined when none does. A
 * path ending in `index.html` is asked as its directory, as a browser would.
 */
export function fillPattern(pattern: string, files: readonly string[]): string | undefined {
  if (pattern.startsWith("https://")) return undefined;
  if (!/[*:]/.test(pattern)) return pattern;
  const escaped = pattern
    .split(/(\*|:[A-Za-z]+)/)
    .map((part) =>
      part === "*"
        ? ".*"
        : part.startsWith(":")
          ? "[^/]+"
          : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  const pathPattern = new RegExp(`^${escaped}$`);
  const match = files.find((file) => pathPattern.test(file));
  return match?.replace(/\/index\.html$/, "/");
}

export interface SiteProbes {
  readonly paths: readonly string[];
  readonly headers: readonly string[];
  /** Patterns no file in the build matches, so no path asks them. */
  readonly unmatched: readonly string[];
}

/** What to ask of a site, from its build directory. */
export function siteProbes(site: SiteSurface, directory: string): SiteProbes {
  const read = (name: string) =>
    existsSync(join(directory, name)) ? readFileSync(join(directory, name), "utf8") : "";
  const rules = headerRules(read("_headers"));
  const files = existsSync(directory) ? filePaths(directory) : [];
  const patterns = [...rules.map((rule) => rule.path), ...redirectSources(read("_redirects"))];
  const filled = patterns.map((pattern) => ({ pattern, path: fillPattern(pattern, files) }));
  const paths = [
    "/",
    UNKNOWN_PATH,
    ...(DEEP_LINKS[site] ?? []),
    ...filled.flatMap((entry) => (entry.path === undefined ? [] : [entry.path])),
  ];
  return {
    paths: [...new Set(paths)].toSorted(),
    headers: [...new Set([...ALWAYS_COMPARED, ...rules.flatMap((rule) => rule.names)])].toSorted(),
    unmatched: filled
      .flatMap((entry) => (entry.path === undefined ? [entry.pattern] : []))
      .toSorted(),
  };
}

export type Observation =
  | {
      readonly status: number;
      readonly location: string | null;
      readonly headers: Readonly<Record<string, string | null>>;
    }
  | { readonly error: "no answer" }
  /**
   * Cloudflare answered in the site's place, and why. On a 429, observe()
   * also says how long to wait before asking again; the report never holds
   * that wait, which belongs to the run.
   */
  | { readonly blocked: string; readonly retryAfterMs?: number };

/** The wait a 429 names: its `Retry-After` in whole seconds, at most RATE_LIMIT_MAX_MS; RATE_LIMIT_RETRY_MS when it names none. */
function rateLimitWait(response: Response): number {
  const value = (response.headers.get("retry-after") ?? "").trim();
  return /^\d+$/.test(value)
    ? Math.min(Number(value) * 1000, RATE_LIMIT_MAX_MS)
    : RATE_LIMIT_RETRY_MS;
}

/** One answer, with `origin` taken out of its Location so two hosts compare. */
export async function observe(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  headers: readonly string[],
): Promise<Observation> {
  const url = `${origin}${path}`;
  try {
    const response = await fetcher(url, {
      redirect: "manual",
      // Cloudflare answers `*/*` with its error pages' HTML, the marker below.
      headers: { "user-agent": CI_USER_AGENT, accept: "*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    // Only a 403's body is read; any other is drained. A body cut off reads as empty.
    const body = await (
      response.status === 403 ? response.text() : response.arrayBuffer().then(() => "")
    ).catch(() => "");
    // judge() reads the status and headers: an Access redirect, `cf-mitigated`
    // or a 429 is Cloudflare's answer. Cloudflare's Block action (a WAF rule,
    // an IP Access rule, Zone Lockdown, bot protection) and its other 1xxx
    // errors answer 403 with no `cf-mitigated`, but with Cloudflare's own
    // error page. Any other 401 or 403 is compared as the site's own answer.
    // A zone that serves its own page in place of Cloudflare's (a custom
    // error page, a custom block response) leaves no marker: runSiteParity
    // refuses it when it answers `/`, which must be a page; on any other
    // path two of those compare as alike.
    const outcome = judge({ url, expects: { kind: "page" } }, response, "", false);
    if (outcome.kind === "blocked") {
      // judge() words its reasons for a Worker; either side here is a site.
      const reason = outcome.reason.replaceAll("the Worker", "the site");
      return response.status === 429
        ? { blocked: reason, retryAfterMs: rateLimitWait(response) }
        : { blocked: reason };
    }
    if (response.status === 403 && body.includes(CLOUDFLARE_PAGE_MARKER)) {
      return {
        blocked:
          "Cloudflare answered 403 with its own error page in the site's place (a block rule, or a fault in the host's DNS or custom domain)",
      };
    }
    const location = response.headers.get("location");
    return {
      status: response.status,
      location: location === null ? null : location.replace(origin, ""),
      headers: Object.fromEntries(headers.map((name) => [name, response.headers.get(name)])),
    };
  } catch {
    return { error: "no answer" };
  }
}

/** The path every staged site serves as a page, and so must answer as one on both hosts. */
const HOME = "/";

/**
 * Why an answer on `/` is not the site's own page, or undefined when it is
 * one: a 2xx whose content type, before any parameter, is `text/html`. A
 * blocked answer is refused for its own reason before this is asked.
 */
function notThePage(seen: Observation): string | undefined {
  if ("error" in seen) return seen.error;
  if (!("status" in seen)) return undefined;
  const type = seen.headers["content-type"] ?? "";
  const media = (type.split(";")[0] ?? "").trim().toLowerCase();
  if (seen.status >= 200 && seen.status <= 299 && media === "text/html") return undefined;
  const to = seen.location === null ? "" : ` to ${oneLine(seen.location, 80)}`;
  return `answered ${seen.status}${to} ${oneLine(type, 80) || "with no content type"}, expected a 2xx HTML page`;
}

/** The fields two observations differ in: `status`, `location`, a header name, or `answer`. */
export function differences(a: Observation, b: Observation): string[] {
  if (!("status" in a) || !("status" in b)) return ["answer"];
  const fields: string[] = [];
  if (a.status !== b.status) fields.push("status");
  if (a.location !== b.location) fields.push("location");
  for (const name of Object.keys(a.headers)) {
    if (a.headers[name] !== b.headers[name]) fields.push(name);
  }
  return fields;
}

export interface SiteParityInput {
  readonly args: readonly string[];
  readonly root: string;
  readonly fetch: typeof fetch;
  readonly out: (text: string) => void;
  /** The site modes, PRODUCTION_SITE_MODES unless a test passes its own. */
  readonly modes?: PerSite<SiteMode>;
  /** Waits before a path is asked again: Bun.sleep unless a test passes its own. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The two hosts of a staged site: its Worker on the spare host, and its Pages project. */
const SIDES = ["worker", "pages"] as const;
const SIDE_NAMES = { worker: "Worker", pages: "Pages" } as const;

/**
 * A path refused on one side after it was asked again: Cloudflare answered
 * in the site's place, or `/` did not answer as the site's own page.
 */
export interface Refusal {
  readonly site: SiteSurface;
  readonly side: (typeof SIDES)[number];
  readonly path: string;
  readonly reason: string;
}

export async function runSiteParity(input: SiteParityInput): Promise<number> {
  const { out } = input;
  const modes = input.modes ?? PRODUCTION_SITE_MODES;
  const usage = (message: string): number => {
    out(`::error::site-parity: ${message}\n`);
    return 2;
  };
  const value = (name: string): string | undefined => {
    const at = input.args.indexOf(`--${name}`);
    const found = at === -1 ? undefined : input.args[at + 1];
    return found === undefined || found.startsWith("--") ? undefined : found;
  };
  const stackKey = value("stack");
  const outFile = value("out");
  const stacks = PRODUCTION_STACKS.map((s) => s.key);
  if (stackKey === undefined || !stacks.some((key) => key === stackKey) || outFile === undefined) {
    return usage(`pass --stack <${stacks.join("|")}> and --out <report.json>`);
  }
  const root = value("root") ?? input.root;
  const staged = SITE_SURFACES.filter(
    (site) => surface(site).stack === stackKey && modes[site] === "staged",
  );

  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const plans = staged.map((site) => ({
    site,
    worker: `https://${siteDomain(site, "staged") ?? ""}`,
    pages: `https://${productionHost(site)}`,
    probes: siteProbes(site, join(root, SITE_BUILDS[site].directory)),
  }));
  type Plan = (typeof plans)[number];
  const askBoth = (plan: Plan, path: string) =>
    Promise.all([
      observe(input.fetch, plan.worker, path, plan.probes.headers),
      observe(input.fetch, plan.pages, path, plan.probes.headers),
    ]);

  // Every path of every site at once.
  const asks = await Promise.all(
    plans.flatMap((plan) =>
      plan.probes.paths.map(async (path) => ({
        plan,
        path,
        answers: await askBoth(plan, path),
        /** How long the path waited before it was asked again; 0 when it was asked once. */
        waited: 0,
      })),
    ),
  );
  type Ask = (typeof asks)[number];
  // A path Cloudflare answered in a site's place, or a `/` that is not the
  // site's own page, is asked again once. After a 429, once the longest wait
  // those answers name has passed, one path at a time, so the second round is
  // never a burst into the same limit; after any other, RETRY_MS later, all
  // at once. A path with a 429 on either side goes with the 429s only.
  const waits = (ask: Ask) =>
    ask.answers.flatMap((seen) =>
      "blocked" in seen && seen.retryAfterMs !== undefined ? [seen.retryAfterMs] : [],
    );
  const doubted = (ask: Ask) =>
    ask.answers.some((seen) => "blocked" in seen) ||
    (ask.path === HOME && ask.answers.some((seen) => notThePage(seen) !== undefined));
  const again = asks.filter(doubted);
  const limited = again.filter((ask) => waits(ask).length > 0);
  const challenged = again.filter((ask) => waits(ask).length === 0);
  const limitWait = Math.max(0, ...limited.flatMap(waits));
  const askAgain = async (ask: Ask, wait: number) => {
    ask.answers = await askBoth(ask.plan, ask.path);
    ask.waited = wait;
  };
  const askLimitedInTurn = async () => {
    await sleep(limitWait);
    for (const ask of limited) {
      // oxlint-disable-next-line no-await-in-loop -- one path at a time, so the second round is never a burst
      await askAgain(ask, limitWait);
    }
  };
  await Promise.all([
    challenged.length === 0
      ? undefined
      : sleep(RETRY_MS).then(() => Promise.all(challenged.map((ask) => askAgain(ask, RETRY_MS)))),
    limited.length === 0 ? undefined : askLimitedInTurn(),
  ]);

  // The report holds what the site answered, never the run's wait.
  const reported = (seen: Observation): Observation =>
    "blocked" in seen ? { blocked: seen.blocked } : seen;
  const sites = plans.map((plan) => ({
    site: plan.site,
    worker: plan.worker,
    pages: plan.pages,
    unmatched: plan.probes.unmatched,
    probes: asks
      .filter((ask) => ask.plan === plan)
      .map(({ path, answers: [onWorker, onPages] }) => ({
        path,
        worker: reported(onWorker),
        pages: reported(onPages),
        differs: differences(onWorker, onPages),
      })),
  }));

  // Sites in map order, paths sorted, the Worker side before the Pages side,
  // whichever the reason.
  const refusals = sites.flatMap(({ site, probes }) =>
    probes.flatMap((result) =>
      SIDES.flatMap((side) => {
        const seen = result[side];
        const byCloudflare = "blocked" in seen;
        const reason = byCloudflare
          ? seen.blocked
          : result.path === HOME
            ? notThePage(seen)
            : undefined;
        return reason === undefined
          ? []
          : [{ site, side, path: result.path, reason, byCloudflare }];
      }),
    ),
  );
  const refused: Refusal[] = refusals.map(({ site, side, path, reason }) => ({
    site,
    side,
    path,
    reason,
  }));
  // A refused path compared nothing, so it is never a difference too.
  const differ = sites.flatMap(({ site, probes }) =>
    probes
      .filter((result) => result.differs.length > 0)
      .filter((result) => !refused.some((one) => one.site === site && one.path === result.path))
      .map((result) => ({ site, path: result.path, differs: result.differs })),
  );
  const differing = differ.length;

  mkdirSync(dirname(outFile), { recursive: true });
  // Every object is built with its keys in one order, and every list sorted
  // (paths, headers), so the same answers write the same bytes.
  writeFileSync(
    outFile,
    `${JSON.stringify({ stack: stackKey, sites, differing, refused }, null, 2)}\n`,
  );
  if (staged.length === 0) {
    out(`No ${stackKey} site is staged; nothing to compare.\n`);
    return 0;
  }
  for (const result of differ) {
    out(`${result.site} ${result.path}: ${result.differs.join(", ")} differ\n`);
  }
  if (differing > 0) {
    out(
      `::warning::site-parity: ${differing} path${differing === 1 ? "" : "s"} answer differently on the staged Worker and on Pages; read the report before the site's flip.\n`,
    );
  }
  for (const one of refusals) {
    const host = sites.find((entry) => entry.site === one.site)?.[one.side] ?? "";
    const waited =
      asks.find((ask) => ask.plan.site === one.site && ask.path === one.path)?.waited ?? 0;
    // The refusal rests on the second answer, which may be the first to fail.
    const asked = `on the ${SIDE_NAMES[one.side]} side (${host}) when asked again ${waited / 1000} s later: ${one.reason}`;
    out(
      one.byCloudflare
        ? `::error::site-parity: Cloudflare answered in the site's place for ${one.site} ${one.path} ${asked}. That is the zone's configuration, such as Bot Fight Mode, not the site; nothing was compared.\n`
        : `::error::site-parity: ${one.site} ${one.path} did not answer as the site's own page ${asked}. A run passes only when \`/\` answers both hosts with a 2xx HTML page; a zone's custom error page or custom block response answers otherwise, as does a host or custom domain that is not ready (no answer, or Cloudflare's 52x or 530 page), or a site with no page at \`/\`. Nothing was compared on \`/\`.\n`,
    );
  }
  if (refused.length > 0) return 3;
  if (differing > 0) return 1;
  out(`Every path of the staged ${stackKey} sites answers as Pages does.\n`);
  return 0;
}

if (import.meta.main) {
  // An error that stops the run exits 4: Bun's own exit on one is 1, which
  // reads as a difference.
  const code = await runSiteParity({
    args: process.argv.slice(2),
    root: process.cwd(),
    fetch,
    out: (text) => process.stdout.write(text),
  }).catch((error: unknown) => {
    process.stdout.write(
      `::error::site-parity: stopped on an error before it finished: ${oneLine(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 4;
  });
  process.exit(code);
}
