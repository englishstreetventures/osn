import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { Data } from "effect";

/** A prebuilt site directory a stack uploads as it is, and what proves it was built for the stage. */
export interface PrebuiltSite {
  /** The workspace that builds it, as `bun run build --filter=` names it, and which output when it has two. */
  readonly site: string;
  /** Relative to the stack's working directory, as the stack declares it to Alchemy. */
  readonly directory: string;
  /** Every origin the site's build for this stage writes into its output. */
  readonly origins: readonly string[];
}

export class SiteBuildError extends Data.TaggedError("SiteBuildError")<{
  readonly site: string;
  readonly directory: string;
  /** The origins no text file under the directory holds: every one when the directory is missing. */
  readonly missing: readonly string[];
  readonly message: string;
}> {}

/** Files a site build writes as text. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".xml",
  ".txt",
]);

/** Cloudflare's static-asset config files: text with no extension. A cire site's CSP names its API only in `_headers`. */
const TEXT_NAMES: ReadonlySet<string> = new Set(["_headers", "_redirects"]);

/** Every regular text file under `directory`; a link is never followed, so nothing outside it is read. */
function textFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(path);
    const text = TEXT_NAMES.has(entry.name) || TEXT_EXTENSIONS.has(extname(entry.name));
    return entry.isFile() && text ? [path] : [];
  });
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `origin` as a whole origin: not followed by more of a host name (a label
 * character, or a dot and another label) or by a port, either of which makes
 * it a different origin.
 */
const wholeOrigin = (origin: string): RegExp =>
  new RegExp(`${escape(origin)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9]|:[0-9])`);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Throws SiteBuildError unless `directory` exists and its text files, taken
 * together, hold every one of `origins`. A site build bakes the stage's hosts
 * into its output, so output that lacks one was built for other hosts or
 * none, and uploading it would ship a site that calls the wrong API.
 */
export function assertSiteBuiltFor(prebuilt: PrebuiltSite): void {
  const { site, directory, origins } = prebuilt;
  const refuse = (missing: readonly string[], why: string): never => {
    throw new SiteBuildError({
      site,
      directory,
      missing,
      message: `${site}'s build output at ${directory} ${why}. Build it with the stage's hosts (bun run --cwd shared/infra dev-hosts -- --stage <stage>) before deploying.`,
    });
  };
  if (origins.length === 0) {
    refuse([], "names no origin to check, so nothing ties it to this stage");
  }
  if (!isDirectory(directory)) {
    refuse(origins, "does not exist");
  }
  const left = new Map(origins.map((origin) => [origin, wholeOrigin(origin)]));
  for (const file of textFiles(directory)) {
    const text = readFileSync(file, "utf8");
    for (const [origin, pattern] of left) if (pattern.test(text)) left.delete(origin);
    if (left.size === 0) return;
  }
  const missing = [...left.keys()];
  refuse(missing, `does not name ${missing.join(", ")}: it was built for other hosts`);
}
