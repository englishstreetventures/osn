/**
 * The shaping functions behind every chart. Each one is a place a wrong answer
 * would still render — a null counted as zero, a mean where a median belongs,
 * an unconfirmed rating charted as real — so each rule is pinned here.
 */
import { describe, expect, it } from "vitest";

import type { Card } from "../../pr-metrics/index.ts";
import {
  complexity,
  correctionRate,
  coverage,
  effortMix,
  modelMix,
  monthly,
  sessionsAgainstCost,
  toRow,
} from "../src/shape.ts";

interface Fixture {
  pr?: number;
  mergedAt?: string | null;
  phase?: "at-open" | "at-merge";
  declared?: number | null;
  method?: string;
  usd?: number;
  sessions?: number;
  turns?: number;
  corrections?: number;
  beforeFirstEdit?: number | null;
  models?: [string, number][];
  effort?: [string, number][];
}

const tokens = (output: number) => ({
  input: 0,
  output,
  thinking: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_read: output,
});

function card(fixture: Fixture = {}): Card {
  const usd = fixture.usd ?? 1;
  const models = fixture.models ?? [["claude-opus-5", 10]];

  return {
    schema_version: 1,
    pr: {
      number: fixture.pr ?? 1,
      branch: `feat/pr-${fixture.pr ?? 1}`,
      base_sha: null,
      head_sha: null,
      generated_at: "2026-09-07T00:00:00Z",
      merged_at: fixture.mergedAt === undefined ? "2026-09-01T00:00:00Z" : fixture.mergedAt,
      phase: fixture.phase ?? "at-merge",
    },
    issue: { number: null, type: null, labels: [] },
    complexity: { declared: fixture.declared ?? null, method: fixture.method ?? "none" },
    window: {
      sessions: fixture.sessions ?? 1,
      first_ts: null,
      last_ts: null,
      span_seconds: 0,
      active_seconds: 60,
      compactions: 0,
    },
    spend: {
      usd_equivalent: usd,
      tokens: tokens(1000),
      by_model: Object.fromEntries(
        models.map(([model, messages]) => [
          model,
          { tokens: tokens(100), usd_equivalent: usd, messages },
        ]),
      ),
      by_actor: {
        main: { tokens: tokens(1000), usd_equivalent: usd, messages: 10 },
        subagent: { tokens: tokens(0), usd_equivalent: 0, messages: 0 },
      },
      effort: Object.fromEntries(fixture.effort ?? []),
      unpriced_models: [],
    },
    diff: {
      files: { generated: 0, test: 0, docs: 0, config: 0, source: 1 },
      loc: {
        generated: { added: 0, deleted: 0 },
        test: { added: 0, deleted: 0 },
        docs: { added: 0, deleted: 0 },
        config: { added: 0, deleted: 0 },
        source: { added: 10, deleted: 2 },
      },
      packages: ["osn/api"],
      touches_migration: false,
      commits: 1,
    },
    interaction: {
      user_turns: fixture.turns ?? 1,
      corrective_turns: fixture.corrections ?? 0,
      tokens_before_first_edit:
        fixture.beforeFirstEdit === undefined ? 200 : fixture.beforeFirstEdit,
      sessions_with_observed_edit: 1,
      tool_calls: {},
      edit_churn: { files_edited_3plus: 0, max_edits_one_file: 0 },
      skills: {},
      subagents: {},
    },
  };
}

describe("coverage", () => {
  it("counts cards, merges, phases and confirmed ratings separately", () => {
    const result = coverage([
      card({ pr: 1 }),
      card({ pr: 2, phase: "at-open", mergedAt: null, declared: 3, method: "unconfirmed" }),
      card({ pr: 3, declared: 5, method: "confirmed", mergedAt: "2026-08-20T00:00:00Z" }),
    ]);

    expect(result).toEqual({
      cards: 3,
      merged: 2,
      confirmed: 1,
      unconfirmed: 1,
      atOpen: 1,
      atMerge: 2,
      firstMonth: "2026-08",
      lastMonth: "2026-09",
    });
  });

  it("reports no months for an empty corpus rather than throwing", () => {
    expect(coverage([]).firstMonth).toBeNull();
  });
});

