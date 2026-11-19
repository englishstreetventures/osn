#!/usr/bin/env bun
/**
 * CI guard: refuse a pull request that loosens a landmines rule in
 * oxlintrc.json.
 *
 * The `allow` maps of `landmines-testing/no-fixed-sleep` and
 * `no-flake-masking` give each file its exact count of existing sites. The
 * rule itself only compares a file with its entry: below it the entry is
 * stale, above it every site reports, equal is silent. So a pull request that
 * adds a sleep and raises the count by one passes lint. This script compares
 * the pull request's oxlintrc.json with its base's and refuses, for any
 * `landmines-` rule the base sets:
 *
 *   - the rule missing at head (a renamed plugin alias renames every key), or
 *     at a lower severity than on the base;
 *   - an `allow` count raised, or a key the base's map does not have; a file
 *     git sees as renamed carries its base count to the new key;
 *   - an `overrides[].rules` landmines entry added, changed or dropped;
 *   - an added line in a code file that disables a landmines rule by name.
 *
 * And, whatever the base holds, an `allow` key that matches no tracked file,
 * which would hand its budget to whatever file is later created there. A base
 * with no landmines rule at all has nothing to compare, and passes. Lowered
 * and removed counts pass. Gaps it leaves are listed in
 * wiki/conventions/house-lint-rules.md §landmines.
 *
 *   bun run scripts/check-landmines-allowlist.ts --base <ref>
 *
 * Run from the repository root; it reads ./oxlintrc.json and compares the
 * working tree with <ref>. It imports nothing outside Bun and Node, so CI can
 * run the base's copy of it from a temporary directory. Exit 0: passes. Exit
 * 1: refused, each reason printed. Exit 2: no --base, or a base or head
 * oxlintrc.json it cannot read or parse.
 */

const CONFIG = "oxlintrc.json";
const PREFIX = "landmines-";
const DISABLE_COMMENT = /(?:oxlint|eslint)-disable.*landmines-/;
const CODE_FILES = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const RANK = { off: 0, warn: 1, error: 2 } as const;

type Severity = keyof typeof RANK;

export type Finding = { readonly problem: string };

type Rule = {
  readonly severity: Severity;
  readonly allow: ReadonlyMap<string, number>;
};

type OverrideEntry = { readonly files: string; readonly key: string; readonly value: string };

type Landmines = {
  readonly rules: ReadonlyMap<string, Rule>;
  readonly overrides: ReadonlyMap<string, OverrideEntry>;
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entriesOf(value: unknown): readonly (readonly [string, unknown])[] {
  return isObject(value) ? Object.entries(value) : [];
}

/** The entries of the object at `value[name]`, or none. */
function entriesAt(value: unknown, name: string): readonly (readonly [string, unknown])[] {
  return entriesOf(entriesOf(value).find(([key]) => key === name)?.[1]);
}

/** `value[name]` as JSON, so two configs compare by text. */
function jsonAt(value: unknown, name: string): string {
  return JSON.stringify(entriesOf(value).find(([key]) => key === name)?.[1] ?? null);
}

/** oxlint reads a severity as a string or a number, alone or first in an array. */
function severityOf(value: unknown): Severity {
  const level: unknown = Array.isArray(value) ? value[0] : value;
  if (level === "error" || level === "deny" || level === 2) return "error";
  if (level === "warn" || level === 1) return "warn";
  return "off";
}

function allowOf(value: unknown): ReadonlyMap<string, number> {
  const options: unknown = Array.isArray(value) ? value[1] : undefined;
  return new Map(entriesAt(options, "allow").map(([path, count]) => [path, Number(count)]));
}

/** The landmines rules and override entries of one oxlintrc.json. Throws on text it cannot parse. */
export function readLandmines(text: string): Landmines {
  const config: unknown = Bun.JSONC.parse(text);
  if (!isObject(config)) throw new Error(`${CONFIG} is not an object`);

  const rules = new Map<string, Rule>();
  for (const [key, value] of entriesAt(config, "rules")) {
    if (key.startsWith(PREFIX))
      rules.set(key, { severity: severityOf(value), allow: allowOf(value) });
  }

  const overrides = new Map<string, OverrideEntry>();
  const blocks: unknown = entriesOf(config).find(([key]) => key === "overrides")?.[1];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const files = jsonAt(block, "files");
    for (const [key, value] of entriesAt(block, "rules")) {
      if (!key.startsWith(PREFIX)) continue;
      const entry = { files, key, value: JSON.stringify(value) };
      overrides.set(`${files} ${key} ${entry.value}`, entry);
    }
  }

  return { rules, overrides };
}

