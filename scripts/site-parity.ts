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
 * Imports only node built-ins and the repository's import-free files.
 *
 * Exit codes: 0 every answer matches; 1 a difference, or a host that did not
 * answer; 2 a usage error, before any request.
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
  const match = files.find((file) => new RegExp(`^${escaped}$`).test(file));
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
  | { readonly error: "no answer" };

/** One answer, with `origin` taken out of its Location so two hosts compare. */
export async function observe(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  headers: readonly string[],
): Promise<Observation> {
  try {
    const response = await fetcher(`${origin}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer().catch(() => undefined);
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

/** The fields two observations differ in: `status`, `location`, a header name, or `answer`. */
export function differences(a: Observation, b: Observation): string[] {
  if ("error" in a || "error" in b) return ["answer"];
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

  let differing = 0;
  const sites = await Promise.all(
    staged.map(async (site) => {
      const directory = join(root, SITE_BUILDS[site].directory);
      const probes = siteProbes(site, directory);
      const worker = `https://${siteDomain(site, "staged") ?? ""}`;
      const pages = `https://${productionHost(site)}`;
      const results = await Promise.all(
        probes.paths.map(async (path) => {
          const [onWorker, onPages] = await Promise.all([
            observe(input.fetch, worker, path, probes.headers),
            observe(input.fetch, pages, path, probes.headers),
          ]);
          const differs = differences(onWorker, onPages);
          return { path, worker: onWorker, pages: onPages, differs };
        }),
      );
      const differ = results.filter((result) => result.differs.length > 0);
      differing += differ.length;
      for (const result of differ) {
        out(`${site} ${result.path}: ${result.differs.join(", ")} differ\n`);
      }
      return { site, worker, pages, unmatched: probes.unmatched, probes: results };
    }),
  );

  mkdirSync(dirname(outFile), { recursive: true });
  // Every object is built with its keys in one order, and every list sorted
  // (paths, headers), so the same answers write the same bytes.
  writeFileSync(outFile, `${JSON.stringify({ stack: stackKey, sites, differing }, null, 2)}\n`);
  if (staged.length === 0) {
    out(`No ${stackKey} site is staged; nothing to compare.\n`);
    return 0;
  }
  if (differing > 0) {
    out(
      `::warning::site-parity: ${differing} path${differing === 1 ? "" : "s"} answer differently on the staged Worker and on Pages; read the report before the site's flip.\n`,
    );
    return 1;
  }
  out(`Every path of the staged ${stackKey} sites answers as Pages does.\n`);
  return 0;
}

if (import.meta.main) {
  const code = await runSiteParity({
    args: process.argv.slice(2),
    root: process.cwd(),
    fetch,
    out: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
