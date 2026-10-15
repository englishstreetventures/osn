/**
 * The `test:mutation` command: runs Stryker for the cire package in the
 * current directory.
 *
 * Stryker copies its working directory into a sandbox and mutates the copy.
 * Run from the package, the sandbox holds that package alone, and every path a
 * test or config reaches outside it with — `../../shared/test-config`, a
 * contract test reading `../../../api/src`, a seed test running
 * `../../../../scripts` — resolves to nothing. So this runs Stryker from the
 * repo root with the package's own `stryker/config.mjs`: the sandbox is a copy
 * of the repository, and every relative path lands where it does here.
 */

import { join, relative } from "node:path";

import { buildApplication, buildCommand, numberParser, type CommandContext } from "@stricli/core";

import { changedMutate, parseMutateEntry, rootMutateEntry } from "./paths.ts";

/** What the command needs from the machine; tests supply their own. */
export interface MutationContext extends CommandContext {
  readonly process: CommandContext["process"] & { exitCode?: number | string | null };
  readonly cwd: string;
  readonly repoRoot: string;
  readonly exists: (path: string) => boolean;
  /** Runs git in `repoRoot`; `undefined` when it exits non-zero. */
  readonly git: (args: readonly string[]) => string | undefined;
  /** Runs `cmd` in `cwd` with the terminal attached and resolves to its exit code. */
  readonly spawn: (cmd: readonly string[], cwd: string) => Promise<number>;
}

interface Flags {
  readonly changed: boolean;
  readonly base?: string;
  readonly mutate?: readonly string[];
  readonly incremental: boolean;
  readonly dryRun: boolean;
  readonly concurrency?: number;
}

async function runMutation(
  this: MutationContext,
  flags: Flags,
  ...passthrough: readonly string[]
): Promise<void | Error> {
  const pkgDir = relative(this.repoRoot, this.cwd);
  const config = join(pkgDir, "stryker", "config.mjs");
  if (!pkgDir.startsWith("cire/") || !this.exists(join(this.repoRoot, config))) {
    return new Error(`run from a cire package with a stryker/config.mjs (cwd: ${this.cwd})`);
  }
  const changed = flags.changed || flags.base !== undefined;
  if (changed && flags.mutate) return new Error("--changed and --mutate cannot be combined");

  let mutate = flags.mutate?.map((entry) => rootMutateEntry(entry, pkgDir, this.repoRoot));
  if (changed) {
    const base = flags.base ?? "origin/main";
    const pkgSrc = join(pkgDir, "src");
    const mergeBase = this.git(["merge-base", base, "HEAD"])?.trim();
    if (!mergeBase) return new Error(`no merge base between ${base} and HEAD`);
    const diff = this.git(["diff", "-U0", "--no-color", "--no-ext-diff", mergeBase, "--", pkgSrc]);
    const untracked = this.git(["ls-files", "--others", "--exclude-standard", "--", pkgSrc]);
    if (diff === undefined || untracked === undefined) return new Error("git diff failed");
    mutate = changedMutate(diff, untracked.split("\n").filter(Boolean));
    if (mutate.length === 0) {
      this.process.stdout.write(`no changed source lines under ${pkgSrc} since ${base}\n`);
      return;
    }
  }

  const cmd = [join(this.repoRoot, "node_modules/.bin/stryker"), "run", config];
  if (mutate) cmd.push("--mutate", mutate.join(","));
  if (flags.incremental) cmd.push("--incremental");
  if (flags.dryRun) cmd.push("--dryRunOnly");
  if (flags.concurrency !== undefined) cmd.push("--concurrency", String(flags.concurrency));
  cmd.push(...passthrough);
  this.process.exitCode = await this.spawn(cmd, this.repoRoot);
}

const command = buildCommand<Flags, string[], MutationContext>({
  func: runMutation,
  parameters: {
    flags: {
      changed: {
        kind: "boolean",
        brief:
          "Mutate only the lines this branch adds or changes under src/, plus untracked source",
        default: false,
      },
      base: {
        kind: "parsed",
        parse: String,
        brief: "Ref the branch is diffed against; implies --changed (default origin/main)",
        optional: true,
      },
      mutate: {
        kind: "parsed",
        parse: parseMutateEntry,
        brief: "Files or file:start-end ranges, relative to the package or absolute",
        optional: true,
        variadic: ",",
      },
      incremental: {
        kind: "boolean",
        brief: "Reuse results whose code and covering tests are unchanged (vitest packages)",
        default: false,
      },
      dryRun: { kind: "boolean", brief: "Run the initial test run only", default: false },
      concurrency: {
        kind: "parsed",
        parse: numberParser,
        brief: "Number of test runner processes",
        optional: true,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Further Stryker options, after --",
        parse: String,
        placeholder: "stryker-option",
      },
    },
  },
  docs: {
    brief: "Run Stryker mutation testing for this cire package",
    fullDescription:
      "Runs from the repo root with this package's stryker/config.mjs. See wiki/conventions/testing-patterns.md §Mutation testing.",
  },
});

export const app = buildApplication(command, {
  name: "test:mutation",
  scanner: { caseStyle: "allow-kebab-for-camel", allowArgumentEscapeSequence: true },
});
