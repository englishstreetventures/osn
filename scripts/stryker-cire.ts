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
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Prefixes each comma-separated `--mutate` entry with `pkgDir`, keeping a
 * `:line-range` suffix and a leading `!` (Stryker's exclusion) in place. An
 * entry that already starts with `pkgDir/` is left alone.
 */
export function rewriteMutate(value: string, pkgDir: string): string {
  return value
    .split(",")
    .map((entry) => {
      const negated = entry.startsWith("!");
      const path = negated ? entry.slice(1) : entry;
      const rooted = path.startsWith(`${pkgDir}/`) ? path : join(pkgDir, path);
      return negated ? `!${rooted}` : rooted;
    })
    .join(",");
}

/** Rewrites the value of every `--mutate`/`-m` flag, in both `--mutate x` and `--mutate=x` forms. */
export function rewriteArgs(args: readonly string[], pkgDir: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const inline = /^(--mutate|-m)=(.*)$/.exec(arg);
    if (inline) {
      out.push(`${inline[1]}=${rewriteMutate(inline[2] ?? "", pkgDir)}`);
    } else if ((arg === "--mutate" || arg === "-m") && i + 1 < args.length) {
      out.push(arg, rewriteMutate(args[i + 1] ?? "", pkgDir));
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}

if (import.meta.main) {
  const pkgDir = relative(REPO_ROOT, process.cwd());
  const config = join(pkgDir, "stryker.config.mjs");
  if (!pkgDir.startsWith("cire/") || !existsSync(join(REPO_ROOT, config))) {
    process.stderr.write(
      `stryker-cire: run from a cire package with a stryker.config.mjs (cwd: ${process.cwd()})\n`,
    );
    process.exit(2);
  }
  const proc = Bun.spawn(
    [
      join(REPO_ROOT, "node_modules/.bin/stryker"),
      "run",
      config,
      ...rewriteArgs(process.argv.slice(2), pkgDir),
    ],
    { cwd: REPO_ROOT, stdio: ["inherit", "inherit", "inherit"] },
  );
  process.exit(await proc.exited);
}
