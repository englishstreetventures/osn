#!/usr/bin/env bun
/**
 * Compare every route of the guest site as two uploads of one build serve it:
 * the Alchemy upload on dev, and Wrangler's own runtime serving the config
 * production deploys today.
 *
 * Phase P3 of the Alchemy rollout moves the guest Worker's production upload
 * from `wrangler deploy --config dist/server/wrangler.json` to the cire
 * stack. The build stays the same; what changes is how its modules, assets,
 * `_headers` and asset routing reach Cloudflare. This asks the dev guest host
 * (the stack's real upload of the build in `cire/invites/dist`) and
 * Wrangler's local runtime serving that same build's generated config for
 * every probe, and compares what they answer: the status, the headers in
 * COMPARED_HEADERS and, for a page, its landmarks (title, language, robots,
 * canonical and og:url, h1s, scripts, stylesheets, islands); for any other
 * body, its SHA-256.
 *
 * It refuses — exit 1, nothing compared as a match — when the build's own
 * route manifest holds a route no probe reaches, when the build does not call
 * PARITY_API_ORIGIN, when Cloudflare answers in the Worker's place on the dev
 * host (`judge()` in smoke-check.ts calls it `blocked`), when the seeded
 * wedding (`cire/db/seed/dev-seed.sql`) does not render on either side, when
 * the seeded probes ran and no call of the Wrangler side's Worker reached
 * cire-api, and when one of those calls did not get the answer cire-api gives
 * its probe (`expectedApiStatus()`): an invitation that never renders would
 * match itself everywhere and prove nothing. A probe that differs is asked
 * once more on both sides, and only a difference that holds is reported, so a
 * one-off blip in cire-api does not fail the run.
 *
 * Wrangler runs locally only, on Node, started by
 * scripts/guest-route-parity-reference.js through `unstable_startWorker`: the
 * Worker sees its own origin, its state and home are in a temporary
 * directory, no `.env` file is loaded, there is no Cloudflare credential and
 * no Access token in its environment, and telemetry is off. Its one write
 * under the build, `dist/server/.wrangler`, is removed on exit.
 *
 * Every call that Worker makes to PARITY_API_ORIGIN goes through a relay in
 * this process, on loopback, which sends it on with CI_USER_AGENT in place of
 * the Worker's user agent and records the answer; calls to any other origin
 * go out from the child unchanged. The relay serves only requests carrying
 * the run's random token, and never adds the Access token. The report's
 * `cireApi` holds every relayed call, whether the Worker's own request carried
 * a user agent, and a control pair: the seeded wedding asked of cire-api from
 * this process once with Bun's own user agent and once with CI_USER_AGENT,
 * which shows what the runner meets and never fails the run.
 *
 * Usage, from the repository root, after building cire/invites for the host:
 *
 *   PARITY_ORIGIN=https://invite.cire.<DEV_DOMAIN> \
 *   PARITY_API_ORIGIN=https://api.cire.<DEV_DOMAIN> \
 *     bun run scripts/guest-route-parity.ts --out <report.json>
 *
 * Environment:
 *   PARITY_ORIGIN       the guest site's origin on the tier the stack deployed:
 *                       https, or http on a loopback host; no path.
 *   PARITY_API_ORIGIN   the cire-api origin the build calls (its
 *                       PUBLIC_API_URL): https, or http on a loopback host;
 *                       no path.
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 *                       the Access service token, both or neither, sent only to
 *                       PARITY_ORIGIN.
 *
 * Every request this process sends to PARITY_ORIGIN and PARITY_API_ORIGIN
 * carries smoke-check's CI_USER_AGENT, the control pair's first request
 * aside: Cloudflare's Bot Fight Mode challenges Bun's own from a GitHub
 * runner.
 *
 * The report (`--out`) is the same for the same answers: sorted keys, no
 * port, no time, each side's own origin stripped from every value.
 *
 * Exit codes: 0 every probe matches; 1 a difference, or a run that refused or
 * could not finish; 2 a usage error, before anything starts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { RELAY_TOKEN_HEADER, WORKER_UA_HEADER } from "./guest-route-parity-reference.js";
import { CI_USER_AGENT, judge } from "./smoke-check";

/** Where a run finds the guest site, and the reference child, under a repository root. */
const pathsUnder = (root: string) => {
  const invites = join(root, "cire", "invites");
  return {
    invites,
    server: join(invites, "dist", "server"),
    client: join(invites, "dist", "client"),
    pages: join(invites, "src", "pages"),
    public: join(invites, "public"),
    child: join(root, "scripts", "guest-route-parity-reference.js"),
  };
};

/** The wedding `cire/db/seed/dev-seed.sql` seeds on every tier but production, and its invitation's hero title. */
export const GUEST_SEED = { slug: "cire-wedding", heroTitle: "Ada & Kit" } as const;

/** A slug no wedding has. */
export const UNKNOWN_SLUG = "route-parity-no-such-wedding";

/** The probes that must render the seeded wedding on both sides. */
export const SEEDED_PROBES: readonly string[] = [
  `/${GUEST_SEED.slug}`,
  `/${GUEST_SEED.slug}/registry`,
  `/cire/invite?slug=${GUEST_SEED.slug}`,
  `/cire/registry?slug=${GUEST_SEED.slug}`,
];

/**
 * The probes the slug route answers with a slug no wedding has: the unknown
 * slug, and the files `.assetsignore` keeps out of the upload, which fall
 * through to the route.
 */
