#!/usr/bin/env bun
/**
 * CI guard: fail the build if an entry in `bunfig.toml`'s
 * `install.minimumReleaseAgeExcludes` has no expiry, or has outlived one.
 *
 * The bug class this guards against: `minimumReleaseAge` makes every install
 * wait out a soak window before a fresh publish can land, so a compromised
 * publish has days to get caught before this repo installs it. An entry in
 * `minimumReleaseAgeExcludes` is a deliberate hole in that — some package
 * needs the newest release right now. That is fine as a temporary exception
 * and a permanent hole otherwise: prose above the array ("drop this once X
 * clears") is not read by anything, so the entry survives the reason it was
 * added and quietly exempts every future publish of that package name from
 * the gate forever.
 *
 * The fix is a machine-readable marker, one per excluded name, living
 * anywhere in a `bunfig.toml` comment:
 *
 *   # DROP AFTER <package-name> <YYYY-MM-DD>
 *
 * `<package-name>` must match the exclude list entry exactly. This script
 * fails when an excluded name has no such marker, or when the marker's date
 * has passed — in both cases the fix is the same: remove the name from
 * `minimumReleaseAgeExcludes` (or add/renew the marker if the exception is
 * still live) and, in the removed-entry style already used in this file,
 * record why it went.
 */

const MARKER = /^#\s*DROP AFTER\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/;

// The 3-day soak window `minimumReleaseAge` itself must never drop below —
// see the S-M2 check below.
const MIN_RELEASE_AGE_SECONDS = 259200;

// Ten times the 3-day soak window an exclude suspends. A longer exception
// needs a renewal commit, which is a review point in its own right.
const MAX_EXCLUDE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Finding = {
  readonly name: string;
  readonly problem: string;
};

type BunfigInstall = {
  readonly minimumReleaseAge?: unknown;
  readonly minimumReleaseAgeExcludes?: readonly unknown[];
};
type Bunfig = { readonly install?: BunfigInstall };

/**
 * True only for a string that is both shaped like `YYYY-MM-DD` and names a
 * real calendar date — `9999-99-99` matches the marker regex but is not a
 * date, and `Date` silently rolls an out-of-range day/month into the next
 * one instead of rejecting it, so the check is a round trip: format the
 * parsed date back out and require it to match the input exactly.
 */
function isValidCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Every `# DROP AFTER <name> <date>` marker in the file, keyed by name. The
 * marker only needs to appear somewhere in the comment block above the
 * excludes array — this scans every line, not just the ones immediately
 * preceding it, so marker order or placement is not load-bearing.
 */
function markers(toml: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();

  for (const rawLine of toml.split("\n")) {
    const match = MARKER.exec(rawLine.trim());
    if (match) found.set(match[1]!, match[2]!);
  }

  return found;
}

export function checkReleaseAgeExcludes(toml: string, now: Date = new Date()): readonly Finding[] {
  const parsed = Bun.TOML.parse(toml) as Bunfig;
  const install = parsed.install ?? {};
  const excludes = install.minimumReleaseAgeExcludes ?? [];
  const marked = markers(toml);
  const today = now.toISOString().slice(0, 10);
  const findings: Finding[] = [];

  // S-M2: the excludes list is only a hole in the soak window if the soak
  // window itself is intact. Checking the exception without checking the
  // rule lets `minimumReleaseAge` drop to 0 (or vanish) and this guard still
  // reports green. A deliberate change to the constant below is then a
  // visible, reviewable diff — the only way to lower it.
  const { minimumReleaseAge } = install;
  if (typeof minimumReleaseAge !== "number" || minimumReleaseAge < MIN_RELEASE_AGE_SECONDS) {
    findings.push({
      name: "minimumReleaseAge",
      problem: `install.minimumReleaseAge must be a number >= ${MIN_RELEASE_AGE_SECONDS} (3 days); found ${JSON.stringify(minimumReleaseAge)}`,
    });
  }

  for (const entry of excludes) {
    if (typeof entry !== "string") continue; // not this guard's job — bun's own parse rejects a malformed array

    const dropDate = marked.get(entry);

    if (dropDate === undefined) {
      findings.push({
        name: entry,
        problem: `no "# DROP AFTER ${entry} <YYYY-MM-DD>" marker comment found`,
      });
      continue;
    }

    // S-M1: the marker was regex-matched, not parsed — "9999-99-99" matches
    // \d{4}-\d{2}-\d{2} and then sorts above every real date as a string,
    // never getting flagged as expired. Round-trip it through `Date` instead.
    if (!isValidCalendarDate(dropDate)) {
      findings.push({
        name: entry,
        problem: `"DROP AFTER ${entry} ${dropDate}" is not a real calendar date (want YYYY-MM-DD)`,
      });
      continue;
    }

    // The marker reads "DROP AFTER <date>" — the entry is still valid through
    // that date and expired the day after, so today has to be strictly later.
    if (dropDate < today) {
      findings.push({
        name: entry,
        problem: `drop-trigger "DROP AFTER ${entry} ${dropDate}" has passed (today is ${today})`,
      });
      continue;
    }

    // S-M1: an unbounded marker lets "DROP AFTER left-pad 2999-01-01" pass
    // forever. Cap it at ten times the 3-day soak window it suspends — a
    // longer exception needs a renewal commit, which is a review point.
    const daysOut = Math.round(
      (Date.parse(`${dropDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
    );
    if (daysOut > MAX_EXCLUDE_DAYS) {
      findings.push({
        name: entry,
        problem: `drop-trigger "DROP AFTER ${entry} ${dropDate}" is ${daysOut} days out, more than the ${MAX_EXCLUDE_DAYS}-day maximum — renew it closer to the date instead`,
      });
    }
  }

  return findings;
}

if (import.meta.main) {
  const path = "bunfig.toml";
  const file = Bun.file(new URL(`../${path}`, import.meta.url));

  if (!(await file.exists())) {
    console.error(`❌ check-release-age-excludes: ${path} not found`);
    process.exit(1);
  }

  const findings = checkReleaseAgeExcludes(await file.text());

  if (findings.length > 0) {
    console.error(`❌ check-release-age-excludes: ${path} failed the release-age guard.`);
    for (const { name, problem } of findings) console.error(`   ${name} — ${problem}`);
    console.error("");
    console.error("   For an exclude: remove the name from minimumReleaseAgeExcludes (renewing or");
    console.error('   adding a "# DROP AFTER <name> <YYYY-MM-DD>" marker, dated no more than');
    console.error(
      `   ${MAX_EXCLUDE_DAYS} days out, if the exception is still live), and record why in the`,
    );
    console.error(
      "   comment block above it. For minimumReleaseAge itself: restore it to at least",
    );
    console.error(
      `   ${MIN_RELEASE_AGE_SECONDS} (3 days) — lowering the soak window is a decision that belongs in a`,
    );
    console.error("   reviewed PR, not a silent edit.");
    process.exit(1);
  }

  console.log(`✅ check-release-age-excludes: ${path} passes the release-age guard.`);
}
