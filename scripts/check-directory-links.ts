#!/usr/bin/env bun
/**
 * CI guard: no cire site links a directory page without its trailing slash.
 *
 * Every cire site page is built as `<dir>/index.html` (Astro's default
 * `build.format: "directory"`), and Cloudflare's asset server, set to
 * `htmlHandling: "auto-trailing-slash"` (`cire/infra/src/declaration.ts`),
 * answers the slash-less address `/<dir>` with a 307 to `/<dir>/`. Pages
 * answers it with a 308. A link that names `/privacy` therefore costs every
 * click a redirect, and tells a search engine the address is a temporary one.
 * The owner accepted the 307 for addresses typed or linked from elsewhere, on
 * the condition that cire's own links use the slash form
 * (englishstreetventures/osn#1988). This guard holds them there.
 *
 * It reads what the builds wrote, not the source:
 *
 *   - the directory pages: every `index.html` under each site's page
 *     directory but a root one, as `/<dir>`. The union of all four sites, so
 *     the organiser portal's link to the marketing site's `/privacy` is read
 *     against the marketing site's pages;
 *   - the links: every `.html`, `.js` and `.mjs` file in each site's scan
 *     directories, read for a string naming one of those pages without its
 *     slash (`directoryLinks` below). HTML is read with its entity-quoted
 *     attribute values (an island's props) decoded first.
 *
 * The guest site's Worker renders its own pages, so its scan takes in the
 * server's component chunks as well as `dist/client`. Not `dist/server/entry.mjs`:
 * that file holds Astro's route manifest, which names every route by its
 * slash-less path and links nothing.
 *
 * A site that fails to build, a directory that is missing, a page directory
 * with no page in it, and a site in which the scan finds no link to any
 * directory page in the slash form are each a finding, never a pass. The last
 * of those is the guard checking itself: every cire site links at least one
 * of its own pages, so a scan that finds none has stopped reading the build.
 *
 * Run from the repository root after `bun run build` (`.github/workflows/ci.yml`,
 * job `build-test`). With arguments, it checks each named directory instead,
 * as both its pages and its scan.
 */

import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Glob } from "bun";

/** One built site: where its pages are, and which directories to read for links. */
export type Site = {
  readonly name: string;
  readonly pages: string;
  readonly scan: readonly string[];
};

export type Finding = {
  readonly site: string;
  /** The problem in a sentence, for a finding about the build rather than a link. */
  readonly problem: string;
  /** The file holding the link, relative to the scan directory. */
  readonly file?: string;
  /** The same file's full path. */
  readonly path?: string;
  /** The slash-less address it links. */
  readonly address?: string;
};

export type Report = {
  readonly site: string;
  readonly pages: number;
  readonly files: number;
  readonly slashForm: number;
};

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The four cire sites, as `bun run build` leaves them. */
export const CIRE_SITES: readonly Site[] = [
  { name: "cire/landing", pages: "cire/landing/dist", scan: ["cire/landing/dist"] },
  { name: "cire/host", pages: "cire/host/dist", scan: ["cire/host/dist"] },
  { name: "cire/vendor", pages: "cire/vendor/dist", scan: ["cire/vendor/dist"] },
  {
    name: "cire/invites",
    pages: "cire/invites/dist/client",
    scan: ["cire/invites/dist/client", "cire/invites/dist/server/chunks"],
  },
].map((site) => ({
  name: site.name,
  pages: join(REPO_ROOT, site.pages),
  scan: site.scan.map((dir) => join(REPO_ROOT, dir)),
}));

/**
 * A string that may be a link: opened by a quote or backtick, or by an
 * unquoted `href=` (Solid's templates drop attribute quotes). Then one of
 *
 *   - a leading `${…}` in a template literal, an origin held in a variable;
 *   - an origin written out, `https://host` or `//host`;
 *   - nothing, a root-relative path;
 *
 * then the path, which runs to a quote, `?`, `#`, an interpolation (`$`), an
 * escaped quote (`\`), whitespace, `>` or the end. A `${…}` in the middle of a
 * template (`${api}/items/${id}/claim`) is never a prefix: the match has to
 * start at the opening quote.
 */
const LINK =
  /(?:["'`]|\bhref=)(?:(\$\{[^{}`]*\})|(?:https?:)?\/\/([A-Za-z0-9.-]+)(?::\d+)?)?(\/(?!\/)[A-Za-z0-9._~%/-]*)(?=["'`?#$\\\s>]|$)/g;

/**
 * Whether an origin written out is one of cire's: the production domain and
 * its subdomains, and the local ones a build without its `PUBLIC_*` URLs
 * falls back to (`localhost` on any port, portless' `*.cire.localhost`).
 * Every other host's pages are that host's business. A `${…}` prefix is taken
 * as cire's too, so a link to another local service's page of the same name
 * would be reported; none exists.
 */
function isCireHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "cireweddings.com" || name.endsWith(".cireweddings.com")) return true;
  if (name === "localhost") return true;
  return name.endsWith(".localhost") && name.split(".").includes("cire");
}

export type Links = {
  readonly slashless: readonly { readonly address: string; readonly excerpt: string }[];
  readonly slashForm: number;
};

/** Every link in `text` to one of `addresses`, sorted into the two forms. */
export function directoryLinks(text: string, addresses: ReadonlySet<string>): Links {
  const slashless: { address: string; excerpt: string }[] = [];
  let slashForm = 0;
  for (const match of text.matchAll(LINK)) {
    const host = match[2];
    const path = match[3] ?? "";
    if (host !== undefined && !isCireHost(host)) continue;
    if (path.endsWith("/")) {
      if (addresses.has(path.replace(/\/+$/, ""))) slashForm += 1;
      continue;
    }
    if (!addresses.has(path)) continue;
    const at = match.index ?? 0;
    const excerpt = text
      .slice(Math.max(0, at - 30), at + match[0].length + 30)
      .replace(/\s+/g, " ");
    slashless.push({ address: path, excerpt });
  }
  return { slashless, slashForm };
}