function compareLandmines(
  base: Landmines,
  head: Landmines,
  renamed: ReadonlyMap<string, string>,
): readonly Finding[] {
  if (base.rules.size === 0 && base.overrides.size === 0) return [];
  const problems: string[] = [];

  for (const [key, rule] of base.rules) {
    const now = head.rules.get(key);
    if (now === undefined) {
      problems.push(`${key} is set on the base and missing here`);
      continue;
    }
    if (RANK[now.severity] < RANK[rule.severity]) {
      problems.push(`${key} is ${rule.severity} on the base and ${now.severity} here`);
      continue;
    }
    if (rule.severity === "off") continue;
    for (const [path, count] of now.allow) {
      const previous = renamed.get(path);
      const was =
        rule.allow.get(path) ?? (previous === undefined ? undefined : rule.allow.get(previous));
      if (was === undefined) problems.push(`${key}: ${path} is not on the base's allow map`);
      else if (count > was)
        problems.push(`${key}: ${path} is allowed ${count}, up from ${was} on the base`);
    }
  }

  for (const [id, { files, key, value }] of head.overrides) {
    if (!base.overrides.has(id)) {
      problems.push(`an override for ${files} sets ${key} to ${value}, which the base does not`);
    }
  }
  for (const [id, { files, key, value }] of base.overrides) {
    if (!head.overrides.has(id)) {
      problems.push(
        `the base's override for ${files} sets ${key} to ${value}, and no override here does`,
      );
    }
  }

  return problems.map((problem) => ({ problem }));
}

/**
 * The base's oxlintrc.json against the head's. `renamed` maps a path git
 * sees as renamed to the path it had on the base.
 */
export function compareConfigs(
  baseText: string,
  headText: string,
  renamed: ReadonlyMap<string, string>,
): readonly Finding[] {
  return compareLandmines(readLandmines(baseText), readLandmines(headText), renamed);
}

/** An allow key is live when a tracked path equals it or ends with "/" and it, as the rules match. */
function findDeadKeys(head: Landmines, tracked: readonly string[]): readonly Finding[] {
  const problems: string[] = [];
  for (const [key, rule] of head.rules) {
    for (const path of rule.allow.keys()) {
      if (!tracked.some((file) => file === path || file.endsWith(`/${path}`))) {
        problems.push(`${key}: ${path} matches no tracked file`);
      }
    }
  }
  return problems.map((problem) => ({ problem }));
}

function findDisableComments(diff: string): readonly Finding[] {
  const problems: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(line.startsWith("+++ b/") ? 6 : 4);
    else if (line.startsWith("+") && DISABLE_COMMENT.test(line)) {
      problems.push(`${file} adds "${line.slice(1).trim()}"`);
    }
  }
  return problems.map((problem) => ({ problem }));
}

/** `git diff -M --name-status -z`: new path → base path, for every rename. */
function renamesOf(output: string): ReadonlyMap<string, string> {
  const fields = output.split("\0");
  const renamed = new Map<string, string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index + 1] ?? "";
      const to = fields[index + 2] ?? "";
      if (status.startsWith("R")) renamed.set(to, from);
      index += 3;
    } else {
      index += 2;
    }
  }
  return renamed;
}

function git(args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: result.success, stdout: result.stdout.toString() };
}

const err = (line: string): void => void process.stderr.write(`${line}\n`);

function fail(message: string): never {
  err(`❌ check-landmines-allowlist: ${message}`);
  process.exit(2);
}

function parse(text: string, where: string): Landmines {
  try {
    return readLandmines(text);
  } catch (error) {
    return fail(
      `cannot parse ${CONFIG} ${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--base");
  const baseRef = flag === -1 ? undefined : process.argv[flag + 1];
  if (baseRef === undefined || baseRef === "")
    fail("usage: check-landmines-allowlist.ts --base <ref>");

  const headFile = Bun.file(CONFIG);
  if (!(await headFile.exists()))
    fail(`cannot read ${CONFIG} in the working tree; run from the repository root`);
  const head = parse(await headFile.text(), "in the working tree");

  const baseShow = git(["show", `${baseRef}:${CONFIG}`]);
  if (!baseShow.ok) fail(`cannot read ${CONFIG} at ${baseRef}`);
  const base = parse(baseShow.stdout, `at ${baseRef}`);

  const tracked = git(["ls-files", "-z"]);
  if (!tracked.ok) fail("git ls-files failed; run from the repository root");
  const findings = [...findDeadKeys(head, tracked.stdout.split("\0").filter(Boolean))];

  if (base.rules.size > 0 || base.overrides.size > 0) {
    const renames = git(["diff", "-M", "--name-status", "-z", "--no-ext-diff", baseRef]);
    const added = git([
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      baseRef,
      "--",
      ...CODE_FILES,
    ]);
    if (!renames.ok || !added.ok) fail(`git diff against ${baseRef} failed`);
    findings.push(...compareLandmines(base, head, renamesOf(renames.stdout)));
    findings.push(...findDisableComments(added.stdout));
  }

  if (findings.length > 0) {
    err(`❌ check-landmines-allowlist: ${CONFIG} loosens a landmines rule against ${baseRef}.`);
    for (const { problem } of findings) err(`   ${problem}`);
    err("");
    err("   An allow count only falls: fix the new sites instead of raising it, and");
    err("   lower or remove an entry once its file has fewer. A rule the base sets");
    err("   stays at error, with no override or disable comment. Loosening one is");
    err("   the owner's call, in a pull request that changes this guard.");
    process.exit(1);
  }

  process.stdout.write(`✅ check-landmines-allowlist: ${CONFIG} passes against ${baseRef}.\n`);
}