export const UNKNOWN_SLUG_PROBES: readonly string[] = [
  `/${UNKNOWN_SLUG}`,
  "/wrangler.json",
  "/.dev.vars",
  "/.assetsignore",
];

/**
 * What cire-api answers each probe's page when the seed is in place: the
 * seeded wedding, and a 404 for a slug no wedding has
 * (cire/api/src/routes/invite.ts). Both routes need no auth, no `Origin` and
 * carry no rate limit.
 */
export function expectedApiStatus(probe: string): number | undefined {
  if (SEEDED_PROBES.includes(probe)) return 200;
  if (UNKNOWN_SLUG_PROBES.includes(probe)) return 404;
  return undefined;
}

/** The headers compared on every probe: what the Worker, `_headers` and the asset layer set. */
export const COMPARED_HEADERS: readonly string[] = [
  "cache-control",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-type",
  "location",
  "permissions-policy",
  "referrer-policy",
  "reporting-endpoints",
  "x-content-type-options",
  "x-frame-options",
  "x-robots-tag",
];

/**
 * A header value Wrangler's local runtime gives where Cloudflare's edge gives
 * another for the same upload. Each holds only on the paths it names, for
 * that exact local value against that exact edge value (absent when
 * `edgeValue` is undefined), and the report lists every use.
 */
export interface EmulationAllowance {
  readonly header: string;
  readonly paths: RegExp;
  readonly localValue: string;
  readonly edgeValue: string | undefined;
  readonly reason: string;
}

/** What the edge answers was read from production, a Wrangler upload, on 2026-10-23. */
const CHARSET_DROPPED =
  "Cloudflare's edge serves this static file type without the charset Wrangler's local asset server adds (production's guest site, a Wrangler upload, 2026-10-23)";

export const EMULATION_ALLOWANCES: readonly EmulationAllowance[] = [
  {
    header: "content-type",
    paths: /^\/(privacy|terms)\/$/,
    localValue: "text/html; charset=utf-8",
    edgeValue: "text/html",
    reason: CHARSET_DROPPED,
  },
  {
    header: "content-type",
    paths: /^\/_astro\/[^/]+\.css$/,
    localValue: "text/css; charset=utf-8",
    edgeValue: "text/css",
    reason: CHARSET_DROPPED,
  },
  {
    header: "content-type",
    paths: /^\/_astro\/[^/]+\.js$/,
    localValue: "text/javascript; charset=utf-8",
    edgeValue: "text/javascript",
    reason: CHARSET_DROPPED,
  },
  {
    header: "content-type",
    paths: /\.txt$/,
    localValue: "text/plain; charset=utf-8",
    edgeValue: "text/plain",
    reason:
      "Cloudflare's edge serves this static file type without the charset Wrangler's local asset server adds (production's guest site, a Wrangler upload, 2026-10-29)",
  },
];

/** What a page shows, compared in place of its full markup. */
export interface Landmarks {
  readonly title: string;
  readonly lang: string;
  readonly robots: string;
  readonly canonical: string;
  readonly ogUrl: string;
  readonly h1: readonly string[];
  readonly scripts: readonly string[];
  readonly stylesheets: readonly string[];
  readonly islands: readonly string[];
}

export interface Observation {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body:
    | { readonly kind: "none" }
    | { readonly kind: "html"; readonly landmarks: Landmarks }
    | { readonly kind: "bytes"; readonly sha256: string };
}

export interface ProbeResult {
  readonly path: string;
  readonly alchemy?: Observation;
  readonly wrangler?: Observation;
  readonly differences: readonly string[];
  /** Each emulation allowance that covered a difference here, with its reason. */
  readonly allowed: readonly string[];
}

/** One call the Wrangler side's Worker made to cire-api, as the relay sent it on. */
export interface RelayedCall {
  readonly method: string;
  /** The path and query, without the origin. */
  readonly path: string;
  /** cire-api's status; absent when it gave no answer. */
  readonly status?: number;
  /** Why Cloudflare answered in cire-api's place, when it did. */
  readonly blocked?: string;
  /** Why there was no answer, loopback ports removed. */
  readonly error?: string;
  /** Whether the Worker's own request carried a user agent before the relay set CI_USER_AGENT. */
  readonly workerUserAgent: "present" | "absent";
}

/** A relayed call, with the probe it was made for and the status cire-api should have given it. */
export interface RelayedRecord extends RelayedCall {
  readonly probe: string;
  readonly expected?: number;
}

/** One of the control pair: the seeded wedding asked of cire-api from this process. */
export interface ControlCall {
  /** `Bun's own`, or the user agent sent. */
  readonly userAgent: string;
  readonly status?: number;
  readonly blocked?: string;
  readonly error?: string;
}

export interface Report {
  readonly alchemy: string;
  readonly reference: string;
  readonly routes: readonly string[];
  readonly probes: readonly ProbeResult[];
  readonly cireApi: {
    readonly control: readonly ControlCall[];
    readonly relayed: readonly RelayedRecord[];
  };
  readonly refusals: readonly string[];
  readonly result: "match" | "differ" | "refused";
}

// ── routes and probes ──────────────────────────────────────────────────────

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
}

