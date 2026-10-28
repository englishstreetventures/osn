#!/usr/bin/env bun
/**
 * Check the `production-sites` artifact, then put its site builds in place.
 *
 * The `sites` job of .github/workflows/production-release.yml builds each
 * production site with no secret and uploads the builds. Every job that
 * downloads them holds a production credential, so each one downloads to a
 * directory outside the checkout and runs this, in a step that holds no
 * secret, before any later step:
 *
 *   bun run scripts/production-sites-artifact.ts <download directory>
 *
 * It refuses the artifact, copying nothing, unless every entry in it is
 * `production-sites.txt`, a directory on the way to a site's build
 * directory, or a file or directory inside one: the `SITE_BUILDS`
 * directories of the sites PRODUCTION_SITE_MODES does not turn off, the ones
 * the `sites` job uploads. A symbolic link anywhere, or anything that is
 * neither a file nor a directory, is refused too. So whatever the build
 * steps wrote into the artifact, only files the sites serve reach the
 * checkout, never a script, a package or a workflow a later step runs.
 * Then it replaces each site build the artifact holds with its copy.
 *
 * Imports only production-sites.ts, which imports nothing.
 *
 * Exit codes: 0 placed; 1 refused, nothing copied; 2 a usage error.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  PRODUCTION_SITE_MODES,
  SITE_BUILDS,
  SITE_SURFACES,
} from "../shared/infra/src/production-sites";

/** The file at the artifact's root that lists the builds. */
export const LIST_FILE = "production-sites.txt";

/** The build directories the artifact may hold, from the repository root. */
export const SITE_DIRECTORIES: readonly string[] = SITE_SURFACES.filter(
  (site) => PRODUCTION_SITE_MODES[site] !== "off",
).map((site) => SITE_BUILDS[site].directory);

export interface ArtifactEntry {
  /** The path from the artifact's root, `/`-separated. */
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

/** Every reason to refuse an artifact holding `entries`; empty when it may be placed. */
export function artifactProblems(
  entries: readonly ArtifactEntry[],
  directories: readonly string[] = SITE_DIRECTORIES,
): string[] {
  const problems: string[] = [];
  for (const { path, kind } of entries) {
    // An empty part is a leading, doubled or trailing `/`: an absolute path among them.
    if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      problems.push(`${path} is not a plain relative path`);
      continue;
    }
    if (kind === "symlink") {
      problems.push(`${path} is a symbolic link`);
      continue;
    }
    if (kind === "other") {
      problems.push(`${path} is neither a file nor a directory`);
      continue;
    }
    const inside = directories.some((dir) => path === dir || path.startsWith(`${dir}/`));
    const onTheWay = kind === "directory" && directories.some((dir) => dir.startsWith(`${path}/`));
    const list = kind === "file" && path === LIST_FILE;
    const buildIsDirectory = !directories.includes(path) || kind === "directory";
    if (!(inside || onTheWay || list) || !buildIsDirectory) {
      problems.push(`${path} is not part of a site build`);
    }
  }
  return problems;
}

/** Every entry under `root`, read without following a link. */
function walk(root: string, at = "", entries: ArtifactEntry[] = []): ArtifactEntry[] {
  for (const name of readdirSync(join(root, at))) {
    const path = at === "" ? name : `${at}/${name}`;
    const stat = lstatSync(join(root, path));
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";
    entries.push({ path, kind });
    if (kind === "directory") walk(root, path, entries);
  }
  return entries;
}

export interface ArtifactInput {
  readonly args: readonly string[];
  /** The repository root the builds are placed under. */
  readonly root: string;
  readonly out: (text: string) => void;
}

export function placeProductionSites(input: ArtifactInput): number {
  const error = (message: string) => input.out(`::error::production-sites-artifact: ${message}\n`);
  const [from = "", ...rest] = input.args;
  if (from === "" || rest.length > 0 || !existsSync(from) || !lstatSync(from).isDirectory()) {
    error("usage: production-sites-artifact.ts <download directory>, an existing directory");
    return 2;
  }
  const entries = walk(from);
  const problems = artifactProblems(entries);
  if (problems.length > 0) {
    for (const problem of problems) error(`refused the artifact: ${problem}`);
    return 1;
  }
  const present = SITE_DIRECTORIES.filter((dir) =>
    entries.some((entry) => entry.path === dir && entry.kind === "directory"),
  );
  for (const dir of present) {
    const target = join(input.root, dir);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(from, dir), target, { recursive: true });
    input.out(`Placed ${dir}\n`);
  }
  if (present.length === 0) input.out("The artifact holds no site build.\n");
  return 0;
}

if (import.meta.main) {
  process.exit(
    placeProductionSites({
      args: process.argv.slice(2),
      root: process.cwd(),
      out: (text) => process.stdout.write(text),
    }),
  );
}