/** Attribute values Astro writes with entity quotes, an island's props among them. */
function decodeQuotes(html: string): string {
  return html.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function list(dir: string, pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const path of new Glob(pattern).scan({ cwd: dir, dot: true })) found.push(path);
  return found.toSorted();
}

/** `privacy/hosts/index.html` → `/privacy/hosts`; the root page names no directory. */
function addressOf(indexFile: string): string | null {
  const dir = indexFile
    .split("\\")
    .join("/")
    .replace(/(^|\/)index\.html$/, "");
  return dir === "" ? null : `/${dir}`;
}

/** A site's directory pages, or the finding that says why it has none to read. */
async function readPages(site: Site): Promise<readonly string[] | Finding> {
  if (!(await isDirectory(site.pages))) {
    return { site: site.name, problem: `${site.pages} is missing; build the site first` };
  }
  const indexes = await list(site.pages, "**/index.html");
  if (indexes.length === 0) {
    return { site: site.name, problem: `${site.pages} holds no index.html page` };
  }
  return indexes.map(addressOf).filter((address): address is string => address !== null);
}

type Scan = {
  readonly findings: readonly Finding[];
  readonly files: number;
  readonly slashForm: number;
  /** False when a scan directory is missing, so the count proves nothing. */
  readonly complete: boolean;
};

async function scanDirectory(
  site: Site,
  dir: string,
  addresses: ReadonlySet<string>,
): Promise<Scan> {
  if (!(await isDirectory(dir))) {
    const problem = `${dir} is missing; build the site first`;
    return { findings: [{ site: site.name, problem }], files: 0, slashForm: 0, complete: false };
  }
  const files = await list(dir, "**/*.{html,js,mjs}");
  const read = await Promise.all(
    files.map(async (file) => {
      const raw = await Bun.file(join(dir, file)).text();
      return {
        file,
        links: directoryLinks(file.endsWith(".html") ? decodeQuotes(raw) : raw, addresses),
      };
    }),
  );
  return {
    findings: read.flatMap(({ file, links }) =>
      links.slashless.map(({ address, excerpt }) => ({
        site: site.name,
        file,
        path: join(dir, file),
        address,
        problem: `links ${address} without its trailing slash: …${excerpt}…`,
      })),
    ),
    files: files.length,
    slashForm: read.reduce((sum, { links }) => sum + links.slashForm, 0),
    complete: true,
  };
}

export async function checkDirectoryLinks(
  sites: readonly Site[],
): Promise<{ readonly findings: readonly Finding[]; readonly reports: readonly Report[] }> {
  const paged = await Promise.all(
    sites.map(async (site) => ({ site, pages: await readPages(site) })),
  );
  const findings: Finding[] = paged.flatMap(({ pages }) => ("problem" in pages ? [pages] : []));
  const readable = paged.flatMap(({ site, pages }) =>
    "problem" in pages ? [] : [{ site, pages }],
  );
  const addresses = new Set(readable.flatMap(({ pages }) => pages));

  const scanned = await Promise.all(
    readable.map(async ({ site, pages }) => ({
      site,
      pages,
      scans: await Promise.all(site.scan.map((dir) => scanDirectory(site, dir, addresses))),
    })),
  );

  const reports: Report[] = [];
  for (const { site, pages, scans } of scanned) {
    findings.push(...scans.flatMap((scan) => scan.findings));
    const slashForm = scans.reduce((sum, scan) => sum + scan.slashForm, 0);
    if (scans.every((scan) => scan.complete) && slashForm === 0) {
      findings.push({
        site: site.name,
        problem:
          "the scan found no link to a directory page in the slash form, so it has stopped " +
          "reading this build's links (or the site stopped linking its own pages); failing " +
          "rather than passing on a scan that saw nothing",
      });
    }
    const files = scans.reduce((sum, scan) => sum + scan.files, 0);
    reports.push({ site: site.name, pages: pages.length, files, slashForm });
  }

  return { findings, reports };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sites: readonly Site[] =
    args.length === 0
      ? CIRE_SITES
      : args.map((arg) => {
          const dir = resolve(process.cwd(), arg);
          return { name: arg, pages: dir, scan: [dir] };
        });

  const { findings, reports } = await checkDirectoryLinks(sites);

  if (findings.length > 0) {
    for (const finding of findings) {
      const where =
        finding.path === undefined
          ? finding.site
          : `${relative(process.cwd(), finding.path)}: ${finding.address}`;
      process.stderr.write(`::error::${where} — ${finding.problem}\n`);
    }
    process.stderr.write(
      "\ncheck-directory-links: Cloudflare's asset server answers a directory page's " +
        "address without its trailing slash with a redirect to the slash form. Link the " +
        "page as it is served: /privacy/, /login/?returnTo=…, `${MARKETING_URL}/privacy/guests/`.\n",
    );
    process.exit(1);
  }

  for (const report of reports) {
    process.stdout.write(
      `check-directory-links: ${report.site}: ` +
        `${plural(report.pages, "directory page", "directory pages")}, ` +
        `${plural(report.files, "file", "files")}, ` +
        `${plural(report.slashForm, "link", "links")} in the slash form\n`,
    );
  }
}
