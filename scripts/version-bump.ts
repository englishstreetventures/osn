#!/usr/bin/env bun
/**
 * Which of the files that differ between two commits hold nothing but what a
 * release wrote: the package versions `changeset version` bumps, the
 * changelogs it writes, and the workspace `version` lines the next
 * `bun install` rewrites in bun.lock. After every merge that carries a
 * changeset, .github/workflows/release.yml pushes those to main as bot
 * commits.
 *
 * No surface is built from a package's version or its changelog: no file a
 * surface or stack builds from names a package.json, an npm_package_ variable
 * or a CHANGELOG in its code, and nothing sets the service version
 * (scripts/tests/version-bump.test.ts fails when one does; a read it cannot
 * see, such as a path assembled from parts, is the author's to report). So
 * scripts/release-plan.ts sets these files aside in every diff
 * before the surface map sees it, in the production check and the dev gate
 * alike: a surface whose only change is a version is unchanged, and dev's run
 * of the merge counts as a run of the version commits after it.
 *
 * The call is made from the two copies of each file, never from who wrote
 * the commit. A file is set aside when it is
 *   - a CHANGELOG.md in a workspace's own directory (a key of `workspaces` in
 *     the release commit's bun.lock; "" is the root);
 *   - a package.json, or the root bun.lock, present at both commits, whose two
 *     copies pass both checks: their texts are equal once each
 *     `"version": "…"` line has its value masked, so any other byte, a moved
 *     line or a repeated key is a change; and their parsed forms are equal once
 *     the top-level `version` (package.json) or each workspace entry's
 *     `version` (bun.lock) is deleted, so a `version` anywhere else, such as a
 *     dependency of that name, is a change.
 * A file that does not parse, or that git cannot return, is a change, and so
 * is every other file; whether a change redeploys a surface is the map's
 * call (scripts/deploy-surfaces.ts).
 *
 * Imports only Node built-ins: the plan job runs it with no install, and dev's
 * stack jobs load it through scripts/dev-deploy-order.ts.
 *
 * Usage, to see what the planner compares (repository root as the working
 * directory):
 *   bun scripts/version-bump.ts <from-sha> <to-sha>
 */

import { posix } from "node:path";

/** A parsed JSON object's members, in its own order. */
type Members = readonly (readonly [string, unknown])[];

/** The members of a JSON object; undefined for null, an array or a scalar. */
const membersOf = (value: unknown): Members | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : undefined;

/** The members of a parsed bun.lock's `workspaces` object, when it has one. */
const workspacesOf = (lockfile: Members): Members | undefined =>
  membersOf(lockfile.find(([key]) => key === "workspaces")?.[1]);

/** A `"version": "…"` line, alone on its line, as changesets and bun write one. */
const VERSION_LINE = /^([ \t]*"version": )"[^"\n]*"(,?)$/gm;

/** The text with every version line's value masked. */
const masked = (text: string): string => text.replace(VERSION_LINE, '$1"*"$2');

/** Members less `version`. */
const withoutVersion = (members: Members): Members => members.filter(([key]) => key !== "version");

/** A package.json's parsed form without its own `version`. Throws on anything but an object. */
function manifestForm(text: string): string {
  const manifest = membersOf(JSON.parse(text));
  if (manifest === undefined) throw new TypeError("a package.json that is not an object");
  return JSON.stringify(withoutVersion(manifest));
}

/** bun.lock's parsed form without each workspace's `version`. Throws on any other shape. */
function lockfileForm(text: string): string {
  const lockfile = membersOf(Bun.JSONC.parse(text));
  const workspaces = lockfile === undefined ? undefined : workspacesOf(lockfile);
  if (lockfile === undefined || workspaces === undefined) {
    throw new TypeError("a bun.lock with no workspaces object");
  }
  const entries = workspaces.map(([dir, entry]) => {
    const members = membersOf(entry);
    return [dir, members === undefined ? entry : withoutVersion(members)];
  });
  return JSON.stringify(
    lockfile.map(([key, value]) => [key, key === "workspaces" ? entries : value]),
  );
}

/** The workspace directories a bun.lock names; none when it is missing or does not parse. */
export function workspaceDirs(lockfile: string | undefined): ReadonlySet<string> {
  if (lockfile === undefined) return new Set();
  try {
    const parsed = membersOf(Bun.JSONC.parse(lockfile));
    const workspaces = parsed === undefined ? undefined : workspacesOf(parsed);
    return new Set((workspaces ?? []).map(([dir]) => dir));
  } catch {
    return new Set();
  }
}

/**
 * Whether the change to `path` from `before` to `after` (undefined where the
 * file does not exist) is one a release writes and no surface builds from.
 * `workspaces` holds the workspace directories at the later commit.
 */
export function versionOnly(
  path: string,
  before: string | undefined,
  after: string | undefined,
  workspaces: ReadonlySet<string>,
): boolean {
  const name = posix.basename(path);
  if (name === "CHANGELOG.md") {
    const dir = posix.dirname(path);
    return workspaces.has(dir === "." ? "" : dir);
  }
  const form = name === "package.json" ? manifestForm : path === "bun.lock" ? lockfileForm : null;
  if (form === null || before === undefined || after === undefined) return false;
  try {
    return masked(before) === masked(after) && form(before) === form(after);
  } catch {
    return false;
  }
}

/** One changed path, with the object each side holds; undefined where the side has none. */
export interface Change {
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  /** False when either side is not a plain file's blob (a submodule). */
  readonly blobs: boolean;
}

const RAW_HEADER = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]\d*$/;
const GITLINK = "160000";
const absent = (oid: string): boolean => /^0+$/.test(oid);

