#!/usr/bin/env bun
/**
 * Fail when a pre-push `bun audit --ignore` in `lefthook.yml` has no expiry,
 * or has outlived one.
 *
 * An `--ignore` silences an advisory for every path to the package, not only
 * the paths checked on the day it was added. If a deployed Worker later gains
 * a dependency on the package, or a parent starts calling the flawed function,
 * the audit stays green and nobody looks again. So every ignored id carries a
 * marker in a `lefthook.yml` comment:
 *
 *   # DROP AFTER <GHSA id> <YYYY-MM-DD>
 *
 * dated no more than 90 days out. Once the date passes the hook fails, and
 * someone repeats the reachability check, then removes the flag or moves the
 * date. The shape is the one `scripts/check-release-age-excludes.ts` applies to
 * `bunfig.toml`'s `minimumReleaseAgeExcludes`.
 *
 * Three more ways an ignore escapes review, each a finding here:
 *
 * - an id that is not a whole GHSA id: bun matches `--ignore` against any part
 *   of the advisory URL, so `--ignore=GHSA-` silences every advisory;
 * - a `#` inside the folded `run: >` block: YAML folds it into the command,
 *   and the shell then drops every flag after it as a comment;
 * - no pre-push command running `bun audit` at all, or one set to `skip`: a
 *   renamed command would otherwise leave this check passing on nothing.
 *
 * Run by the `audit-ignores` pre-push command in `lefthook.yml` and by the
 * `script-tests` job in `.github/workflows/ci.yml`. Tests in
 * `scripts/tests/check-audit-ignores.test.ts` and `.cli.test.ts`.
 */

const MARKER = /^#\s*DROP AFTER\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/;

/** GitHub's advisory ids: three groups of four from this 20-character set. */
const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** A longer exception needs a renewal commit, which is a review point. */
const MAX_IGNORE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Finding = {
  readonly name: string;
  readonly problem: string;
};

export type AuditCommand = {
  /** `commands.<name>` or `jobs[<index>]`, for the finding text. */
  readonly where: string;
  readonly run: string;
  readonly skip: unknown;
};

type HookEntry = { readonly run?: unknown; readonly skip?: unknown };
type Hook = {
  readonly commands?: Readonly<Record<string, HookEntry | null>>;
  readonly jobs?: readonly (HookEntry | null)[];
};

/** `9999-99-99` matches the marker regex, and `Date` rolls an out-of-range day
 * into the next month rather than rejecting it, so the date must survive a
 * round trip unchanged. */
function isValidCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Every pre-push command or job whose `run` invokes `bun audit`, with the
 * command string as YAML hands it to the shell. */
export function auditCommands(yamlText: string): readonly AuditCommand[] {
  const parsed = (Bun.YAML.parse(yamlText) ?? {}) as Record<string, Hook | null>;
  const hook = parsed["pre-push"] ?? {};
  const found: AuditCommand[] = [];

  for (const [name, entry] of Object.entries(hook.commands ?? {})) {
    if (typeof entry?.run === "string" && entry.run.includes("bun audit")) {
      found.push({ where: `commands.${name}`, run: entry.run, skip: entry.skip });
    }
  }

  (hook.jobs ?? []).forEach((entry, index) => {
    if (typeof entry?.run === "string" && entry.run.includes("bun audit")) {
      found.push({ where: `jobs[${index}]`, run: entry.run, skip: entry.skip });
    }
  });

  return found;
}

/** The `--ignore` values in one command, in both `--ignore=<id>` and
 * `--ignore <id>` forms. `null` marks a flag with no value. */
function ignoredIds(run: string): readonly (string | null)[] {
  const tokens = run.split(/\s+/).filter(Boolean);
  const ids: (string | null)[] = [];

  tokens.forEach((token, index) => {
    if (token.startsWith("--ignore=")) {
      const value = token.slice("--ignore=".length);
      ids.push(value === "" ? null : value);
    } else if (token === "--ignore") {
      const next = tokens[index + 1];
      ids.push(next === undefined || next.startsWith("-") ? null : next);
    }
  });

  return ids;
}

