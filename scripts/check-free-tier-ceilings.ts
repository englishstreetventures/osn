#!/usr/bin/env bun
/**
 * Watch the Cloudflare free-tier counters and file one issue when a day gets
 * near a ceiling.
 *
 * `wiki/runbooks/free-tier-limits.md` used to list these ceilings and say to
 * watch them, which meant a person opening a dashboard. Nobody did, so the D1
 * rows-written ceiling was crossed on 2026-08-30 and again on 2026-09-09 and
 * was only found by hand on 2026-09-10 (xchromo/osn#979).
 *
 * Read-only. It asks Cloudflare's GraphQL analytics API for per-day, per-
 * database and per-script totals, compares each day against its ceiling, and
 * writes the result into one GitHub issue that it reopens and edits rather
 * than filing again. A week spent near the line is one thread.
 *
 * Everything above the CLI block is pure: feed it a parsed API response and a
 * database-name map, get back the breaches and the issue body. The CLI block
 * is the only part that makes a network call, shells out to `gh`, or sets an
 * exit code.
 *
 * Fails loudly. Any bad response — a non-2xx, a GraphQL error, an account the
 * token cannot see, a field that is not a number — throws. A watcher that
 * reports all-clear when it is broken is worse than no watcher.
 */

// The Cloudflare free-tier ceilings. The first three are daily and reset at UTC
// midnight; the last two are running totals. Four are account-wide, across every
// Worker and every database. `d1DatabaseBytes` is the exception — it binds one
// database on its own, and it is the storage ceiling that arrives first: at
// 480 MB a database has stopped taking writes while the account total is still
// a tenth of its 5 GB.
//
// These are the documented limits as of 2026-09-10 and they WILL drift.
// Re-read Cloudflare's own pages before acting on a figure here —
// https://developers.cloudflare.com/workers/platform/pricing/,
// https://developers.cloudflare.com/d1/platform/pricing/ and
// https://developers.cloudflare.com/d1/platform/limits/ (which is where the
// two storage figures live). The same numbers are in
// `wiki/runbooks/free-tier-limits.md` and have to move with these.
//
// Storage uses decimal megabytes and gigabytes, which is how Cloudflare prices
// it. Were they binary the true ceilings would be larger, so this errs toward
// warning early.
export const CEILINGS = {
  d1RowsWritten: 100_000,
  d1RowsRead: 5_000_000,
  workersRequests: 100_000,
  d1StorageBytes: 5_000_000_000,
  d1DatabaseBytes: 500_000_000,
} as const;

/** Report a counter once it reaches this share of its ceiling. */
export const WARN_FRACTION = 0.8;

/**
 * The title the issue is found by. Stable, because it is the key: change it
 * and the next run opens a second issue beside the one already open.
 */
export const ISSUE_TITLE = "Cloudflare free tier: a daily counter is near its ceiling";

/**
 * Labels for the issue when this opens it. Every one exists in `xchromo/osn`
 * today — `gh issue create` fails on a label that does not, which is the
 * failure we want rather than an unlabelled issue.
 */
export const ISSUE_LABELS = [
  "area:ops",
  "product:shared",
  "complexity:2",
  "complexity:unconfirmed",
];

/** The org issue type. Acting on a ceiling is work to schedule, not a defect. */
export const ISSUE_TYPE = "Task";

/** One `d1AnalyticsAdaptiveGroups` group, grouped by database and day. */
export interface D1Group {
  readonly dimensions: { readonly databaseId: string; readonly date: string };
  readonly sum: {
    readonly rowsRead: number;
    readonly rowsWritten: number;
    readonly readQueries: number;
    readonly writeQueries: number;
  };
}

/** One `workersInvocationsAdaptive` group, grouped by script and day. */
export interface WorkerGroup {
  readonly dimensions: { readonly scriptName: string; readonly date: string };
  readonly sum: { readonly requests: number };
}

/** One `d1StorageAdaptiveGroups` group — the day's high-water size per database. */
export interface StorageGroup {
  readonly dimensions: { readonly databaseId: string; readonly date: string };
  readonly max: { readonly databaseSizeBytes: number };
}

