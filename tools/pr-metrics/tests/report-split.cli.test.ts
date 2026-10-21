// The two tables and the `--split-at` comparison this branch adds, through the
// report's own entry point. `--split-at` asks git for a commit's time, so it
// runs inside a throwaway repository; the cards sit in a directory beside it.
//
// The corpus mixes cards written before `interaction.requests` and `review`
// existed with cards that carry them. Most committed cards are the old shape,
// so a table that assumed the new fields would throw on the real directory.

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Card } from "../index";

interface Shape {
  number: number;
  first: string;
  last: string;
  merged?: string | null;
  requests?: boolean;
  review?: boolean;
}

function card(shape: Shape): Card {
  const zero = {
    input: 0,
    output: 0,
    thinking: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  };

  const built: Card = {
    schema_version: 1,
    pr: {
      number: shape.number,
      branch: `feat/x-${shape.number}`,
      base_sha: null,
      head_sha: null,
      generated_at: shape.last,
      merged_at: shape.merged === undefined ? shape.last : shape.merged,
      phase: "at-open",
    },
    issue: { number: null, type: null, labels: [] },
    complexity: { declared: 2, method: "confirmed" },
    window: {
      sessions: 1,
      first_ts: shape.first,
      last_ts: shape.last,
      span_seconds: 0,
      active_seconds: 600,
      compactions: 0,
    },
    spend: {
      usd_equivalent: 10 * shape.number,
      tokens: { ...zero, output: 1_000, cache_write_5m: 1_000, cache_read: 8_000 },
      by_model: {},
      by_actor: {
        main: { tokens: { ...zero }, usd_equivalent: 0, messages: 0 },
        subagent: { tokens: { ...zero }, usd_equivalent: 0, messages: 0 },
      },
      effort: {},
      unpriced_models: [],
    },
    diff: {
      files: { generated: 0, test: 0, docs: 0, config: 0, source: 1 },
      loc: {
        generated: { added: 0, deleted: 0 },
        test: { added: 0, deleted: 0 },
        docs: { added: 0, deleted: 0 },
        config: { added: 0, deleted: 0 },
        source: { added: 5, deleted: 0 },
      },
      packages: [],
      touches_migration: false,
      commits: 1,
    },
    interaction: {
      user_turns: 1,
      corrective_turns: 0,
      tokens_before_first_edit: null,
      sessions_with_observed_edit: 0,
      tool_calls: {},
      edit_churn: { files_edited_3plus: 0, max_edits_one_file: 0 },
      skills: {},
      subagents: {},
    },
  };

  if (shape.requests) {
    built.interaction.requests = {
      main: 40,
      subagent: 10,
      with_tools: 40,
      with_one_tool: 30,
      context_median: 50_000,
      context_p90: 90_000,
    };
  }

  if (shape.review) {
    built.review = {
      reports: 1,
      findings: 4,
      located: 3,
      acted_on: 2,
      paired: 2,
      acted_on_paired: 2,
      control_changed: 0,
    };
  }

  return built;
}

const SPLIT_AT = "2026-09-10T12:00:00Z";

async function withRepo(
  cards: Card[],
  body: (repo: string, dir: string, sha: string) => Promise<void>,
) {
  const repo = await mkdtemp(join(tmpdir(), "pr-metrics-split-"));
  const dir = join(repo, "cards");

  try {
    const git = async (args: string[], date?: string) => {
      const env = date
        ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
        : process.env;
      const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", env });
      const out = await new Response(proc.stdout).text();
      await proc.exited;

      return out.trim();
    };

    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "skill.md"), "v1\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "the change under test"], SPLIT_AT);
    const sha = await git(["rev-parse", "HEAD"]);

    await Bun.write(join(dir, ".keep"), "");
    for (const c of cards) await writeFile(join(dir, `${c.pr.number}.json`), JSON.stringify(c));

    await body(repo, dir, sha);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function report(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "report.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

type Tables = Record<string, { title: string; note?: string; rows: string[][] }>;

// 8
test("the requests and review tables read old and new cards together", async () => {
  const cards = [
    card({ number: 1, first: "2026-09-01T10:00:00Z", last: "2026-09-01T11:00:00Z" }),
    card({
      number: 2,
      first: "2026-09-02T10:00:00Z",
      last: "2026-09-02T11:00:00Z",
      requests: true,
      review: true,
    }),
    // At-open, never merged: still counted by these two tables.
    card({
      number: 3,
      first: "2026-09-03T10:00:00Z",
      last: "2026-09-03T11:00:00Z",
      merged: null,
      requests: true,
      review: true,
    }),
  ];

  await withRepo(cards, async (repo, dir) => {
    const { code, stdout } = await report(repo, ["--dir", dir, "--requests", "--review", "--json"]);
    expect(code).toBe(0);

    const tables = (JSON.parse(stdout) as { tables: Tables }).tables;

    expect(tables.requests?.rows.map((r) => r[1])).toEqual(["2"]);
    expect(tables.requests?.note).toContain("1 card(s) excluded");
    expect(tables.review?.rows[0]).toEqual(["2", "6", "4", "100%", "0%"]);
    expect(tables.review?.note).toContain("1 card(s) excluded");
  });
});

// 9
test("--split-at groups cards by when their sessions ran against the commit's time", async () => {
  const cards = [
    card({
      number: 1,
      first: "2026-09-01T10:00:00Z",
      last: "2026-09-01T11:00:00Z",
      requests: true,
    }),
    card({
      number: 2,
      first: "2026-09-02T10:00:00Z",
      last: "2026-09-02T11:00:00Z",
      requests: true,
    }),
    card({
      number: 3,
      first: "2026-09-11T10:00:00Z",
      last: "2026-09-11T11:00:00Z",
      requests: true,
    }),
    // Sessions on both sides of the commit: cannot be placed.
    card({ number: 4, first: "2026-09-10T10:00:00Z", last: "2026-09-10T14:00:00Z" }),
  ];

  await withRepo(cards, async (repo, dir, sha) => {
    const { code, stdout, stderr } = await report(repo, [
      "--dir",
      dir,
      "--split-at",
      sha,
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const split = (JSON.parse(stdout) as { tables: Tables }).tables["split-at"];

    expect(split?.rows.map((r) => [r[0], r[1]])).toEqual([
      ["before", "2"],
      ["after", "1"],
    ]);
    expect(split?.note).toContain("1 card(s) excluded");
  });
});

test("--split-at with a commit git does not know exits 1 and says so", async () => {
  const one = [card({ number: 1, first: "2026-09-01T10:00:00Z", last: "2026-09-01T11:00:00Z" })];

  await withRepo(one, async (repo, dir) => {
    const { code, stderr } = await report(repo, ["--dir", dir, "--split-at", "deadbeef"]);

    expect(code).toBe(1);
    expect(stderr).toContain("deadbeef");
  });
});
