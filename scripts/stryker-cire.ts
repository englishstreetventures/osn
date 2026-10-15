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
 * repo root with the package's own `stryker.config.mjs`: the sandbox is a copy
 * of the repository, and every relative path lands where it does here.
 *
 * `--mutate` paths are written relative to the package, as anyone running the
 * script from it would; they are rewritten to the repo-root paths Stryker now
 * expects. Every other argument passes through unchanged.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

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

/** Why `cwd` cannot run mutation tests, or `undefined` when it can. */
export function refusal(
  cwd: string,
  repoRoot: string,
  configExists: (path: string) => boolean,
): string | undefined {
  const pkgDir = relative(repoRoot, cwd);
  if (!pkgDir.startsWith("cire/") || !configExists(join(repoRoot, pkgDir, "stryker.config.mjs"))) {
    return `stryker-cire: run from a cire package with a stryker.config.mjs (cwd: ${cwd})`;
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
      join(pkgDir, "stryker.config.mjs"),
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
  const { cmd, cwd } = strykerCommand(process.cwd(), process.argv.slice(2), REPO_ROOT);
  const proc = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