/** The three datasets one query returns, already narrowed to the account. */
export interface Usage {
  readonly d1: readonly D1Group[];
  readonly workers: readonly WorkerGroup[];
  readonly storage: readonly StorageGroup[];
}

/** A named part of one day's total — a database, or a Worker script. */
export interface Contributor {
  readonly name: string;
  readonly amount: number;
  /** A second figure printed beside the amount, where the dataset has one. */
  readonly note?: string;
}

/** One counter, on one day, at or above the warning share of its ceiling. */
export interface Breach {
  readonly counter: string;
  readonly day: string;
  readonly used: number;
  readonly ceiling: number;
  /** How the amounts are written — rows, requests or bytes. */
  readonly unit: "count" | "bytes";
  /** What made up the total, largest first. Empty only if the API returned none. */
  readonly contributors: readonly Contributor[];
  /** Heading for the contributors' `note` column, where they carry one. */
  readonly noteHeader?: string;
}

/** The share of its ceiling a breach has used, as a fraction. */
export function fraction(breach: Breach): number {
  return breach.used / breach.ceiling;
}

function percent(breach: Breach): string {
  return `${Math.round(fraction(breach) * 100)}%`;
}

/**
 * A database's name, falling back to its id.
 *
 * The fallback is a display concern only — a run whose name lookup failed
 * outright never reaches here, because `listDatabases` throws. This covers the
 * narrower case of a database created between the two calls.
 */
function databaseName(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? id;
}

function byAmountDescending(a: Contributor, b: Contributor): number {
  return b.amount - a.amount;
}

/** Group daily totals by day, keeping each contributor's share of the day. */
function accumulate(
  rows: readonly { day: string; name: string; amount: number; note?: string }[],
): Map<string, Contributor[]> {
  const days = new Map<string, Contributor[]>();
  for (const row of rows) {
    const day = days.get(row.day) ?? [];
    day.push({ name: row.name, amount: row.amount, note: row.note });
    days.set(row.day, day);
  }
  return days;
}

function breachesFor(
  counter: string,
  ceiling: number,
  unit: "count" | "bytes",
  days: ReadonlyMap<string, Contributor[]>,
  noteHeader?: string,
): Breach[] {
  const found: Breach[] = [];
  for (const [day, contributors] of days) {
    const used = contributors.reduce((total, c) => total + c.amount, 0);
    if (used < ceiling * WARN_FRACTION) continue;
    found.push({
      counter,
      day,
      used,
      ceiling,
      unit,
      contributors: contributors.toSorted(byAmountDescending),
      noteHeader,
    });
  }
  return found;
}

/**
 * The latest day the storage dataset reports. Storage is a running total, not
 * a daily one, so only the newest reading says anything about the ceiling.
 */
function latestDay(groups: readonly StorageGroup[]): string | undefined {
  let latest: string | undefined;
  for (const group of groups) {
    if (latest === undefined || group.dimensions.date > latest) latest = group.dimensions.date;
  }
  return latest;
}

/**
 * Every counter at or above the warning share of its ceiling, worst first.
 *
 * All but one are account-wide, so the total compared is the sum across every
 * database or script for that day, and the contributors are what makes the
 * figure actionable. The exception is a single database's size, which binds
 * each database on its own and so is checked once per database.
 */
