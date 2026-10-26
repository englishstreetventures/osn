#!/usr/bin/env bun
/**
 * Read the cards back, without needing anything installed.
 *
 * `queries.sql` is the same nine analyses in SQL, and it is the better tool
 * for a question nobody anticipated. It is not the better tool for the common
 * case, because **DuckDB does not exist in a remote session** — none of the
 * `duckdb` npm packages ship a binary (they are all libraries), so `bunx` is no
 * help and there is no `brew` in a cloud container. A report that only runs on
 * one laptop is not a report on how the fleet is doing.
 *
 * So the nine queries live here too, in TypeScript, over the same committed
 * JSON. `--split-at` is TypeScript only: it asks git when a commit landed. That runs in every environment the repository runs in — local, cloud,
 * CI — with no dependency at all. A few hundred small JSON files do not need an
 * OLAP engine; calling the directory a datalake oversold it.
 *
 * The two must agree. When a definition changes, change it in both — the
 * ratios are duplicated on purpose rather than generated, because generating
 * SQL from TypeScript would cost more than it saves at this size.
 */

// Nothing here may statically import a value from `index.ts`: it reads
// `node:fs` at module scope, and `@tools/metrics` imports this file into a
// browser, where Vite's stub for that builtin throws on first property access
// and blanks the page. So `Card` is a type (erased), `compactTokens` comes from
// the import-free `format.ts`, and the one value the CLI block still needs is
// required lazily down there — the same way `loadCards` handles `node:fs`.
import { compactTokens } from "./format.ts";
import type { Card, ReviewSummary } from "./index.ts";

export interface CardRow {
  pr: number | null;
  branch: string;
  at: string;
  mergedAt: string | null;
  phase: string;
  declared: number | null;
  ratingMethod: string;
  usd: number;
  sourceLoc: number;
  sourceFiles: number;
  packages: string[];
  turns: number;
  corrections: number;
  activeSeconds: number;
  totalTokens: number;
  cacheReadShare: number;
  /** `null` when the transcript showed no edit — unknown, not 100%. */
  exploreShare: number | null;
  subagentShare: number;
  firstTs: string | null;
  lastTs: string | null;
  cacheWriteShare: number;
  /** The four below are `null` on cards written before the fields existed. */
  requests: number | null;
  /** Of the calls that used a tool, the share that used exactly one. */
  singleToolShare: number | null;
  contextMedian: number | null;
  review: ReviewSummary | null;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function toRow(card: Card): CardRow {
  const t = card.spend.tokens;
  const total = t.output + t.cache_read + t.cache_write_5m + t.cache_write_1h;
  const calls = card.interaction.requests;

  return {
    pr: card.pr.number,
    branch: card.pr.branch,
    at: card.pr.merged_at ?? card.pr.generated_at,
    mergedAt: card.pr.merged_at,
    phase: card.pr.phase,
    declared: card.complexity.declared,
    ratingMethod: card.complexity.method,
    usd: card.spend.usd_equivalent,
    sourceLoc: card.diff.loc.source.added + card.diff.loc.source.deleted,
    sourceFiles: card.diff.files.source,
    packages: card.diff.packages,
    turns: card.interaction.user_turns,
    corrections: card.interaction.corrective_turns,
    activeSeconds: card.window.active_seconds,
    totalTokens: total,
    cacheReadShare: ratio(t.cache_read, total),
    exploreShare:
      card.interaction.tokens_before_first_edit === null
        ? null
        : ratio(card.interaction.tokens_before_first_edit, total),
    subagentShare: ratio(card.spend.by_actor.subagent.usd_equivalent, card.spend.usd_equivalent),
    firstTs: card.window.first_ts,
    lastTs: card.window.last_ts,
    cacheWriteShare: ratio(t.cache_write_5m + t.cache_write_1h, total),
    requests: calls ? calls.main + calls.subagent : null,
    singleToolShare: calls && calls.with_tools > 0 ? calls.with_one_tool / calls.with_tools : null,
    contextMedian: calls ? calls.context_median : null,
    review: card.review ?? null,
  };
}

/**
 * Merged pull requests, by merge status — never by `phase === "at-merge"`.
 *
 * A remote session's container is destroyed when it ends and takes its
 * transcripts with it, so a remotely-produced card can never be refreshed past
 * `at-open`. Filtering on phase would drop every pull request not worked on a
 * machine you still own, and would look like caution while quietly biasing
 * every number below toward local work.
 */
export function merged(rows: CardRow[]): CardRow[] {
  return rows.filter((row) => row.mergedAt !== null);
}

const monthOf = (iso: string): string => iso.slice(0, 7);

/**
 * Median, not mean, everywhere a per-pull-request distribution is summarised.
 *
 * These distributions are severely right-skewed: across the first 34 cards the
 * median was 3.6M tokens, the mean 15.4M and the maximum 92.7M. A mean over
 * that describes the three biggest pull requests and nothing else, and reading
 * it as a trend invents month-over-month growth that is not there.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function groupBy<K>(rows: CardRow[], key: (row: CardRow) => K): Map<K, CardRow[]> {
  const groups = new Map<K, CardRow[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = groups.get(k);
    if (bucket) bucket.push(row);
    else groups.set(k, [row]);
  }

  return groups;
}

export interface Table {
  title: string;
  note?: string;
  headers: string[];
  rows: string[][];
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const usd = (value: number): string => `$${value.toFixed(2)}`;

/** 1. Where agents cost too much for the job. */
export function waste(rows: CardRow[]): Table {
  const candidates = rows
    .filter(
      (row) =>
        row.declared !== null &&
        row.declared <= 2 &&
        row.sourceLoc < 100 &&
        row.ratingMethod === "confirmed",
    )
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 20);

