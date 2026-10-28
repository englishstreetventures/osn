// `queries.sql` declares the card's shape for DuckDB rather than inferring it,
// so that a key's case never decides whether the script runs. A declared shape
// can drift from the card the collector writes: a field the view leaves out
// cannot be queried, one the card no longer carries reads as NULL without an
// error, and a whole-number type truncates a fraction. This test reads the
// declaration as text and needs no DuckDB, so it runs in CI and remote sessions,
// where the collector also changes.

import { expect, test } from "bun:test";
import { join } from "node:path";

import { buildCard, parseNumstat, type ReviewSummary, type SessionRecord } from "../index";

const QUERIES = join(import.meta.dir, "..", "queries.sql");

type SqlType =
  | { kind: "scalar"; name: string }
  | { kind: "list"; element: SqlType }
  | { kind: "map"; value: SqlType }
  | { kind: "struct"; fields: Map<string, SqlType> };

const SCALARS = new Set(["BIGINT", "DOUBLE", "VARCHAR", "TIMESTAMPTZ", "BOOLEAN"]);

/** Parses the subset of DuckDB's type syntax the view uses. */
function parseType(text: string, named: Map<string, SqlType>): SqlType {
  let at = 0;
  const skip = () => {
    while (/\s/.test(text[at] ?? "")) at += 1;
  };
  const word = (): string => {
    skip();
    if (text[at] === '"') {
      const end = text.indexOf('"', at + 1);
      const quoted = text.slice(at + 1, end);
      at = end + 1;
      return quoted;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
    if (!match) throw new Error(`expected a name at ${at} in ${text}`);
    at += match[0].length;
    return match[0];
  };
  const take = (token: string) => {
    skip();
    if (text[at] !== token) throw new Error(`expected ${token} at ${at} in ${text}`);
    at += 1;
  };

  const type = (): SqlType => {
    const name = word();
    let parsed: SqlType;
    if (name === "STRUCT") {
      take("(");
      const fields = new Map<string, SqlType>();
      for (;;) {
        const field = word();
        fields.set(field, type());
        skip();
        if (text[at] === ")") break;
        take(",");
      }
      take(")");
      parsed = { kind: "struct", fields };
    } else if (name === "MAP") {
      take("(");
      const key = type();
      if (key.kind !== "scalar" || key.name !== "VARCHAR") throw new Error("map keys are VARCHAR");
      take(",");
      parsed = { kind: "map", value: type() };
      take(")");
    } else if (named.has(name)) {
      parsed = named.get(name) as SqlType;
    } else if (SCALARS.has(name)) {
      parsed = { kind: "scalar", name };
    } else {
      throw new Error(`type ${name} is not one the view may use`);
    }
    skip();
    if (text.startsWith("[]", at)) {
      at += 2;
      return { kind: "list", element: parsed };
    }

    return parsed;
  };

  const parsed = type();
  skip();
  if (at !== text.length) throw new Error(`trailing text in ${text}`);

  return parsed;
}

/** The `cards` view's declared shape, from the text of `queries.sql`. */
async function declaredCard(): Promise<SqlType> {
  const sql = await Bun.file(QUERIES).text();
  const named = new Map<string, SqlType>();
  for (const [, name, body] of sql.matchAll(/CREATE OR REPLACE TYPE (\w+) AS ([^;]+);/g)) {
    named.set(name, parseType(body, named));
  }

  const view = /CREATE OR REPLACE VIEW cards AS[\s\S]*?columns := \{([\s\S]*?)\}\);/.exec(sql);
  if (!view) throw new Error("no `columns := {...}` in the cards view");

  const fields = new Map<string, SqlType>();
  for (const [, key, body] of view[1].matchAll(/"?(\w+)"?:\s*'([^']*)'/g)) {
    fields.set(key, parseType(body, named));
  }

  return { kind: "struct", fields };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Every disagreement between the card and the declaration, by path. Maps and
 * lists must be non-empty so their element type is checked against a value.
 * `fractional` collects the `DOUBLE` paths that held a fraction somewhere.
 */