export function findBreaches(usage: Usage, names: ReadonlyMap<string, string>): readonly Breach[] {
  const written = accumulate(
    usage.d1.map((g) => ({
      day: g.dimensions.date,
      name: databaseName(g.dimensions.databaseId, names),
      amount: g.sum.rowsWritten,
      note: g.sum.writeQueries.toLocaleString("en-US"),
    })),
  );
  const read = accumulate(
    usage.d1.map((g) => ({
      day: g.dimensions.date,
      name: databaseName(g.dimensions.databaseId, names),
      amount: g.sum.rowsRead,
      note: g.sum.readQueries.toLocaleString("en-US"),
    })),
  );
  const requests = accumulate(
    usage.workers.map((g) => ({
      day: g.dimensions.date,
      name: g.dimensions.scriptName,
      amount: g.sum.requests,
    })),
  );

  const newest = latestDay(usage.storage);
  const sizes = usage.storage
    .filter((g) => g.dimensions.date === newest)
    .map((g) => ({
      day: g.dimensions.date,
      name: databaseName(g.dimensions.databaseId, names),
      amount: g.max.databaseSizeBytes,
    }));

  // Two ceilings over the same rows. The account one sums them; the per-database
  // one weighs each alone, so its counter carries the database's name — the
  // heading has to say which database, not that one of seven is full.
  const storage = accumulate(sizes);
  const perDatabase = sizes.flatMap((size) =>
    breachesFor(
      `D1 database size: ${size.name}`,
      CEILINGS.d1DatabaseBytes,
      "bytes",
      accumulate([size]),
    ),
  );

  return [
    ...breachesFor("D1 rows written", CEILINGS.d1RowsWritten, "count", written, "Write queries"),
    ...breachesFor("D1 rows read", CEILINGS.d1RowsRead, "count", read, "Read queries"),
    ...breachesFor("Workers requests", CEILINGS.workersRequests, "count", requests),
    ...breachesFor("D1 storage", CEILINGS.d1StorageBytes, "bytes", storage),
    ...perDatabase,
    // Worst first, and the newer day first where two are equally bad — which
    // is what two runs of the same over-budget job in a week look like.
  ].toSorted((a, b) => fraction(b) - fraction(a) || b.day.localeCompare(a.day));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function amount(value: number, unit: "count" | "bytes"): string {
  return unit === "bytes" ? megabytes(value) : value.toLocaleString("en-US");
}

/** The window a run covered, for the reader who wants to reproduce it. */
export interface Window {
  readonly start: string;
  readonly end: string;
}

/**
 * The issue body. Names the counter, the day, the figure and the databases or
 * scripts that spent it, because "the account is at 82%" tells nobody what to
 * change.
 */
export function renderIssueBody(breaches: readonly Breach[], window: Window, now: string): string {
  const lines: string[] = [];

  lines.push(
    `${breaches.length} Cloudflare free-tier ${breaches.length === 1 ? "counter is" : "counters are"} at or above ${Math.round(WARN_FRACTION * 100)}% of a ceiling.`,
    "",
    `Window ${window.start} to ${window.end} (UTC). Read at ${now}.`,
    "",
  );

  for (const breach of breaches) {
    const spenders = breach.contributors.filter((c) => c.amount > 0);
    const noteHeader = breach.noteHeader;
    lines.push(
      `## ${breach.counter} — ${breach.day}`,
      "",
      `${amount(breach.used, breach.unit)} of ${amount(breach.ceiling, breach.unit)} (${percent(breach)}).`,
      "",
      noteHeader
        ? `| Database or script | Amount | ${noteHeader} |`
        : "| Database or script | Amount |",
      noteHeader ? "|---|---:|---:|" : "|---|---:|",
    );
    for (const c of spenders) {
      const row = `| \`${c.name}\` | ${amount(c.amount, breach.unit)} |`;
      lines.push(noteHeader ? `${row} ${c.note ?? ""} |` : row);
    }
    lines.push("");
  }

  lines.push(
    "The row and request ceilings are daily and account-wide, across every Worker",
    "and every database; they reset at UTC midnight. Storage is a running total,",
    "and has two lines — 5 GB across the account, and 500 MB for any one database.",
    "Past a daily ceiling, D1 queries error and Workers return 429 from the edge,",
    "so both APIs go to 503 or 429 for the rest of the day. A full database stops",
    "taking writes on its own, whatever the account total says.",
    "",
    "What to do: find which job or route spent the rows, and either cut it or move",
    "to Workers Paid. For D1, `bunx wrangler d1 insights <db> --time-period=7d",
    "--sort-by=writes --limit=20 --json` names the query. The ceilings, what breaks",
    "at each, and the upgrade costs are in `wiki/runbooks/free-tier-limits.md`.",
    "",
    "Filed by `.github/workflows/free-tier-ceiling-alert.yml`, which runs",
    "`scripts/check-free-tier-ceilings.ts` once a day and edits this issue in",
    "place. Close it when the numbers are back under the line; a later day over",
    "the line reopens it.",
  );

  return lines.join("\n");
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/**
 * One query for all three datasets.
 *
 * `d1AnalyticsAdaptiveGroups` is the shape the 2026-09-10 investigation used.
 * `workersInvocationsAdaptive` and `d1StorageAdaptiveGroups` were read off the
 * API's own schema — `sum { requests }` and `max { databaseSizeBytes }` are
 * the fields it declares, not guesses.
 *
 * Asking for `date` alone as the time dimension collapses the hours the filter
 * selects into one row per day per database or script, which is the figure the
 * ceilings are stated in.
 */
const USAGE_QUERY = `query($acct: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      d1: d1AnalyticsAdaptiveGroups(
        limit: 2000
        filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { databaseId date }
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
      workers: workersInvocationsAdaptive(
        limit: 2000
        filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
      ) {
        dimensions { scriptName date }
        sum { requests }
      }
      storage: d1StorageAdaptiveGroups(
        limit: 2000
        filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { databaseId date }
        max { databaseSizeBytes }
      }
    }
  }
}`;

/**
 * Narrow a GraphQL response to `Usage`, or throw saying what was wrong.
 *
 * Separate from the fetch so the error paths are testable without a network,
 * and so a malformed payload can never be read as an empty one — an empty
 * `Usage` is indistinguishable from a quiet day, and would report all-clear.
 */
export function parseUsage(payload: unknown): Usage {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Cloudflare GraphQL returned a non-object body");
  }

  const body = payload as {
    errors?: readonly { message?: string }[] | null;
    data?: { viewer?: { accounts?: readonly Usage[] } | null } | null;
  };

  if (body.errors && body.errors.length > 0) {
    const messages = body.errors.map((e) => e.message ?? "(no message)").join("; ");
    throw new Error(`Cloudflare GraphQL errors: ${messages}`);
  }

  const accounts = body.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error(
      "Cloudflare GraphQL returned no account. Check CLOUDFLARE_ACCOUNT_ID and that the token can read it.",
    );
  }

  const account = accounts[0];
  // Each dataset must come back as an array, even an empty one. Defaulting a
  // missing key to `[]` would turn a renamed field into a quiet day and report
  // all-clear on a counter nobody is reading any more.
  for (const dataset of ["d1", "workers", "storage"] as const) {
    if (!Array.isArray(account?.[dataset])) {
      throw new TypeError(`Cloudflare GraphQL returned no '${dataset}' array`);
    }
  }
  const usage: Usage = { d1: account.d1, workers: account.workers, storage: account.storage };

  for (const group of usage.d1) {
    assertNumbers("d1AnalyticsAdaptiveGroups", [
      group.sum?.rowsRead,
      group.sum?.rowsWritten,
      group.sum?.readQueries,
      group.sum?.writeQueries,
    ]);
  }
  for (const group of usage.workers) {
    assertNumbers("workersInvocationsAdaptive", [group.sum?.requests]);
  }
  for (const group of usage.storage) {
    assertNumbers("d1StorageAdaptiveGroups", [group.max?.databaseSizeBytes]);
  }

  return usage;
}

