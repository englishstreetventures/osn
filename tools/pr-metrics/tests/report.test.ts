import { expect, test } from "bun:test";

import type { Card } from "../index";
import {
  briefs,
  type CardRow,
  costByComplexity,
  coverage,
  exploration,
  formatTable,
  median,
  merged,
  toRow,
  waste,
} from "../report";

function card(overrides: Partial<Card["pr"]> & Record<string, unknown> = {}): Card {
  const pr = {
    number: 1,
    branch: "feat/x",
    base_sha: "a",
    head_sha: "b",
    generated_at: "2026-09-01T00:00:00.000Z",
    merged_at: "2026-09-02T00:00:00.000Z",
    phase: "at-open" as const,
    ...overrides,
  };

  return {
    schema_version: 1,
    pr,
    issue: { number: null, type: null, labels: [] },
    complexity: { declared: 2, method: "confirmed" },
    window: {
      sessions: 1,
      first_ts: null,
      last_ts: null,
      span_seconds: 0,
      active_seconds: 600,
      compactions: 0,
    },
    spend: {
      usd_equivalent: 50,
      tokens: {
        input: 0,
        output: 1_000,
        thinking: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        cache_read: 9_000,
      },
      by_model: {},
      by_actor: {
        main: {
          tokens: {
            input: 0,
            output: 0,
            thinking: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
          },
          usd_equivalent: 40,
          messages: 0,
        },
        subagent: {
          tokens: {
            input: 0,
            output: 0,
            thinking: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
          },
          usd_equivalent: 10,
          messages: 0,
        },
      },
      effort: {},
      unpriced_models: [],
    },
    diff: {
      files: { generated: 0, test: 0, docs: 0, config: 0, source: 2 },
      loc: {
        generated: { added: 0, deleted: 0 },
        test: { added: 0, deleted: 0 },
        docs: { added: 0, deleted: 0 },
        config: { added: 0, deleted: 0 },
        source: { added: 30, deleted: 10 },
      },
      packages: ["osn/api"],
      touches_migration: false,
      commits: 1,
    },
    interaction: {
      user_turns: 4,
      corrective_turns: 2,
      tokens_before_first_edit: 2_000,
      sessions_with_observed_edit: 1,
      tool_calls: {},
      edit_churn: { files_edited_3plus: 0, max_edits_one_file: 0 },
      skills: {},
      subagents: {},
    },
  };
}

test("toRow computes the shares the SQL views compute", () => {
  const row = toRow(card());

  expect(row.totalTokens).toBe(10_000);
  expect(row.cacheReadShare).toBeCloseTo(0.9, 6);
  expect(row.exploreShare).toBeCloseTo(0.2, 6);
  expect(row.subagentShare).toBeCloseTo(0.2, 6);
  expect(row.sourceLoc).toBe(40);
});

test("toRow divides by zero safely on an empty card", () => {
  const empty = card();
  empty.spend.tokens = {
    input: 0,
    output: 0,
    thinking: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  };
  empty.spend.usd_equivalent = 0;

  const row = toRow(empty);

  expect(row.cacheReadShare).toBe(0);
  expect(row.subagentShare).toBe(0);
});

// The whole reason this filter is merge status and not `phase === "at-merge"`:
// a remote session's container dies with its transcripts, so its cards stay
// `at-open` forever. Filtering on phase would drop every remote PR and bias
// every number toward work done locally.
test("merged keeps at-open cards that did merge", () => {
  const rows = [toRow(card({ phase: "at-open" })), toRow(card({ phase: "at-merge" }))];

  expect(merged(rows)).toHaveLength(2);
});

test("merged drops a card whose PR has not merged", () => {
  expect(merged([toRow(card({ merged_at: null }))])).toHaveLength(0);
});

test("waste ranks small, low-rated, expensive PRs by cost", () => {
  const rows: CardRow[] = [
    { ...toRow(card({ number: 1 })), usd: 10 },
    { ...toRow(card({ number: 2 })), usd: 90 },
  ];

  const table = waste(rows);

  expect(table.rows[0][0]).toBe("#2");
  expect(table.rows).toHaveLength(2);
});

// An agent's unreviewed guess about how hard something was is exactly the
// input that would make "was this worth it?" circular.
test("waste excludes unconfirmed ratings", () => {
  const row = { ...toRow(card()), ratingMethod: "unconfirmed" };

  expect(waste([row]).rows).toHaveLength(0);
});