describe("monthly", () => {
  const rows = [
    card({ pr: 1, usd: 1, mergedAt: "2026-08-01T00:00:00Z" }),
    card({ pr: 2, usd: 2, mergedAt: "2026-09-01T00:00:00Z" }),
    card({ pr: 3, usd: 3, mergedAt: "2026-09-02T00:00:00Z" }),
    card({ pr: 4, usd: 100, mergedAt: "2026-09-03T00:00:00Z" }),
  ].map(toRow);

  it("summarises each month with a median, so one outlier does not move it", () => {
    const { medians } = monthly(rows, (row) => row.usd);

    expect(medians).toEqual([
      { month: "2026-08", prs: 1, median: 1 },
      { month: "2026-09", prs: 3, median: 3 },
    ]);
  });

  it("keeps one point per card, ordered by month", () => {
    const { points } = monthly(rows, (row) => row.usd);

    expect(points.map((point) => [point.month, point.pr, point.value])).toEqual([
      ["2026-08", 1, 1],
      ["2026-09", 2, 2],
      ["2026-09", 3, 3],
      ["2026-09", 4, 100],
    ]);
  });

  it("drops a null and counts it, never treating it as zero", () => {
    const withNull = [
      card({ pr: 1, beforeFirstEdit: null }),
      card({ pr: 2, beforeFirstEdit: 500 }),
    ].map(toRow);
    const { points, medians, excluded } = monthly(withNull, (row) => row.exploreShare);

    expect(excluded).toBe(1);
    expect(points.map((point) => point.pr)).toEqual([2]);
    expect(medians[0]?.prs).toBe(1);
  });
});

describe("correctionRate", () => {
  it("is corrections over human turns", () => {
    expect(correctionRate(toRow(card({ turns: 4, corrections: 1 })))).toBe(0.25);
  });

  it("is unknown, not zero, when no human turn was recorded", () => {
    expect(correctionRate(toRow(card({ turns: 0, corrections: 0 })))).toBeNull();
  });
});

describe("complexity", () => {
  it("charts only confirmed ratings and counts the rest by reason", () => {
    const view = complexity(
      [
        card({ pr: 1 }),
        card({ pr: 2, declared: 2, method: "unconfirmed" }),
        card({ pr: 3, declared: 5, method: "confirmed", usd: 12 }),
      ].map(toRow),
    );

    expect(view.unrated).toBe(1);
    expect(view.unconfirmed).toBe(1);
    expect(view.points).toEqual([
      { pr: 3, branch: "feat/pr-3", declared: 5, usd: 12, sourceLoc: 12 },
    ]);
  });
});

describe("sessionsAgainstCost", () => {
  it("gives a median per session count, ordered by sessions", () => {
    const view = sessionsAgainstCost([
      card({ pr: 1, sessions: 2, usd: 5 }),
      card({ pr: 2, sessions: 1, usd: 3 }),
      card({ pr: 3, sessions: 2, usd: 50 }),
      card({ pr: 4, sessions: 2, usd: 7 }),
    ]);

    expect(view.points).toHaveLength(4);
    expect(view.medians).toEqual([
      { sessions: 1, prs: 1, median: 3 },
      { sessions: 2, prs: 3, median: 7 },
    ]);
  });
});

describe("modelMix", () => {
  it("shares each month's messages between models and orders keys largest first", () => {
    const view = modelMix([
      card({
        pr: 1,
        models: [
          ["claude-opus-5", 30],
          ["claude-sonnet-5", 10],
        ],
      }),
      card({ pr: 2, models: [["claude-sonnet-5", 60]] }),
    ]);

    expect(view.keys).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(view.unrecorded).toBe(0);
    expect(view.shares).toEqual([
      { month: "2026-09", key: "claude-sonnet-5", messages: 70, share: 0.7 },
      { month: "2026-09", key: "claude-opus-5", messages: 30, share: 0.3 },
    ]);
  });
});

describe("effortMix", () => {
  it("counts a card with no recorded effort as unrecorded, not as a level", () => {
    const view = effortMix([
      card({ pr: 1, effort: [["high", 20]] }),
      card({ pr: 2, effort: [] }),
      card({
        pr: 3,
        effort: [
          ["high", 5],
          ["medium", 5],
        ],
        mergedAt: "2026-08-10T00:00:00Z",
      }),
    ]);

    expect(view.unrecorded).toBe(1);
    expect(view.keys).toEqual(["high", "medium"]);
    expect(view.shares).toEqual([
      { month: "2026-08", key: "high", messages: 5, share: 0.5 },
      { month: "2026-08", key: "medium", messages: 5, share: 0.5 },
      { month: "2026-09", key: "high", messages: 20, share: 1 },
    ]);
  });
});