function assertNumbers(dataset: string, values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${dataset} returned a non-numeric total (${String(value)})`);
    }
  }
}

/** The UTC day `offset` days back from `now`, as `YYYY-MM-DD`. */
export function utcDay(now: Date, offset: number): string {
  const day = new Date(now.getTime());
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

/**
 * The query window for a run: whole UTC days, ending with `end`.
 *
 * `days` is 2 by default — yesterday, which is complete, and today, which
 * catches an overrun on the day it happens rather than the morning after.
 */
export function windowFor(end: string, days: number): Window {
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(endDate.getTime())) throw new Error(`Not a date: ${end}`);
  return { start: utcDay(endDate, days - 1), end };
}

async function fetchUsage(token: string, account: string, window: Window): Promise<Usage> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: USAGE_QUERY,
      variables: {
        acct: account,
        start: `${window.start}T00:00:00Z`,
        end: `${window.end}T23:00:00Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Cloudflare GraphQL returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }

  return parseUsage(await response.json());
}

/** Database id to name, so the issue body can say `cire-db-dev` and not a uuid. */
async function listDatabases(token: string, account: string): Promise<ReadonlyMap<string, string>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?per_page=100`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Cloudflare D1 list returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }

  const body = (await response.json()) as {
    success?: boolean;
    result?: readonly { uuid?: string; name?: string }[] | null;
  };
  if (body.success !== true || !Array.isArray(body.result)) {
    throw new Error("Cloudflare D1 list did not succeed");
  }

  const names = new Map<string, string>();
  for (const database of body.result) {
    if (database.uuid && database.name) names.set(database.uuid, database.name);
  }
  return names;
}

type Run = (args: readonly string[]) => Promise<string>;

const gh: Run = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`gh ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
  return stdout;
};

