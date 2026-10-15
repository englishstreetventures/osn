#!/usr/bin/env bun
/**
 * Runs Stryker for the cire package in the current directory — the
 * `test:mutation` script of every `cire/*` package with tests.
 *
 * Stryker copies its working directory into a sandbox and mutates the copy.
 * Run from the package, the sandbox holds that package alone, and every path a
 * test or config reaches outside it with — `../../shared/test-config`, a
 * contract test reading `../../../api/src`, a seed test running
 * `../../../../scripts` — resolves to nothing. So this runs Stryker from the
 * repo root with the package's own `stryker/config.mjs`: the sandbox is a copy
 * of the repository, and every relative path lands where it does here.
 *
 * `--mutate` paths are written relative to the package, as anyone running the
 * script from it would; they are rewritten to the repo-root paths Stryker now
 * expects. Every other argument passes through unchanged.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/**
 * Rewrites each comma-separated `--mutate` entry to a repo-root path, keeping a
 * `:line-range` suffix and a leading `!` (Stryker's exclusion) in place. A
 * package-relative entry is prefixed with `pkgDir`; an absolute one is made
 * relative to `repoRoot`; one already starting with `pkgDir/` is left alone.
 * Whitespace around an entry and empty entries are dropped: Stryker matches
 * the text literally, so either would match no file and mutate nothing.
 */
export function rewriteMutate(value: string, pkgDir: string, repoRoot: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== "!")
    .map((entry) => {
      const negated = entry.startsWith("!");
      const path = negated ? entry.slice(1) : entry;
      const rooted = isAbsolute(path)
        ? relative(repoRoot, path)
        : path.startsWith(`${pkgDir}/`)
          ? path
          : join(pkgDir, path);
      return negated ? `!${rooted}` : rooted;
    })
    .join(",");
}

/** Rewrites the value of every `--mutate`/`-m` flag, in both `--mutate x` and `--mutate=x` forms. */
export function rewriteArgs(args: readonly string[], pkgDir: string, repoRoot: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const inline = /^(--mutate|-m)=(.*)$/.exec(arg);
    if (inline) {
      out.push(`${inline[1]}=${rewriteMutate(inline[2] ?? "", pkgDir, repoRoot)}`);
    } else if ((arg === "--mutate" || arg === "-m") && i + 1 < args.length) {
      out.push(arg, rewriteMutate(args[i + 1] ?? "", pkgDir, repoRoot));
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}

const MUTABLE = /\/src\/.*\.tsx?$/;
const NOT_MUTABLE = /\.d\.ts$|\.(test|spec)\.tsx?$/;

/**
 * Takes the wrapper's own `--changed[=<base>]` flag out of `argv`. `base` is
 * `undefined` when the flag is absent; a bare `--changed` diffs against
 * `origin/main`.
 */
export function takeChangedFlag(argv: readonly string[]) {
  let base: string | undefined;
  const rest: string[] = [];
  for (const arg of argv) {
    const match = /^--changed(?:=(.+))?$/.exec(arg);
    if (match) base = match[1] ?? "origin/main";
    else rest.push(arg);
  }
  return { base, rest };
}

/**
 * Turns `git diff -U0` output and a list of untracked files into `--mutate`
 * entries: one `path:start-end` per added or changed hunk, and the whole file
 * for an untracked one. Only source under `src/` is kept — no declaration
 * files and no tests. A hunk that only deletes lines has nothing to mutate.
 */
export function changedMutate(diff: string, untracked: readonly string[]): string[] {
  const keep = (path: string) => MUTABLE.test(path) && !NOT_MUTABLE.test(path);
  const entries: string[] = [];
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      file = path.startsWith("b/") && keep(path.slice(2)) ? path.slice(2) : undefined;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!file || !hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) entries.push(`${file}:${start}-${start + count - 1}`);
  }
  return [...entries, ...untracked.filter(keep)];
}

/** Why `cwd` cannot run mutation tests, or `undefined` when it can. */
export function refusal(
  cwd: string,
  repoRoot: string,
  configExists: (path: string) => boolean,
): string | undefined {
  const pkgDir = relative(repoRoot, cwd);
  if (
    !pkgDir.startsWith("cire/") ||
    !configExists(join(repoRoot, pkgDir, "stryker", "config.mjs"))
  ) {
    return `test:mutation: run from a cire package with a stryker/config.mjs (cwd: ${cwd})`;
  }
  return undefined;
}

/** The Stryker invocation for the package at `cwd`: run from `repoRoot`, with that package's config. */
export function strykerCommand(cwd: string, argv: readonly string[], repoRoot: string) {
  const pkgDir = relative(repoRoot, cwd);
  return {
    cmd: [
      join(repoRoot, "node_modules/.bin/stryker"),
      "run",
      join(pkgDir, "stryker", "config.mjs"),
      ...rewriteArgs(argv, pkgDir, repoRoot),
    ],
    cwd: repoRoot,
  };
}

if (import.meta.main) {
  const refused = refusal(process.cwd(), REPO_ROOT, existsSync);
  if (refused) {
    process.stderr.write(`${refused}\n`);
    process.exit(2);
  }
  const { base, rest } = takeChangedFlag(process.argv.slice(2));
  let argv = rest;
  if (base !== undefined) {
    const pkgSrc = join(relative(REPO_ROOT, process.cwd()), "src");
    const git = (...args: string[]) => {
      const run = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stderr: "inherit" });
      if (run.exitCode !== 0) process.exit(2);
      return run.stdout.toString();
    };
    const mergeBase = git("merge-base", base, "HEAD").trim();
    const mutate = changedMutate(
      git("diff", "-U0", "--no-color", "--no-ext-diff", mergeBase, "--", pkgSrc),
      git("ls-files", "--others", "--exclude-standard", "--", pkgSrc).split("\n").filter(Boolean),
    );
    if (mutate.length === 0) {
      process.stdout.write(
        `test:mutation: no changed source lines under ${pkgSrc} since ${base}\n`,
      );
      process.exit(0);
    }
    argv = [...rest, "--mutate", mutate.map((entry) => join(REPO_ROOT, entry)).join(",")];
  }
  const { cmd, cwd } = strykerCommand(process.cwd(), argv, REPO_ROOT);
  const proc = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