/** Every route the build's own manifest lists: each `"route":"…"` in its server scripts. */
export function routesInBuild(serverDir: string): readonly string[] {
  const routes = new Set<string>();
  for (const file of filesUnder(serverDir)) {
    if (!/\.m?js$/.test(file)) continue;
    const text = readFileSync(join(serverDir, file), "utf8");
    for (const match of text.matchAll(/"route":"([^"]+)"/g)) routes.add(match[1]!);
  }
  return [...routes].toSorted();
}

/** The route each page file under `pagesDir` defines, as Astro writes it in its manifest. */
export function routesFromPages(pagesDir: string): readonly string[] {
  return filesUnder(pagesDir)
    .filter((file) => /\.(astro|md|mdx|html|js|ts)$/.test(file))
    .map((file) => {
      const path = file.replace(/\.[^.]+$/, "").replace(/(^|\/)index$/, "");
      return `/${path}`;
    })
    .toSorted();
}

const segments = (path: string): string[] =>
  path
    .split("?")[0]!
    .split("/")
    .filter((segment) => segment !== "");

/**
 * The route Astro answers `path` with: the route whose segments all match,
 * a static segment before a `[param]` one, as Astro ranks them. Undefined
 * when none matches, as for a file the asset layer serves.
 */
export function routeFor(path: string, routes: readonly string[]): string | undefined {
  const wanted = segments(path);
  const matching = routes.filter((route) => {
    const parts = segments(route);
    return (
      parts.length === wanted.length &&
      parts.every((part, i) => /^\[[^\]]+\]$/.test(part) || part === wanted[i])
    );
  });
  const staticCount = (route: string) =>
    segments(route).filter((part) => !/^\[[^\]]+\]$/.test(part)).length;
  return matching.toSorted((a, b) => staticCount(b) - staticCount(a))[0];
}

/** The routes no probe reaches. */
export function uncoveredRoutes(
  routes: readonly string[],
  probes: readonly string[],
): readonly string[] {
  const reached = new Set(probes.map((probe) => routeFor(probe, routes)));
  return routes.filter((route) => !reached.has(route));
}

/** The files of a build's asset directory the upload reads and never serves. */
const PLATFORM_FILES: ReadonlySet<string> = new Set(["_headers", "_redirects", ".assetsignore"]);

/**
 * Whether `.assetsignore` under `clientDir` keeps a file out of the upload,
 * read as gitignore patterns: `*`, `**` and `?`; a trailing `/` for a
 * directory; a leading or inner `/` anchoring the pattern to the directory.
 * A `!` line is skipped, so a file it would bring back stays out.
 */
function assetsIgnored(clientDir: string): (file: string) => boolean {
  const at = join(clientDir, ".assetsignore");
  const lines = existsSync(at) ? readFileSync(at, "utf8").split("\n") : [];
  const patterns = lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => {
      const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
      const anchored = line.startsWith("/") || body.includes("/");
      const glob = body
        .split(/(\*\*|\*|\?)/)
        .map((part) =>
          part === "**"
            ? ".*"
            : part === "*"
              ? "[^/]*"
              : part === "?"
                ? "[^/]"
                : part.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return new RegExp(anchored ? `^${glob}$` : `(^|/)${glob}$`);
    });
  return (file) => {
    const parts = file.split("/");
    return parts.some((_, i) => {
      const prefix = parts.slice(0, i + 1).join("/");
      return patterns.some((pattern) => pattern.test(prefix));
    });
  };
}

/** What the asset layer picks a file's content type by: its name after the last dot, if any. */
function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The first file under `clientDir` of each extension, by name, so every
 * content type the build's uploads carry is asked once. Never the platform's
 * own files or one `.assetsignore` keeps out: probePaths() asks those by name.
 */
export function assetProbes(clientDir: string): readonly string[] {
  const ignored = assetsIgnored(clientDir);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const file of filesUnder(clientDir)) {
    const extension = extensionOf(file);
    if (PLATFORM_FILES.has(file) || ignored(file) || seen.has(extension)) continue;
    seen.add(extension);
    picked.push(`/${file}`);
  }
  return picked;
}

/** Every path the comparison asks both sides for, each once. */
export function probePaths(clientDir: string, publicDir: string): readonly string[] {
  return [
    ...new Set([
      "/",
      ...SEEDED_PROBES,
      "/cire/invite",
      "/cire/registry",
      `/${UNKNOWN_SLUG}`,
      "/privacy",
      "/privacy/",
      "/privacy/index.html",
      "/terms",
      "/terms/",
      "/_image",
      "/_server-islands/route-parity-missing",
      ...filesUnder(publicDir).map((file) => `/${file}`),
      "/wrangler.json",
      "/.dev.vars",
      "/.assetsignore",
      "/_astro/route-parity-missing.js",
      ...assetProbes(clientDir),
    ]),
  ];
}

// ── observing an answer ────────────────────────────────────────────────────

/** `value` with every occurrence of the answering side's own origin removed. */
const withoutOrigin = (value: string, ownOrigin: string): string => value.replaceAll(ownOrigin, "");

const collapse = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

const NAMED = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** `text` with its character references decoded; `HTMLRewriter` hands both text and attributes over raw. */
const decode = (text: string): string =>
  text.replaceAll(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return NAMED.get(name.toLowerCase()) ?? whole;
  });

