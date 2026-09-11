import { expect, test } from "bun:test";

import {
  buildCard,
  type Card,
  compactTokens,
  humanDuration,
  parseNumstat,
  renderDetails,
  sameApartFromGeneratedAt,
  type SessionRecord,
} from "../index";

function card(
  overrides: { records?: SessionRecord[]; declared?: number | null; generatedAt?: string } = {},
): Card {
  const records: SessionRecord[] = overrides.records ?? [
    { type: "user", sessionId: "s1", timestamp: "…01", message: { content: "go" } },
    {
      type: "assistant",
      sessionId: "s1",
      timestamp: "…02",
      message: {
        model: "claude-opus-5",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }],
        usage: {
          input_tokens: 0,
          output_tokens: 360_280,
          cache_creation_input_tokens: 2_105_301,
          cache_read_input_tokens: 63_448_693,
        },
      },
    },
  ];

  return buildCard(records, parseNumstat("312\t88\tosn/api/src/a.ts", 6), {
    branch: "feat/x",
    prNumber: 908,
    issueNumber: 895,
    issueType: "Feature",
    issueLabels: [],
    declaredComplexity: overrides.declared === undefined ? 3 : overrides.declared,
    complexityMethod: "confirmed",
    baseSha: "abc",
    headSha: "def",
    mergedAt: null,
    phase: "at-open",
    generatedAt: overrides.generatedAt ?? "2026-09-07T00:00:00.000Z",
  });
}

test("compactTokens keeps large counts readable", () => {
  expect(compactTokens(66_000_000)).toBe("66.0M");
  expect(compactTokens(1_500)).toBe("1.5K");
  expect(compactTokens(42)).toBe("42");
});

test("humanDuration reads in the unit that fits", () => {
  expect(humanDuration(45)).toBe("45s");
  expect(humanDuration(1_200)).toBe("20m");
  expect(humanDuration(7_500)).toBe("2h 5m");
});

// `prep-pr` permits exactly five `##` headings and counts them before it
// finishes. A metrics *section* would fail a body that is otherwise correct, so
// the block must contribute no heading at all.
test("renderDetails adds no markdown heading", () => {
  const block = renderDetails(card());

  expect(block).not.toMatch(/^#/m);
  expect(block.startsWith("<details>")).toBe(true);
  expect(block.trimEnd().endsWith("</details>")).toBe(true);
});

test("renderDetails puts the four headline figures in the summary line", () => {
  const summary = renderDetails(card()).split("\n")[0];

  expect(summary).toContain("$");
  expect(summary).toContain("65.9M tok");
  expect(summary).toContain("complexity 3");
  expect(summary).toContain("+312/-88 source");
});

// The work runs on a subscription. A column headed "Cost" invites the number
// to be read as a bill, which it is not.
test("renderDetails labels the cost as API-equivalent", () => {
  expect(renderDetails(card())).toContain("Cost (API-equivalent)");
});

test("renderDetails says unrated rather than inventing a number", () => {
  const block = renderDetails(card({ declared: null }));

  expect(block).toContain("| Declared complexity | unrated |");
  expect(block.split("\n")[0]).toContain("complexity unrated");
});

test("renderDetails reports no subagents without pretending there were some", () => {
  expect(renderDetails(card())).toContain("| Subagents | none |");
});

test("renderDetails survives a card with no spend at all", () => {
  const block = renderDetails(card({ records: [] }));

  expect(block).toContain("$0.00");
  expect(block).toContain("| Models | — |");
});

// `generated_at` says when a run happened, not anything about the pull request,
// so a re-run over settled work moves that field and nothing else. Rewriting
// the file for it put a one-line timestamp diff in every pull request that
// re-ran the tool.
test("sameApartFromGeneratedAt ignores the timestamp and nothing else", () => {
  const first = card({ generatedAt: "2026-09-07T00:00:00.000Z" });
  const later = card({ generatedAt: "2026-09-11T09:30:00.000Z" });

  expect(sameApartFromGeneratedAt(first, later)).toBe(true);
});

test("sameApartFromGeneratedAt reports a real change as changed", () => {
  const rated = card({ declared: 3 });
  const unrated = card({ declared: null, generatedAt: "2026-09-11T09:30:00.000Z" });

  expect(sameApartFromGeneratedAt(rated, unrated)).toBe(false);
});

test("sameApartFromGeneratedAt catches a change in spend, not just the header", () => {
  const spent = card();
  const quiet = card({ records: [] });

  expect(sameApartFromGeneratedAt(spent, quiet)).toBe(false);
});
