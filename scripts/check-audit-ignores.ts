#!/usr/bin/env bun
/**
 * Fail when a pre-push `bun audit --ignore` in `lefthook.yml` has no expiry,
 * has outlived one, or when the audit command could be changed without
 * looking changed.
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
 * A date only holds if the command it dates is the command that runs, so the
 * file around it is held to one shape:
 *
 * - `pre-push.commands.audit.run`, whitespace collapsed, is exactly
 *   `bun audit --audit-level=high` followed by nothing but
 *   `--ignore=<GHSA id>` flags. A quote, `$`, backtick, brace, pipe, `;`, `&`
 *   or `#` would let the shell run something else, or drop flags after a
 *   comment, while the flags still read right; and bun matches `--ignore`
 *   against any part of the advisory URL, so `--ignore=GHSA-` silences every
 *   advisory.
 * - The audit entry carries only `run`, and the `pre-push` hook only
 *   `parallel` and `commands`: lefthook's `skip`, `only`, `glob`, `files`,
 *   `env`, `exclude_tags` and the rest can each stop the audit or change what
 *   it runs.
 * - No top-level `extends`, `remotes`, `rc` or `templates`, each of which can
 *   replace the command from outside this file.
 *
 * Run by the `audit-ignores` pre-push command in `lefthook.yml` and by the
 * `script-tests` job in `.github/workflows/ci.yml`. Tests in
 * `scripts/tests/check-audit-ignores.test.ts` and `.cli.test.ts`.
 */

const MARKER = /^#\s*DROP AFTER\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/;

/** The one form the audit command may take. GitHub's advisory ids are three
 * groups of four from a 20-character set. */
const AUDIT_FORM = /^bun audit --audit-level=high( --ignore=GHSA(-[23456789cfghjmpqrvwx]{4}){3})*$/;

const DENIED_TOP_LEVEL = ["extends", "remotes", "rc", "templates"] as const;
const PRE_PUSH_KEYS = new Set(["parallel", "commands"]);
const AUDIT_KEYS = new Set(["run"]);

/** A longer exception needs a renewal commit, which is a review point. */
const MAX_IGNORE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Finding = {
  readonly name: string;
  readonly problem: string;
};

/** The parts of `lefthook.yml` this check reads. Every value is checked with
 * `isMapping` or `typeof` before it is used. */
interface AuditEntry {
  readonly run?: unknown;
}
interface PrePushHook {
  readonly commands?: { readonly audit?: AuditEntry | null } | null;
}
interface LefthookFile {
  readonly "pre-push"?: PrePushHook | null;
}

/** A YAML mapping, as opposed to a list, a scalar or nothing. */
function isMapping(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed file, or `null` when it is not a mapping at all. */
function readLefthook(yamlText: string): LefthookFile | null {
  const parsed: unknown = Bun.YAML.parse(yamlText);

  return isMapping(parsed) ? (parsed as LefthookFile) : null;
}

/** `9999-99-99` matches the marker regex, and `Date` rolls an out-of-range day
 * into the next month rather than rejecting it, so the date must survive a
 * round trip unchanged. */
function isValidCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** The `pre-push` `audit` command as the shell receives it, whitespace
 * collapsed, or `null` when there is none. */
export function auditCommand(yamlText: string): string | null {
  const hook = readLefthook(yamlText)?.["pre-push"];
  const commands = isMapping(hook) ? hook.commands : undefined;
  const audit = isMapping(commands) ? commands.audit : undefined;
  const run = isMapping(audit) ? audit.run : undefined;

  return typeof run === "string" ? run.trim().split(/\s+/).join(" ") : null;
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

/** Keys anywhere in the file that could stop or change the audit command. */
function hookKeyFindings(parsed: LefthookFile | null): Finding[] {
  if (parsed === null) return [{ name: "lefthook.yml", problem: "not a YAML mapping" }];

  const findings: Finding[] = [];

  for (const key of DENIED_TOP_LEVEL) {
    if (key in parsed) {
      findings.push({
        name: key,
        problem: `top-level \`${key}\` can change the audit command from outside this file; remove it`,
      });
    }
  }

  const hook = parsed["pre-push"];
  if (!isMapping(hook)) return [...findings, { name: "pre-push", problem: "no pre-push hook" }];

  for (const key of Object.keys(hook)) {
    if (!PRE_PUSH_KEYS.has(key)) {
      findings.push({
        name: `pre-push.${key}`,
        problem: `\`pre-push.${key}\` can stop or change the audit; the hook may carry only \`parallel\` and \`commands\``,
      });
    }
  }

  const audit = isMapping(hook.commands) ? hook.commands.audit : undefined;
  if (!isMapping(audit))
    return [...findings, { name: "pre-push", problem: "no pre-push `audit` command" }];

  for (const key of Object.keys(audit)) {
    if (!AUDIT_KEYS.has(key)) {
      findings.push({
        name: `commands.audit.${key}`,
        problem: `\`commands.audit.${key}\` can stop or change the audit; it may carry only \`run\``,
      });
    }
  }

  return findings;
}

export function checkAuditIgnores(yamlText: string, now: Date = new Date()): readonly Finding[] {
  const findings = hookKeyFindings(readLefthook(yamlText));
  const command = auditCommand(yamlText);
  if (command === null) return findings;

  if (!AUDIT_FORM.test(command)) {
    return [
      ...findings,
      {
        name: "commands.audit.run",
        problem: `the audit command must be exactly "bun audit --audit-level=high" followed only by --ignore=<GHSA id> flags; found ${JSON.stringify(command)}`,
      },
    ];
  }

  const marked = markers(yamlText);
  const today = now.toISOString().slice(0, 10);
  const ids = command
    .split(" ")
    .filter((token) => token.startsWith("--ignore="))
    .map((token) => token.slice("--ignore=".length));

  for (const id of ids) {
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