/** What the run should do with the issue, given what the search found. */
export type IssueAction =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly number: number }
  | { readonly kind: "reopen"; readonly number: number };

/** The issue the search matched, if any. */
export interface ExistingIssue {
  readonly number: number;
  readonly state: string;
}

/**
 * Pick the action. An open issue is edited in place so a week near the line
 * stays one thread; a closed one is reopened, which is the signal that the
 * counter went back over after someone had dealt with it.
 */
export function planIssueAction(existing: ExistingIssue | undefined): IssueAction {
  if (!existing) return { kind: "create" };
  return existing.state.toUpperCase() === "OPEN"
    ? { kind: "edit", number: existing.number }
    : { kind: "reopen", number: existing.number };
}

/** The one issue whose title matches exactly, newest first, or undefined. */
export function matchIssue(listJson: string, title: string): ExistingIssue | undefined {
  const issues = JSON.parse(listJson) as readonly {
    number: number;
    title: string;
    state: string;
  }[];
  return issues.find((issue) => issue.title === title);
}

async function syncIssue(run: Run, repo: string, body: string): Promise<string> {
  const listed = await run([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    "100",
    "--search",
    `${ISSUE_TITLE} in:title`,
    "--json",
    "number,title,state",
  ]);
  const action = planIssueAction(matchIssue(listed, ISSUE_TITLE));

  const bodyFile = `${process.env.RUNNER_TEMP ?? "."}/free-tier-ceiling-body.md`;
  await Bun.write(bodyFile, body);

  if (action.kind === "create") {
    const url = await run([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      ISSUE_TITLE,
      "--type",
      ISSUE_TYPE,
      "--label",
      ISSUE_LABELS.join(","),
      "--body-file",
      bodyFile,
    ]);
    return `opened ${url.trim()}`;
  }

  const number = String(action.number);
  if (action.kind === "reopen") {
    await run([
      "issue",
      "reopen",
      number,
      "--repo",
      repo,
      "--comment",
      "A counter is over the line again. The body below has the current figures.",
    ]);
  }
  await run(["issue", "edit", number, "--repo", repo, "--body-file", bodyFile]);
  return `${action.kind === "reopen" ? "reopened and updated" : "updated"} ${repo}#${number}`;
}

function flag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (Bun.argv[index + 1] ?? fallback);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

if (import.meta.main) {
  const now = new Date();
  const end = flag("end", utcDay(now, 0));
  const days = Number(flag("days", "2"));
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
  const window = windowFor(end, days);

  const token = required("CLOUDFLARE_API_TOKEN");
  const account = required("CLOUDFLARE_ACCOUNT_ID");

  const [usage, names] = await Promise.all([
    fetchUsage(token, account, window),
    listDatabases(token, account),
  ]);
  const breaches = findBreaches(usage, names);

  if (breaches.length === 0) {
    console.log(
      `free-tier ceilings: clear for ${window.start} to ${window.end} — nothing at ${Math.round(WARN_FRACTION * 100)}% of a ceiling.`,
    );
    process.exit(0);
  }

  const body = renderIssueBody(breaches, window, `${now.toISOString().slice(0, 19)}Z`);

  for (const breach of breaches) {
    console.log(
      `free-tier ceilings: ${breach.counter} on ${breach.day} at ${percent(breach)} of its ceiling.`,
    );
  }

  if (Bun.argv.includes("--dry-run")) {
    console.log(`\n--- ${ISSUE_TITLE} ---\n${body}`);
    process.exit(0);
  }

  console.log(await syncIssue(gh, flag("repo", "xchromo/osn"), body));
}
