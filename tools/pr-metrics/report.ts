#!/usr/bin/env bun
/**
 * Read the cards back, without needing anything installed.
 *
 * `queries.sql` is the same seven analyses in SQL, and it is the better tool
 * for a question nobody anticipated. It is not the better tool for the common
 * case, because **DuckDB does not exist in a remote session** — none of the
 * `duckdb` npm packages ship a binary (they are all libraries), so `bunx` is no
 * help and there is no `brew` in a cloud container. A report that only runs on
 * one laptop is not a report on how the fleet is doing.
 *
 * So the seven queries live here too, in TypeScript, over the same committed
 * JSON. That runs in every environment the repository runs in — local, cloud,
 * CI — with no dependency at all. A few hundred small JSON files do not need an
 * OLAP engine; calling the directory a datalake oversold it.
 *
 * The two must agree. When a definition changes, change it in both — the
 * ratios are duplicated on purpose rather than generated, because generating
 * SQL from TypeScript would cost more than it saves at this size.
 */

import { type Card, compactTokens, defaultMetricsDir } from "./index.ts";

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
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function toRow(card: Card): CardRow {
  const t = card.spend.tokens;
  const total = t.output + t.cache_read + t.cache_write_5m + t.cache_write_1h;

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

/** 5. Cost per unit of declared difficulty. */
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
} as const;

if (import.meta.main) {
  const dirIndex = Bun.argv.indexOf("--dir");
  const dir =
    dirIndex >= 0 && Bun.argv[dirIndex + 1] ? Bun.argv[dirIndex + 1] : defaultMetricsDir();
  const cards = loadCards(dir);

  if (cards.length === 0) {
    console.error(`❌ pr-metrics report: no cards under ${dir}.`);
    console.error("   Run `bun run --cwd tools/pr-metrics backfill` to populate it.");
    process.exit(1);
  }

  const rows = merged(cards.map(toRow));
  const asked = Object.keys(REPORTS).filter((name) => Bun.argv.includes(`--${name}`));
  const selected = asked.length > 0 ? asked : Object.keys(REPORTS);

  // `--json` prints the same tables as data and nothing else, so an agent
  // reading this does not have to parse ASCII columns back into numbers. The
  // `note` on each table travels with it deliberately: it carries the
  // exclusions and caveats, and a consumer that sees only rows will state a
  // ranking's conclusion without its "18 cards excluded" qualifier.
  if (Bun.argv.includes("--json")) {
    const tables = Object.fromEntries(
      selected.map((name) => [name, REPORTS[name as keyof typeof REPORTS](rows)]),
    );

    console.log(JSON.stringify({ cards: cards.length, merged: rows.length, dir, tables }, null, 2));
    process.exit(0);
  }

  console.log(`pr-metrics report: ${cards.length} card(s) in ${dir}, ${rows.length} merged.`);

  for (const name of selected) {
    console.log(formatTable(REPORTS[name as keyof typeof REPORTS](rows)));
  }

  console.log("\nAd-hoc SQL over the same cards (needs DuckDB, local only):");
  console.log("  duckdb -init tools/pr-metrics/queries.sql");
}