  return {
    title: "1. Where agents cost too much for the job",
    note: "Small, low-rated, expensive. Unconfirmed ratings excluded — acting on an agent's own guess about difficulty is what would make this circular.",
    headers: ["PR", "declared", "source LOC", "cost", "turns", "corrections"],
    rows: candidates.map((r) => [
      `#${r.pr}`,
      String(r.declared),
      String(r.sourceLoc),
      usd(r.usd),
      String(r.turns),
      String(r.corrections),
    ]),
  };
}

/** 2. Which packages need a skill or a wiki page. */
export function exploration(rows: CardRow[], minPrs = 3): Table {
  // Only cards where an edit was actually observed. A card whose transcript
  // showed no edit has an unknown boundary, not a 100% one — counting those as
  // pure exploration is what made this ranking sort by "which branches avoided
  // the Edit tool" rather than by anything about the packages.
  const byPackage = new Map<string, number[]>();
  let skipped = 0;
  for (const row of rows) {
    if (row.exploreShare === null) {
      skipped += 1;
      continue;
    }

    for (const pkg of row.packages) {
      const bucket = byPackage.get(pkg);
      if (bucket) bucket.push(row.exploreShare);
      else byPackage.set(pkg, [row.exploreShare]);
    }
  }

  const ranked = [...byPackage.entries()]
    .filter(([, shares]) => shares.length >= minPrs)
    .map(([pkg, shares]) => ({ pkg, prs: shares.length, share: median(shares) }))
    .sort((a, b) => b.share - a.share);

  return {
    title: "2. Which packages need a skill or a wiki page",
    note:
      "Share of spend before the first edit — the agent working out where the code lives. High and repeated means that package has no usable map." +
      (skipped > 0
        ? ` ${skipped} card(s) excluded: no edit observed in the transcript, so the boundary is unknown.`
        : ""),
    headers: ["package", "PRs", "explore share"],
    rows: ranked.map((r) => [r.pkg, String(r.prs), pct(r.share)]),
  };
}

/** 3. Are briefs getting clearer? */
export function briefs(rows: CardRow[]): Table {
  const byMonth = groupBy(rows, (row) => monthOf(row.at));

  return {
    title: "3. Are briefs getting clearer?",
    note: "Corrections are turns that arrived after work had started. The one number here that measures the brief rather than the model.",
    headers: ["month", "PRs", "median turns", "median corrections"],
    rows: [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, group]) => [
        month,
        String(group.length),
        median(group.map((r) => r.turns)).toFixed(1),
        median(group.map((r) => r.corrections)).toFixed(1),
      ]),
  };
}