/** The landmarks of `html`, each value without `ownOrigin`. */
export async function landmarks(html: string, ownOrigin: string): Promise<Landmarks> {
  let title = "";
  let inTitle = false;
  let lang = "";
  let robots = "";
  let canonical = "";
  let ogUrl = "";
  const h1: string[] = [];
  let current: string | undefined;
  const scripts = new Set<string>();
  const stylesheets = new Set<string>();
  const islands = new Set<string>();
  await new HTMLRewriter()
    .on("html", {
      element(element) {
        lang = element.getAttribute("lang") ?? "";
      },
    })
    .on("title", {
      element(element) {
        if (title !== "") return;
        inTitle = true;
        element.onEndTag(() => {
          inTitle = false;
        });
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
      },
    })
    .on('meta[name="robots"]', {
      element(element) {
        robots = element.getAttribute("content") ?? "";
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        canonical = element.getAttribute("href") ?? "";
      },
    })
    .on('meta[property="og:url"]', {
      element(element) {
        ogUrl = element.getAttribute("content") ?? "";
      },
    })
    .on("h1", {
      element(element) {
        current = "";
        element.onEndTag(() => {
          h1.push(collapse(current ?? ""));
          current = undefined;
        });
      },
      text(chunk) {
        if (current !== undefined) current += chunk.text;
      },
    })
    .on("script[src]", {
      element(element) {
        scripts.add(element.getAttribute("src") ?? "");
      },
    })
    .on('link[rel="stylesheet"]', {
      element(element) {
        stylesheets.add(element.getAttribute("href") ?? "");
      },
    })
    .on("astro-island", {
      element(element) {
        islands.add(element.getAttribute("component-url") ?? "");
      },
    })
    .transform(new Response(html))
    .text();
  const clean = (value: string) => withoutOrigin(decode(value), ownOrigin);
  const sorted = (values: Set<string>) => [...values].map(clean).toSorted();
  return {
    title: clean(collapse(title)),
    lang: decode(lang),
    robots: decode(robots),
    canonical: clean(canonical),
    ogUrl: clean(ogUrl),
    h1: h1.map(clean),
    scripts: sorted(scripts),
    stylesheets: sorted(stylesheets),
    islands: sorted(islands),
  };
}