test("waste excludes a large diff even at a low rating", () => {
  const row = { ...toRow(card()), sourceLoc: 5_000 };

  expect(waste([row]).rows).toHaveLength(0);
});

test("exploration needs a minimum sample before ranking a package", () => {
  const rows = [toRow(card()), toRow(card())];

  expect(exploration(rows).rows).toHaveLength(0);
  expect(exploration(rows, 2).rows[0]).toEqual(["osn/api", "2", "20%"]);
});

test("briefs groups by month of merge", () => {
  const rows = [
    toRow(card({ merged_at: "2026-08-15T00:00:00.000Z" })),
    toRow(card({ merged_at: "2026-09-02T00:00:00.000Z" })),
  ];

  expect(briefs(rows).rows.map((r) => r[0])).toEqual(["2026-08", "2026-09"]);
});

test("costByComplexity divides cost by the declared rating", () => {
  const table = costByComplexity([toRow(card())]);

  // $50 at a declared 2.
  expect(table.rows[0]).toEqual(["2", "1", "$50.00", "$25.00", "10m"]);
});

test("coverage splits by rating method and phase", () => {
  const rows = [
    toRow(card({ phase: "at-open" })),
    { ...toRow(card({ phase: "at-merge" })), ratingMethod: "unconfirmed" },
  ];

  const table = coverage(rows);

  expect(table.rows).toHaveLength(2);
  expect(table.rows.map((r) => r[1]).sort()).toEqual(["at-merge", "at-open"]);
});

test("formatTable says so rather than printing an empty frame", () => {
  const rendered = formatTable({ title: "T", headers: ["a"], rows: [] });

  expect(rendered).toContain("(no rows)");
});

test("formatTable pads columns to the widest cell", () => {
  const rendered = formatTable({
    title: "T",
    headers: ["package", "PRs"],
    rows: [["osn/api", "3"]],
  });

  expect(rendered).toContain("package  PRs");
  expect(rendered).toContain("osn/api  3");
});

// --- median, not mean -------------------------------------------------------

// The distributions here are severely right-skewed — across the first 34 cards
// the median was 3.6M tokens, the mean 15.4M, the maximum 92.7M. A mean over
// that describes the three largest pull requests and invents month-over-month
// growth that is not in the data.
test("median resists the outlier a mean would follow", () => {
  expect(median([1, 2, 3, 4, 100])).toBe(3);
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(median([])).toBe(0);
});

test("toRow reports an unknown explore share as null, not as 100%", () => {
  const c = card();
  c.interaction.tokens_before_first_edit = null;
  c.interaction.sessions_with_observed_edit = 0;

  expect(toRow(c).exploreShare).toBeNull();
});

// Ranking packages by a share that silently means "no edit was seen" sorted
// the table by which branches avoided the Edit tool.
test("exploration excludes cards whose boundary was never observed", () => {
  const unknown = { ...toRow(card()), exploreShare: null };
  const known = toRow(card());

  const table = exploration([unknown, unknown, unknown], 1);
  expect(table.rows).toHaveLength(0);
  expect(table.note).toContain("3 card(s) excluded");

  expect(exploration([known, known], 2).rows).toHaveLength(1);
});

// --- JSON output ------------------------------------------------------------

// An agent reading the report should not have to parse ASCII columns back into
// numbers. The `note` travels with each table on purpose: it carries the
// exclusions, and a consumer that reads only rows will state a ranking's
// conclusion without its "18 cards excluded" qualifier.
test("every report table carries its note alongside its rows", () => {
  const rows = [toRow(card()), { ...toRow(card()), exploreShare: null }];

  for (const table of [coverage(rows), exploration(rows, 1), waste(rows)]) {
    expect(table.title).toBeTruthy();
    expect(table.note).toBeTruthy();
    expect(Array.isArray(table.headers)).toBe(true);
    expect(Array.isArray(table.rows)).toBe(true);
  }
});

test("a table survives a JSON round trip unchanged", () => {
  const table = exploration([toRow(card()), toRow(card())], 2);

  expect(JSON.parse(JSON.stringify(table))).toEqual(table);
});

test("the exploration note names how many cards it dropped", () => {
  const table = exploration([{ ...toRow(card()), exploreShare: null }], 1);

  expect(table.note).toContain("1 card(s) excluded");
});