function mismatches(
  value: unknown,
  type: SqlType,
  path: string,
  fractional: Map<string, boolean>,
): string[] {
  if (value === null) return [];

  switch (type.kind) {
    case "scalar": {
      const ok =
        type.name === "BIGINT"
          ? Number.isInteger(value)
          : type.name === "DOUBLE"
            ? typeof value === "number"
            : type.name === "BOOLEAN"
              ? typeof value === "boolean"
              : type.name === "TIMESTAMPTZ"
                ? typeof value === "string" && ISO_TIMESTAMP.test(value)
                : typeof value === "string" && !ISO_TIMESTAMP.test(value);
      if (type.name === "DOUBLE" && typeof value === "number") {
        fractional.set(path, (fractional.get(path) ?? false) || !Number.isInteger(value));
      }

      return ok ? [] : [`${path}: ${JSON.stringify(value)} is not ${type.name}`];
    }
    case "list":
      if (!Array.isArray(value) || value.length === 0) return [`${path}: not a non-empty list`];

      return value.flatMap((item) => mismatches(item, type.element, `${path}[]`, fractional));
    case "map": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: not an object`];
      const entries = Object.values(value);
      if (entries.length === 0) return [`${path}: empty, so its value type goes unchecked`];

      return entries.flatMap((item) => mismatches(item, type.value, `${path}.*`, fractional));
    }
    case "struct": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: not an object`];
      const carried = Object.keys(value);
      const at = (key: string) => (path ? `${path}.${key}` : key);
      const found = [
        ...carried
          .filter((key) => !type.fields.has(key))
          .map((key) => `${at(key)}: on the card, not declared`),
        ...[...type.fields.keys()]
          .filter((key) => !carried.includes(key))
          .map((key) => `${at(key)}: declared, not on the card`),
      ];
      for (const [key, field] of type.fields) {
        if (key in value) {
          const child = (value as Record<string, unknown>)[key];
          found.push(...mismatches(child, field, at(key), fractional));
        }
      }

      return found;
    }
  }
}

/** A card with every optional field set, a fraction in every cost and an entry
 * in every map and list. */
function fullCard() {
  const usage = {
    input_tokens: 1_234_567,
    output_tokens: 76_543,
    cache_creation: { ephemeral_5m_input_tokens: 345_678, ephemeral_1h_input_tokens: 12_345 },
    cache_read_input_tokens: 3_000_000_000,
    output_tokens_details: { thinking_tokens: 4_321 },
  };
  const records: SessionRecord[] = [
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-10-01T00:00:00.000Z",
      message: { content: "go" },
    },
    {
      type: "assistant",
      sessionId: "s1",
      requestId: "r1",
      effort: "high",
      timestamp: "2026-10-01T00:00:05.000Z",
      message: {
        model: "claude-opus-5",
        usage,
        content: [
          { type: "tool_use", name: "Skill", input: { skill: "retro" } },
          { type: "tool_use", name: "Agent", input: { subagent_type: "reviewer" } },
          { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
        ],
      },
    },
    {
      type: "assistant",
      sessionId: "s1",
      requestId: "r2",
      isSidechain: true,
      effort: "low",
      timestamp: "2026-10-01T00:00:09.000Z",
      message: { model: "claude-sonnet-5-5", usage },
    },
    {
      type: "assistant",
      sessionId: "s1",
      requestId: "r3",
      timestamp: "2026-10-01T00:00:12.000Z",
      message: { model: "not-a-priced-model", usage },
    },
  ];
  const review: Required<ReviewSummary> = {
    reports: 2,
    findings: 5,
    located: 4,
    acted_on: 3,
    paired: 4,
    acted_on_paired: 3,
    control_changed: 1,
    acted_on_by_test: 1,
    acted_on_paired_by_test: 1,
  };

  return buildCard(
    records,
    parseNumstat("10\t2\tosn/api/src/a.ts\n4\t0\tosn/api/tests/a.test.ts", 3),
    {
      branch: "feat/x",
      prNumber: 908,
      issueNumber: 895,
      issueType: "Feature",
      issueLabels: ["product:shared"],
      declaredComplexity: 5,
      complexityMethod: "confirmed",
      complexityIssues: 2,
      baseSha: "abc",
      headSha: "def",
      mergedAt: "2026-10-02T00:00:00.000Z",
      phase: "at-merge",
      generatedAt: "2026-10-02T00:00:01.000Z",
      review,
    },
  );
}

test("queries.sql declares every card field, with a type that holds its value", async () => {
  const fractional = new Map<string, boolean>();

  expect(mismatches(fullCard(), await declaredCard(), "", fractional)).toEqual([]);
  // A whole number in a `DOUBLE` field would hide one declared `BIGINT`.
  expect([...fractional].filter(([, seen]) => !seen).map(([path]) => path)).toEqual([]);
  expect(fractional.size).toBeGreaterThan(0);
});