/** 4. Is the context surface bloating? */
export function context(rows: CardRow[]): Table {
  const byMonth = groupBy(rows, (row) => monthOf(row.at));

  return {
    title: "4. Is the context surface bloating?",
    note: "Cache reads are the agent re-reading context. A share climbing month over month means CLAUDE.md, the skills and the wiki are growing faster than the work.",
    headers: ["month", "PRs", "cache-read share", "median tokens"],
    rows: [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, group]) => [
        month,
        String(group.length),
        pct(median(group.map((r) => r.cacheReadShare))),
        compactTokens(Math.round(median(group.map((r) => r.totalTokens)))),
      ]),
  };
}

/** 5. Cost per unit of declared difficulty. A card that closes several issues
 * declares the sum of their ratings, so a value off the 1-2-3-5-8 scale is a
 * row of its own: that many points of declared work, not one issue's rating. */
export function costByComplexity(rows: CardRow[]): Table {
  const rated = rows.filter((row) => row.declared !== null && row.ratingMethod === "confirmed");
  const byDeclared = groupBy(rated, (row) => row.declared as number);

  return {
    title: "5. Cost per unit of declared difficulty",
    note: "A trend, never a target: rating everything an 8 would drive it down, which is why the rating is set before the work.",
    headers: ["declared", "PRs", "median cost", "cost per point", "median active"],
    rows: [...byDeclared.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([declared, group]) => [
        String(declared),
        String(group.length),
        usd(median(group.map((r) => r.usd))),
        usd(median(group.map((r) => r.usd)) / declared),
        `${Math.round(median(group.map((r) => r.activeSeconds)) / 60)}m`,
      ]),
  };
}

/** 6. Is delegation paying off? */
export function delegation(rows: CardRow[]): Table {
  const rated = rows.filter((row) => row.declared !== null && row.ratingMethod === "confirmed");
  const byDeclared = groupBy(rated, (row) => row.declared as number);

  return {
    title: "6. Is delegation paying off?",
    note: "Subagent share against cost at equal difficulty. If delegated PRs are not cheaper, the delegation is re-reading context rather than saving it.",
    headers: ["declared", "PRs", "subagent share", "median cost"],
    rows: [...byDeclared.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([declared, group]) => [
        String(declared),
        String(group.length),
        pct(median(group.map((r) => r.subagentShare))),
        usd(median(group.map((r) => r.usd))),
      ]),
  };
}

/** 7. How much of the history can be trusted. Run this one first. */
export function coverage(rows: CardRow[]): Table {
  const byKey = groupBy(rows, (row) => `${row.ratingMethod} ${row.phase}`);

  return {
    title: "7. Coverage — how much of this can be trusted",
    note: "Read before anything above. A single-digit confirmed count makes every trend noise. Cards from remote sessions stay at-open forever, so an at-open-heavy corpus under-reports true cost.",
    headers: ["rating", "phase", "PRs", "total cost"],
    rows: [...byKey.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, group]) => {
        const [method, phase] = key.split(" ");

        return [method, phase, String(group.length), usd(group.reduce((sum, r) => sum + r.usd, 0))];
      }),
  };
}

const excluded = (n: number, why: string): string =>
  n > 0 ? ` ${n} card(s) excluded: ${why}.` : "";

const atOpen = (rows: CardRow[]): string => {
  const n = rows.filter((row) => row.mergedAt === null).length;

  return n > 0 ? ` ${n} of these are at-open, so their cost misses the review cycle.` : "";
};

/**
 * 8. How many model calls, and how much each one carried.
 *
 * Over every card, merged or not: the field is new, and most cards that carry
 * it are still at-open.
 */
export function requests(rows: CardRow[]): Table {
  const known = rows.filter((row) => row.requests !== null);
  const byMonth = groupBy(known, (row) => monthOf(row.at));

  return {
    title: "8. Model calls and the context each carried",
    note:
      "Cost is calls times context, since each call re-reads the context. A low single-tool share means calls that could have run tools in parallel." +
      excluded(rows.length - known.length, "written before calls were counted") +
      atOpen(known),
    headers: ["month", "PRs", "median calls", "single-tool share", "median context"],
    rows: [...byMonth.entries()]
      .toSorted((a, b) => a[0].localeCompare(b[0]))
      .map(([month, group]) => {
        const shares = group.map((r) => r.singleToolShare).filter((s): s is number => s !== null);

        return [
          month,
          String(group.length),
          median(group.map((r) => r.requests as number)).toFixed(0),
          shares.length > 0 ? pct(median(shares)) : "—",
          compactTokens(Math.round(median(group.map((r) => r.contextMedian as number)))),
        ];
      }),
  };
}