/**
 * The paths that differ between two commits' trees and the object each side
 * holds, or undefined when git cannot compare them or its answer does not
 * parse. The same commits and options as deploy-surfaces.ts's changedFiles,
 * `-z` included, so the two list the same paths, each as written.
 */
function rawDiff(from: string, to: string, cwd: string): readonly Change[] | undefined {
  if (!/^[0-9a-f]{4,40}$/i.test(from) || !/^([0-9a-f]{4,40}|HEAD)$/i.test(to)) return undefined;
  const proc = Bun.spawnSync(
    ["git", "diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to, "--"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return proc.exitCode === 0 ? parseRawDiff(proc.stdout.toString()) : undefined;
}

/**
 * `git diff --raw -z` output as changes, in its order; undefined when any
 * part of it is not the shape git writes.
 */
export function parseRawDiff(output: string): readonly Change[] | undefined {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return undefined;
  const changes: Change[] = [];
  for (let at = 0; at < fields.length; at += 2) {
    const header = RAW_HEADER.exec(fields[at] ?? "");
    const path = fields[at + 1];
    if (header === null || path === undefined || path === "") return undefined;
    const [, beforeMode, afterMode, beforeOid = "", afterOid = ""] = header;
    changes.push({
      path,
      before: absent(beforeOid) ? undefined : beforeOid,
      after: absent(afterOid) ? undefined : afterOid,
      blobs: beforeMode !== GITLINK && afterMode !== GITLINK,
    });
  }
  return changes;
}

/**
 * Each named object's text, by name, in one `git cat-file --batch`. A name
 * git cannot return as a blob is missing from the answer.
 */
function readBlobs(names: readonly string[], cwd: string): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  if (names.length === 0) return texts;
  const proc = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd,
    stdin: new TextEncoder().encode(`${names.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return texts;
  const out = proc.stdout;
  let at = 0;
  for (const name of names) {
    const end = out.indexOf(10, at);
    if (end === -1) break;
    const header = /^[0-9a-f]{40,64} (\S+) (\d+)$/.exec(out.subarray(at, end).toString());
    if (header === null) {
      at = end + 1;
      continue;
    }
    const size = Number(header[2]);
    if (header[1] === "blob") texts.set(name, out.subarray(end + 1, end + 1 + size).toString());
    at = end + 1 + size + 1;
  }
  return texts;
}

/** What differs between a commit and `head`: the files kept, and those set aside. */
export interface Split {
  readonly kept: readonly string[];
  readonly setAside: readonly string[];
}

/**
 * The files that differ between a commit and `head`, split by `versionOnly`;
 * undefined when git cannot compare the two. Answers are kept per commit,
 * and file contents per object, across calls.
 */
export function splitDiff(head: string, cwd: string): (from: string) => Split | undefined {
  const answers = new Map<string, Split | undefined>();
  const texts = new Map<string, string | undefined>();
  const read = (names: readonly string[]): void => {
    const unread = [...new Set(names)].filter((name) => !texts.has(name));
    const found = readBlobs(unread, cwd);
    for (const name of unread) texts.set(name, found.get(name));
  };
  const headLockfile = `${head}:bun.lock`;
  let workspaces: ReadonlySet<string> | undefined;

  const split = (from: string): Split | undefined => {
    const changes = rawDiff(from, head, cwd);
    if (changes === undefined) return undefined;
    // Only a package.json and bun.lock are judged by their contents.
    const compared = new Set(
      changes.filter(
        (c) => c.blobs && (posix.basename(c.path) === "package.json" || c.path === "bun.lock"),
      ),
    );
    read([
      ...[...compared].flatMap((c) => [c.before, c.after].filter((oid) => oid !== undefined)),
      ...(workspaces === undefined ? [headLockfile] : []),
    ]);
    workspaces ??= workspaceDirs(texts.get(headLockfile));
    const known = workspaces;
    /** A side's text; null when git holds the object but could not return it. */
    const text = (oid: string | undefined): string | undefined | null =>
      oid === undefined ? undefined : (texts.get(oid) ?? null);
    const aside = (c: Change): boolean => {
      if (!c.blobs) return false;
      if (!compared.has(c)) return versionOnly(c.path, undefined, undefined, known);
      const before = text(c.before);
      const after = text(c.after);
      return before !== null && after !== null && versionOnly(c.path, before, after, known);
    };
    const kept: string[] = [];
    const setAside: string[] = [];
    for (const c of changes) (aside(c) ? setAside : kept).push(c.path);
    return { kept, setAside };
  };

  return (from) => {
    if (!answers.has(from)) answers.set(from, split(from));
    return answers.get(from);
  };
}

/** The files that differ between a commit and `head`, less those `versionOnly` sets aside. */
export function contentDiff(
  head: string,
  cwd: string,
): (from: string) => readonly string[] | undefined {
  const split = splitDiff(head, cwd);
  return (from) => split(from)?.kept;
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (from === undefined || to === undefined) {
    process.stderr.write("usage: bun scripts/version-bump.ts <from-sha> <to-sha>\n");
    process.exit(2);
  }
  const split = splitDiff(to, process.cwd())(from);
  if (split === undefined) {
    process.stderr.write(`git cannot compare ${from} with ${to}\n`);
    process.exit(1);
  }
  const list = (files: readonly string[]) => files.map((file) => `  ${file}\n`).join("");
  process.stdout.write(
    `kept, for the surface map to judge (${split.kept.length}):\n${list(split.kept)}` +
      `set aside, a release's version bump (${split.setAside.length}):\n${list(split.setAside)}`,
  );
}