/** Every `# DROP AFTER <id> <date>` marker in the file, keyed by id. Placement
 * is not load-bearing: the markers sit in the comment block above `run:`,
 * because inside the folded block a `#` line is part of the command. */
function markers(yamlText: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();

  for (const line of yamlText.split("\n")) {
    const match = MARKER.exec(line.trim());
    if (match) found.set(match[1]!, match[2]!);
  }

  return found;
}

export function checkAuditIgnores(yamlText: string, now: Date = new Date()): readonly Finding[] {
  const commands = auditCommands(yamlText);
  const marked = markers(yamlText);
  const today = now.toISOString().slice(0, 10);
  const findings: Finding[] = [];

  if (commands.length === 0) {
    findings.push({
      name: "pre-push",
      problem: "no pre-push command runs `bun audit` — renamed or removed?",
    });
  }

  for (const { where, run, skip } of commands) {
    if (skip !== undefined && skip !== false) {
      findings.push({
        name: where,
        problem: `the audit is set to skip (${JSON.stringify(skip)}); remove the key`,
      });
    }

    if (run.includes("#")) {
      findings.push({
        name: where,
        problem:
          "the command contains a `#`; the shell drops every flag after it — keep comments above `run:`",
      });
    }

    for (const id of ignoredIds(run)) {
      if (id === null) {
        findings.push({ name: where, problem: "an `--ignore` flag has no value" });
        continue;
      }

      if (!GHSA_ID.test(id)) {
        findings.push({
          name: id,
          problem: `not a full GHSA id (GHSA-xxxx-xxxx-xxxx); bun matches --ignore against any part of the advisory URL`,
        });
        continue;
      }

      const dropDate = marked.get(id);

      if (dropDate === undefined) {
        findings.push({
          name: id,
          problem: `no "# DROP AFTER ${id} <YYYY-MM-DD>" marker comment found`,
        });
        continue;
      }

      if (!isValidCalendarDate(dropDate)) {
        findings.push({
          name: id,
          problem: `"DROP AFTER ${id} ${dropDate}" is not a real calendar date (want YYYY-MM-DD)`,
        });
        continue;
      }

      // Valid through the named date, expired the day after.
      if (dropDate < today) {
        findings.push({
          name: id,
          problem: `"DROP AFTER ${id} ${dropDate}" has passed (today is ${today})`,
        });
        continue;
      }

      const daysOut = Math.round(
        (Date.parse(`${dropDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
      );
      if (daysOut > MAX_IGNORE_DAYS) {
        findings.push({
          name: id,
          problem: `"DROP AFTER ${id} ${dropDate}" is ${daysOut} days out, more than the ${MAX_IGNORE_DAYS}-day maximum`,
        });
      }
    }
  }

  return findings;
}

if (import.meta.main) {
  const path = "lefthook.yml";
  const file = Bun.file(new URL(`../${path}`, import.meta.url));

  if (!(await file.exists())) {
    process.stderr.write(`❌ check-audit-ignores: ${path} not found\n`);
    process.exit(1);
  }

  const findings = checkAuditIgnores(await file.text());

  if (findings.length > 0) {
    process.stderr.write(
      [
        `❌ check-audit-ignores: ${path} failed the audit-ignore guard.`,
        ...findings.map(({ name, problem }) => `   ${name} — ${problem}`),
        "",
        "   For an expired or missing marker: repeat the reachability check in the comment",
        "   above `audit` in lefthook.yml. If it still holds, set a new",
        `   "# DROP AFTER <GHSA id> <YYYY-MM-DD>" marker no more than ${MAX_IGNORE_DAYS} days out;`,
        "   if it fails, remove the --ignore flag and its paragraph.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  process.stdout.write(`✅ check-audit-ignores: ${path} passes the audit-ignore guard.\n`);
}