/**
 * Pooled over the given rows: located findings, paired, and three rates —
 * acted on, by line, and the control. By line leaves out the tests findings a
 * landed test counted, so it is counted the way the control is, and the same
 * way on every card: a block from a collector that never counted a test has
 * no such findings to leave out.
 */
function reviewCells(rows: CardRow[]): string[] {
  const reviewed = rows.map((row) => row.review).filter((r): r is ReviewSummary => r !== null);
  const sum = (pick: (r: ReviewSummary) => number) => reviewed.reduce((n, r) => n + pick(r), 0);
  const paired = sum((r) => r.paired);
  const rate = (count: number) => (paired > 0 ? pct(count / paired) : "—");

  return [
    String(sum((r) => r.located)),
    String(paired),
    rate(sum((r) => r.acted_on_paired)),
    rate(sum((r) => r.acted_on_paired - (r.acted_on_paired_by_test ?? 0))),
    rate(sum((r) => r.control_changed)),
  ];
}

/** 9. Did the review findings lead to a change? */
export function review(rows: CardRow[]): Table {
  const reviewed = rows.filter((row) => row.review !== null);

  return {
    title: "9. Review findings that led to a change",
    note:
      "Tests and docs findings only; the tracker kinds are never counted on a public card. Acted on is the share of paired findings acted on after the review: the cited line changed, or, for a tests finding, a test importing its file landed. By line counts the cited line alone, as the control does, so compare by line with the control; control is the share of lines 35 away that changed. prep-pr fixes every in-scope finding, so this measures what got changed, not how good the findings were." +
      excluded(rows.length - reviewed.length, "no review report was read") +
      atOpen(reviewed),
    headers: ["PRs", "located", "paired", "acted on", "by line", "control"],
    rows: reviewed.length > 0 ? [[String(reviewed.length), ...reviewCells(reviewed)]] : [],
  };
}

/**
 * Cards whose sessions all ran before a change landed, against cards whose
 * sessions all ran after it.
 *
 * By time, not ancestry: most cards carry a `base_sha` no local clone still
 * holds, so ancestry places almost none of them. A card with sessions on both
 * sides is excluded — it ran with and without the change.
 */
export function splitAt(rows: CardRow[], landedAt: number, label: string): Table {
  const before: CardRow[] = [];
  const after: CardRow[] = [];
  let straddling = 0;

  for (const row of rows) {
    const first = row.firstTs === null ? Number.NaN : Date.parse(row.firstTs);
    const last = row.lastTs === null ? Number.NaN : Date.parse(row.lastTs);

    if (last < landedAt) before.push(row);
    else if (first > landedAt) after.push(row);
    else straddling += 1;
  }

  const cells = (name: string, group: CardRow[]): string[] => {
    const rated = group.filter((r) => r.declared !== null && r.ratingMethod === "confirmed");
    const calls = group.map((r) => r.requests).filter((n): n is number => n !== null);

    return [
      name,
      String(group.length),
      String(rated.length),
      rated.length > 0 ? usd(median(rated.map((r) => r.usd / (r.declared as number)))) : "—",
      calls.length > 0 ? median(calls).toFixed(0) : "—",
      pct(median(group.map((r) => r.cacheWriteShare))),
      ...reviewCells(group).slice(2),
    ];
  };

  return {
    title: `Split at ${label}`,
    note:
      "Cards whose sessions all ran before the commit against those all after. Cost per point uses confirmed ratings only. At-open cards are included. Acted on counts a landed test only on cards whose collector counts one, which follows the collector a branch ran rather than when; by line is counted the same way on every card." +
      excluded(straddling, "sessions on both sides of the commit, or none recorded"),
    headers: [
      "group",
      "PRs",
      "rated",
      "cost per point",
      "median calls",
      "cache-write tokens",
      "acted on",
      "by line",
      "control",
    ],
    rows: [cells("before", before), cells("after", after)],
  };
}