/** What one answer shows, every value without the answering side's own origin. */
export async function observe(response: Response, ownOrigin: string): Promise<Observation> {
  const headers: Record<string, string> = {};
  for (const name of COMPARED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = withoutOrigin(value, ownOrigin);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, headers, body: { kind: "none" } };
  }
  if ((response.headers.get("content-type") ?? "").startsWith("text/html")) {
    const html = new TextDecoder().decode(bytes);
    return {
      status: response.status,
      headers,
      body: { kind: "html", landmarks: await landmarks(html, ownOrigin) },
    };
  }
  return {
    status: response.status,
    headers,
    body: { kind: "bytes", sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

/**
 * Why Cloudflare answered in the Worker's place, or undefined when the Worker
 * answered. `access` marks a host behind Cloudflare Access, as the dev guest
 * host is and cire-api is not.
 */
export function blockedReason(
  url: string,
  response: Response,
  body: string,
  access = true,
): string | undefined {
  const outcome = judge({ url, expects: { kind: "page" } }, response, body, access);
  return outcome.kind === "blocked" ? outcome.reason : undefined;
}

/** Whether `observation` is the seeded wedding's invitation or gift list, rendered. */
export function seedRendered(observation: Observation | undefined): boolean {
  return (
    observation?.status === 200 &&
    observation.body.kind === "html" &&
    observation.body.landmarks.title.includes(GUEST_SEED.heroTitle)
  );
}

// ── the relay to cire-api ──────────────────────────────────────────────────

/** A function shaped like `fetch`, for the relay's requests to cire-api. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The headers that belong to one connection and are never passed on. */
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding"] as const;

/** The statuses whose response carries no body. */
const NULL_BODY: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** `text` with every loopback port removed, so a report names no port of this run. */
const withoutLoopbackPorts = (text: string): string =>
  text.replaceAll(/(127\.0\.0\.1|localhost|\[::1\]):\d+/g, "$1");

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/**
 * Sends one call the Wrangler side's Worker made to cire-api on to
 * `apiOrigin`, the path and query kept, and records what cire-api answered.
 * The call goes out with CI_USER_AGENT in place of any user agent the Worker
 * set, and without the child's two headers, `CF-Worker` (which would name a
 * loopback host) or the Worker's `Host`; a body goes as bytes, so the request
 * never carries both a length and chunked framing. A redirect is handed back,
 * not followed. The answer reaches the Worker decoded, so it carries no
 * `content-encoding`, no `content-length` and no hop-by-hop header. No answer
 * is a 502 to the Worker, tried once.
 */
export async function relayRequest(
  request: Request,
  apiOrigin: string,
  fetchImpl: FetchLike,
  record: (call: RelayedCall) => void,
): Promise<Response> {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const target = `${apiOrigin}${path}`;
  const { method } = request;
  const workerUserAgent =
    request.headers.get(WORKER_UA_HEADER) === "present" ? "present" : "absent";
  const headers = new Headers(request.headers);
  for (const name of [
    WORKER_UA_HEADER,
    RELAY_TOKEN_HEADER,
    "cf-worker",
    "host",
    "content-length",
    ...HOP_BY_HOP,
  ]) {
    headers.delete(name);
  }
  headers.set("user-agent", CI_USER_AGENT);
  let response: Response;
  let bytes: ArrayBuffer;
  try {
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    response = await fetchImpl(target, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    bytes = await response.arrayBuffer();
  } catch (error) {
    record({ method, path, error: withoutLoopbackPorts(messageOf(error)), workerUserAgent });
    return new Response("cire-api gave the relay no answer", {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
  record({
    method,
    path,
    status: response.status,
    blocked: blockedReason(target, response, "", false),
    workerUserAgent,
  });
  const back = new Headers(response.headers);
  for (const name of ["content-encoding", "content-length", ...HOP_BY_HOP]) back.delete(name);
  return new Response(NULL_BODY.has(response.status) ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: back,
  });
}

/** Whether `given` is the run's relay token, compared in constant time. */
function isToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A running relay: the loopback port it listens on, and how to stop it. */
export interface Relay {
  readonly port: number;
  readonly stop: () => void;
}

/**
 * The relay, on a loopback port of its own: each request carrying `token` in
 * RELAY_TOKEN_HEADER goes to relayRequest(), any other is refused 403 and
 * sends nothing on, so no other process on the runner can use it.
 */
export function startRelay(
  apiOrigin: string,
  token: string,
  fetchImpl: FetchLike,
  record: (call: RelayedCall) => void,
): Relay {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Above REQUEST_MS, so a call cire-api is still answering is never cut.
    idleTimeout: 30,
    fetch: (request) =>
      isToken(request.headers.get(RELAY_TOKEN_HEADER), token)
        ? relayRequest(request, apiOrigin, fetchImpl, record)
        : new Response("not the run's relay token", {
            status: 403,
            headers: { "content-type": "text/plain" },
          }),
  });
  return { port: server.port ?? 0, stop: () => void server.stop(true) };
}

/** One refusal for each relayed call whose answer was not the one cire-api gives its probe. */
export function relayRefusals(relayed: readonly RelayedRecord[]): readonly string[] {
  return relayed.flatMap((call) => {
    if (call.expected === undefined || call.status === call.expected) return [];
    if (call.error !== undefined) {
      return [
        `${call.probe}: cire-api gave the Wrangler side's ${call.method} ${call.path} no answer (${call.error}); expected ${call.expected}.`,
      ];
    }
    const blocked = call.blocked === undefined ? "" : ` (${call.blocked})`;
    return [
      `${call.probe}: cire-api answered the Wrangler side ${call.status}${blocked} for ${call.method} ${call.path}; expected ${call.expected}.`,
    ];
  });
}

/** What cire-api answered the relay for `probe`, for the seeded refusal. */
function relayedAnswers(relayed: readonly RelayedRecord[], probe: string): string {
  const answers = relayed
    .filter((call) => call.probe === probe)
    .map((call) =>
      call.error === undefined
        ? `${call.status}${call.blocked === undefined ? "" : ` (${call.blocked})`}`
        : `no answer (${call.error})`,
    );
  return answers.length === 0 ? "no call" : answers.join(", ");
}

/**
 * The control pair: the seeded wedding asked of cire-api from this process,
 * once with Bun's own user agent and once with CI_USER_AGENT. It shows what
 * the runner meets, and never fails the run.
 */
async function controlPair(apiOrigin: string, deadline: number): Promise<ControlCall[]> {
  const url = `${apiOrigin}/api/invite/${GUEST_SEED.slug}`;
  const one = async (
    userAgent: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<ControlCall> => {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(Math.min(REQUEST_MS, remaining(deadline))),
      });
      await response.arrayBuffer();
      return {
        userAgent,
        status: response.status,
        blocked: blockedReason(url, response, "", false),
      };
    } catch (error) {
      return { userAgent, error: withoutLoopbackPorts(messageOf(error)) };
    }
  };
  // One after the other: cire-api sees two requests, not a burst.
  const own = await one("Bun's own", {});
  const ci = await one(CI_USER_AGENT, { "user-agent": CI_USER_AGENT });
  return [own, ci];
}

/** Whether the build's server output calls `apiOrigin`: the Worker's cire-api origin is a literal in it. */
function buildCalls(serverDir: string, apiOrigin: string): boolean {
  return filesUnder(serverDir)
    .filter((file) => /\.m?js$/.test(file))
    .some((file) => readFileSync(join(serverDir, file), "utf8").includes(apiOrigin));
}

// ── comparing ──────────────────────────────────────────────────────────────

const allowanceFor = (
  path: string,
  header: string,
  alchemy: string | undefined,
  local: string | undefined,
): EmulationAllowance | undefined =>
  EMULATION_ALLOWANCES.find(
    (allowance) =>
      allowance.header === header &&
      allowance.paths.test(path.split("?")[0]!) &&
      allowance.localValue === local &&
      allowance.edgeValue === alchemy,
  );

/** The emulation allowances that cover a header difference on `path`, as report lines. */
export function allowancesUsed(
  path: string,
  alchemy: Observation,
  wrangler: Observation,
): readonly string[] {
  return COMPARED_HEADERS.flatMap((header) => {
    const a = alchemy.headers[header];
    const w = wrangler.headers[header];
    const allowance = a === w ? undefined : allowanceFor(path, header, a, w);
    return allowance === undefined ? [] : [`${header}: ${allowance.reason}`];
  });
}

/** Each way the two answers to `path` differ, as one line each; empty when they match. */
export function compare(
  path: string,
  alchemy: Observation,
  wrangler: Observation,
): readonly string[] {
  const differences: string[] = [];
  if (alchemy.status !== wrangler.status) {
    differences.push(
      `status: ${alchemy.status} on the Alchemy upload, ${wrangler.status} on Wrangler`,
    );
  }
  for (const header of COMPARED_HEADERS) {
    const a = alchemy.headers[header];
    const w = wrangler.headers[header];
    if (a === w || allowanceFor(path, header, a, w) !== undefined) continue;
    differences.push(
      `${header}: ${a ?? "(none)"} on the Alchemy upload, ${w ?? "(none)"} on Wrangler`,
    );
  }
  const a = alchemy.body;
  const w = wrangler.body;
  if (a.kind !== w.kind) {
    differences.push(`body: ${a.kind} on the Alchemy upload, ${w.kind} on Wrangler`);
  } else if (a.kind === "bytes" && w.kind === "bytes" && a.sha256 !== w.sha256) {
    differences.push(`body: sha256 ${a.sha256} on the Alchemy upload, ${w.sha256} on Wrangler`);
  } else if (a.kind === "html" && w.kind === "html") {
    for (const key of Object.keys(a.landmarks) as (keyof Landmarks)[]) {
      const left = JSON.stringify(a.landmarks[key]);
      const right = JSON.stringify(w.landmarks[key]);
      if (left !== right) {
        differences.push(`page ${key}: ${left} on the Alchemy upload, ${right} on Wrangler`);
      }
    }
  }
  return differences;
}

/** The report as written: every object's keys sorted, probes in the order asked. */
export function renderReport(report: Report): string {
  const json = JSON.stringify(
    report,
    (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : value,
    2,
  );
  return `${json}\n`;
}

/** The environment the reference child, and the Wrangler it starts, run with. */
export type ReferenceEnv = {
  readonly PATH?: string;
  readonly TMPDIR?: string;
  readonly HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly DO_NOT_TRACK: "1";
  readonly WRANGLER_SEND_METRICS: "false";
  /** The run's relay token: the relay serves no request without it. Not a Cloudflare credential. */
  readonly PARITY_RELAY_TOKEN: string;
};

/**
 * What the reference needs to start, telemetry off, the run's relay token,
 * and nothing else from `env`. Its home is `home`, an empty directory of the
 * run's own, so it finds no `wrangler login` token or other configuration
 * there either.
 */
export function referenceEnv(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  relayToken: string,
): ReferenceEnv {
  const kept = (name: "PATH" | "TMPDIR") => {
    const value = env[name];
    return value === undefined || value === "" ? {} : { [name]: value };
  };
  return {
    ...kept("PATH"),
    ...kept("TMPDIR"),
    HOME: home,
    XDG_CONFIG_HOME: home,
    DO_NOT_TRACK: "1",
    WRANGLER_SEND_METRICS: "false",
    PARITY_RELAY_TOKEN: relayToken,
  };
}

// ── the run ────────────────────────────────────────────────────────────────

/** What a run reads and how long it may take. */
export interface RunContext {
  /** The repository root: the build, its pages and wrangler are found under it. */
  readonly root: string;
  /** The run's whole budget. */
  readonly deadlineMs: number;
  /** How long the reference has to serve the build. */
  readonly readyMs: number;
}

/** This repository, and a budget under the five minutes the workflow step allows. */
export const RUN_CONTEXT: RunContext = {
  root: join(import.meta.dir, ".."),
  deadlineMs: 240_000,
  readyMs: 60_000,
};

const REQUEST_MS = 15_000;

class UsageError extends Error {}

export interface Options {
  readonly origin: string;
  /** The cire-api origin the build calls; the relay sends the Wrangler side's calls there. */
  readonly apiOrigin: string;
  readonly access: Readonly<Record<string, string>>;
  readonly out: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `env[name]` as an origin: https, or http on a loopback host, with nothing after the host. */
function originFrom(
  env: Readonly<Record<string, string | undefined>>,
  name: "PARITY_ORIGIN" | "PARITY_API_ORIGIN",
  what: string,
): string {
  const raw = env[name] ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`${name} must be ${what}; got '${raw}'.`);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure || url.origin !== raw) {
    throw new UsageError(
      `${name} must be an https origin (http only on a loopback host) with nothing after the host; got '${raw}'.`,
    );
  }
  return url.origin;
}

function parse(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): Options {
  const at = args.indexOf("--out");
  const out = at === -1 ? undefined : args[at + 1];
  if (out === undefined || out === "" || args.length !== 2) {
    throw new UsageError("usage: guest-route-parity.ts --out <report.json>");
  }
  const origin = originFrom(env, "PARITY_ORIGIN", "the guest site's origin");
  const apiOrigin = originFrom(env, "PARITY_API_ORIGIN", "the cire-api origin the build calls");
  const id = env.CF_ACCESS_CLIENT_ID ?? "";
  const secret = env.CF_ACCESS_CLIENT_SECRET ?? "";
  if ((id === "") !== (secret === "")) {
    throw new UsageError(
      "Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET together, or neither.",
    );
  }
  const paths = pathsUnder(root);
  if (!existsSync(join(paths.server, "wrangler.json")) || !existsSync(paths.client)) {
    throw new UsageError(
      "cire/invites/dist holds no build with its generated dist/server/wrangler.json; build cire/invites first.",
    );
  }
  const access: Record<string, string> =
    id === "" ? {} : { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  return { origin, apiOrigin, access, out };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

const remaining = (deadline: number) => Math.max(0, deadline - Date.now());

/** One answer, tried again once after a network error. */
async function ask(
  url: string,
  headers: Readonly<Record<string, string>>,
  deadline: number,
): Promise<Response> {
  const once = () =>
    fetch(url, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(Math.min(REQUEST_MS, remaining(deadline))),
    });
  try {
    return await once();
  } catch {
    return await once();
  }
}

interface Side {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Only the dev host can be answered by Cloudflare in the Worker's place. */
  readonly edge: boolean;
}

type Seen = { readonly observation: Observation } | { readonly failure: string };

async function look(side: Side, path: string, deadline: number): Promise<Seen> {
  const url = `${side.origin}${path}`;
  try {
    const response = await ask(url, side.headers, deadline);
    if (side.edge) {
      // Only the status and headers decide it; the body stays unread for observe().
      const reason = blockedReason(url, response, "");
      if (reason !== undefined) return { failure: `${path}: ${reason}` };
    }
    return { observation: await observe(response, side.origin) };
  } catch (error) {
    return {
      failure: `${path}: no answer from ${side.edge ? "the Alchemy upload" : "Wrangler"} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

interface Reference {
  readonly origin: string;
  readonly stop: () => void;
}

/** Whether `url` answers 200 yet. */
async function serves(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

type Pair = readonly [Seen, Seen];

/** Whether either side failed, or the two answers differ. */
function differs(path: string, [a, w]: Pair): boolean {
  if ("failure" in a || "failure" in w) return true;
  return compare(path, a.observation, w.observation).length > 0;
}

/** Both sides' answers to `path`, asked again once when they differ. */
async function settle(
  path: string,
  alchemy: Side,
  wrangler: Side,
  deadline: number,
): Promise<Pair> {
  const askBoth = () =>
    Promise.all([look(alchemy, path, deadline), look(wrangler, path, deadline)] as const);
  const first = await askBoth();
  return differs(path, first) && remaining(deadline) > 0 ? askBoth() : first;
}

/** The relay the reference sends its cire-api calls to, and what it takes to use it. */
interface RelayHandle {
  readonly port: number;
  readonly token: string;
  readonly apiOrigin: string;
}

/**
 * Wrangler's runtime serving the build's generated config, started on Node by
 * the reference child and answering, or a refusal. The child gets only ports,
 * paths and the cire-api origin as arguments, and referenceEnv() as its
 * environment.
 */
async function startReference(
  context: RunContext,
  deadline: number,
  relay: RelayHandle,
): Promise<Reference | { readonly failure: string }> {
  const paths = pathsUnder(context.root);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // The run's own directory: wrangler's state, its home, and the one env
  // file it is pointed at, which is empty, so it loads no `.env`,
  // `.env.local` or `.dev.vars` from the build or the package. (A path that
  // does not exist stops wrangler before it starts.)
  const scratch = mkdtempSync(join(tmpdir(), "guest-route-parity-"));
  const persist = join(scratch, "state");
  const home = join(scratch, "home");
  const envFile = join(scratch, "empty.env");
  mkdirSync(home);
  writeFileSync(envFile, "");
  const leftover = join(paths.server, ".wrangler");
  const hadLeftover = existsSync(leftover);
  const log: string[] = [];
  let exited: number | null | undefined;
  const child: ChildProcess = spawn(
    "node",
    [
      paths.child,
      "--config",
      "dist/server/wrangler.json",
      "--port",
      String(port),
      "--relay-port",
      String(relay.port),
      "--api-origin",
      relay.apiOrigin,
      "--persist",
      persist,
      "--env-file",
      envFile,
    ],
    {
      cwd: paths.invites,
      env: referenceEnv(process.env, home, relay.token),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const keep = (chunk: Buffer) => log.push(...chunk.toString().split("\n").filter(Boolean));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code) => {
    exited = code;
  });
  child.on("error", (error) => {
    log.push(error.message);
    exited = -1;
  });
  const stop = () => {
    if (child.pid !== undefined && exited === undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(scratch, { recursive: true, force: true });
    if (!hadLeftover) rmSync(leftover, { recursive: true, force: true });
  };
  const readyBy = Math.min(deadline, Date.now() + context.readyMs);
  while (Date.now() < readyBy) {
    if (exited !== undefined) {
      stop();
      return {
        failure: `the reference exited (${exited}) before it served the build: ${withoutLoopbackPorts(log.slice(-5).join(" | "))}`,
      };
    }
    // Polled one try at a time: each waits out the last and a short pause.
    // eslint-disable-next-line no-await-in-loop
    const [ready] = await Promise.all([serves(`${origin}/robots.txt`), Bun.sleep(250)]);
    if (ready) return { origin, stop };
  }
  stop();
  return {
    failure: `the reference did not serve the build within ${context.readyMs / 1000} s: ${withoutLoopbackPorts(log.slice(-5).join(" | "))}`,
  };
}

/** Compares every probe on both sides of `options` and returns the report, whatever happens. */
export async function run(options: Options, context: RunContext): Promise<Report> {
  const paths = pathsUnder(context.root);
  const deadline = Date.now() + context.deadlineMs;
  const routes = routesInBuild(paths.server);
  const probes = probePaths(paths.client, paths.public);
  const control: ControlCall[] = [];
  const relayed: RelayedRecord[] = [];
  const base = {
    alchemy: `${options.origin} (the Alchemy upload)`,
    reference:
      "unstable_startWorker of cire/invites/dist/server/wrangler.json on Node (scripts/guest-route-parity-reference.js)",
    routes,
    cireApi: { control, relayed },
  };
  const refusals: string[] = [];
  if (routes.length === 0) {
    refusals.push(
      "The build's server output lists no route; the route manifest could not be read.",
    );
  }
  for (const route of routesFromPages(paths.pages)) {
    if (!routes.includes(route)) {
      refusals.push(`The page route ${route} is not in the build's route manifest.`);
    }
  }
  for (const route of uncoveredRoutes(routes, probes)) {
    refusals.push(`No probe reaches the route ${route}; add one to probePaths().`);
  }
  if (!buildCalls(paths.server, options.apiOrigin)) {
    refusals.push(
      `The build in cire/invites/dist/server does not hold PARITY_API_ORIGIN (${options.apiOrigin}); build it with PUBLIC_API_URL set to the origin the relay serves.`,
    );
  }
  if (refusals.length > 0) return { ...base, probes: [], refusals, result: "refused" };

  control.push(...(await controlPair(options.apiOrigin, deadline)));
  // The probe being asked, so each relayed call is recorded against the page that made it.
  let current = "(before the first probe)";
  const token = randomBytes(32).toString("hex");
  const relay = startRelay(options.apiOrigin, token, fetch, (call) => {
    relayed.push({ probe: current, expected: expectedApiStatus(current), ...call });
  });
  const reference = await startReference(context, deadline, {
    port: relay.port,
    token,
    apiOrigin: options.apiOrigin,
  });
  if ("failure" in reference) {
    relay.stop();
    return { ...base, probes: [], refusals: [reference.failure], result: "refused" };
  }
  const stopAll = () => {
    reference.stop();
    relay.stop();
  };
  const stopOnSignal = () => {
    stopAll();
    process.exit(1);
  };
  process.once("SIGTERM", stopOnSignal);
  process.once("SIGINT", stopOnSignal);
  try {
    const alchemy: Side = {
      origin: options.origin,
      headers: { "user-agent": CI_USER_AGENT, ...options.access },
      edge: true,
    };
    const wrangler: Side = { origin: reference.origin, headers: {}, edge: false };
    const results: ProbeResult[] = [];
    for (const path of probes) {
      if (remaining(deadline) === 0) {
        refusals.push(`The run passed its ${context.deadlineMs / 1000} s deadline before ${path}.`);
        break;
      }
      // One probe at a time: the dev host and cire-api see a trickle, not a
      // burst, the deadline can stop the run between probes, and every call
      // the relay sees belongs to this probe.
      current = path;
      // eslint-disable-next-line no-await-in-loop
      const [a, w] = await settle(path, alchemy, wrangler, deadline);
      for (const one of [a, w]) if ("failure" in one) refusals.push(one.failure);
      const alchemyObservation = "observation" in a ? a.observation : undefined;
      const wranglerObservation = "observation" in w ? w.observation : undefined;
      const both = alchemyObservation !== undefined && wranglerObservation !== undefined;
      results.push({
        path,
        alchemy: alchemyObservation,
        wrangler: wranglerObservation,
        differences: both ? compare(path, alchemyObservation, wranglerObservation) : [],
        allowed: both ? allowancesUsed(path, alchemyObservation, wranglerObservation) : [],
      });
    }
    current = "(after the last probe)";
    for (const path of SEEDED_PROBES) {
      const result = results.find((one) => one.path === path);
      for (const [side, observation, answered] of [
        ["the Alchemy upload", result?.alchemy, ""],
        [
          "Wrangler",
          result?.wrangler,
          ` (cire-api through the relay: ${relayedAnswers(relayed, path)})`,
        ],
      ] as const) {
        if (!seedRendered(observation)) {
          refusals.push(
            `${path}: the seeded wedding (title holding '${GUEST_SEED.heroTitle}') did not render on ${side}${answered}; re-seed it or check cire-api.`,
          );
        }
      }
    }
    const seededRan = results.some(
      (one) => SEEDED_PROBES.includes(one.path) && one.wrangler !== undefined,
    );
    if (seededRan && relayed.length === 0) {
      refusals.push(
        "The seeded probes ran, and no call from the Wrangler side reached cire-api through the relay: the Worker called no PARITY_API_ORIGIN, or the reference did not route its calls.",
      );
    }
    refusals.push(...relayRefusals(relayed));
    const differ = results.some((one) => one.differences.length > 0);
    return {
      ...base,
      probes: results,
      refusals,
      result: refusals.length > 0 ? "refused" : differ ? "differ" : "match",
    };
  } finally {
    process.off("SIGTERM", stopOnSignal);
    process.off("SIGINT", stopOnSignal);
    stopAll();
  }
}

if (import.meta.main) {
  let options: Options;
  try {
    options = parse(process.argv.slice(2), process.env, RUN_CONTEXT.root);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stdout.write(`::error::${error.message}\n`);
    process.exit(2);
  }
  const report = await run(options, RUN_CONTEXT);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, renderReport(report));
  const lines = [
    ...report.refusals.map((refusal) => `::error::${refusal}`),
    ...report.probes.flatMap((probe) =>
      probe.differences.map((difference) => `::error::${probe.path} ${difference}`),
    ),
    `guest route parity: ${report.result}, ${report.probes.length} probes, ${report.routes.length} routes; report at ${options.out}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(report.result === "match" ? 0 : 1);
}