export function formatTable(table: Table): string {
  const lines = [`\n${table.title}`, "─".repeat(Math.min(table.title.length, 78))];

  if (table.rows.length === 0) {
    lines.push("  (no rows)");
    if (table.note) lines.push(`  ${table.note}`);

    return lines.join("\n");
  }

  const widths = table.headers.map((header, i) =>
    Math.max(header.length, ...table.rows.map((row) => (row[i] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();

  lines.push(`  ${render(table.headers)}`, `  ${widths.map((w) => "─".repeat(w)).join("  ")}`);
  for (const row of table.rows) lines.push(`  ${render(row)}`);
  if (table.note) lines.push(`\n  ${table.note}`);

  return lines.join("\n");
}

export function loadCards(dir: string): Card[] {
  const fs = require("node:fs") as typeof import("node:fs");

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const cards: Card[] = [];
  for (const name of names) {
    try {
      cards.push(JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8")) as Card);
    } catch {
      console.warn(`⚠️  pr-metrics report: skipping unreadable card ${name}`);
    }
  }

  return cards;
}

const REPORTS = {
  coverage,
  waste,
  exploration,
  briefs,
  context,
  "cost-by-complexity": costByComplexity,
  delegation,
  requests,
  review,
} as const;

/** These read every card, merged or not; the rest read merged cards only. */
const ALL_ROWS = new Set(["requests", "review"]);

if (import.meta.main) {
  const { defaultMetricsDir } = require("./index.ts") as typeof import("./index.ts");
  const dirIndex = Bun.argv.indexOf("--dir");
  const dir =
    dirIndex >= 0 && Bun.argv[dirIndex + 1] ? Bun.argv[dirIndex + 1] : defaultMetricsDir();
  const cards = loadCards(dir);

  if (cards.length === 0) {
    console.error(`❌ pr-metrics report: no cards under ${dir}.`);
    console.error("   Run `bun run --cwd tools/pr-metrics backfill` to populate it.");
    process.exit(1);
  }

  const allRows = cards.map(toRow);
  const rows = merged(allRows);
  const asked = Object.keys(REPORTS).filter((name) => Bun.argv.includes(`--${name}`));
  const splitIndex = Bun.argv.indexOf("--split-at");
  const splitCommit = splitIndex >= 0 ? (Bun.argv[splitIndex + 1] ?? "") : null;
  const selected = asked.length > 0 || splitCommit !== null ? asked : Object.keys(REPORTS);

  const tableFor = (name: string): Table =>
    REPORTS[name as keyof typeof REPORTS](ALL_ROWS.has(name) ? allRows : rows);

  const builtTables: [string, Table][] = selected.map((name) => [name, tableFor(name)]);

  // The one analysis that needs git: when the commit landed. Its committer time
  // is when it reached the branch it was merged to.
  if (splitCommit !== null) {
    // `--end-of-options`: the value is whatever followed the flag, and git
    // would read `--output=<file>` there as an option and write the file.
    const shown = Bun.spawnSync(
      ["git", "log", "-1", "--format=%ct", "--end-of-options", splitCommit, "--"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const seconds = Number.parseInt(shown.stdout.toString().trim(), 10);

    if (!shown.success || Number.isNaN(seconds)) {
      process.stderr.write(`❌ pr-metrics report: git does not know commit \`${splitCommit}\`.\n`);
      process.exit(1);
    }

    builtTables.push(["split-at", splitAt(allRows, seconds * 1000, splitCommit.slice(0, 12))]);
  }

  // `--json` prints the same tables as data and nothing else, so an agent
  // reading this does not have to parse ASCII columns back into numbers. The
  // `note` on each table travels with it deliberately: it carries the
  // exclusions and caveats, and a consumer that sees only rows will state a
  // ranking's conclusion without its "18 cards excluded" qualifier.
  if (Bun.argv.includes("--json")) {
    const tables = Object.fromEntries(builtTables);

    console.log(JSON.stringify({ cards: cards.length, merged: rows.length, dir, tables }, null, 2));
    process.exit(0);
  }

  console.log(`pr-metrics report: ${cards.length} card(s) in ${dir}, ${rows.length} merged.`);

  for (const [, table] of builtTables) console.log(formatTable(table));

  console.log("\nAd-hoc SQL over the same cards (needs DuckDB, local only):");
  console.log("  duckdb -init tools/pr-metrics/queries.sql");
}
