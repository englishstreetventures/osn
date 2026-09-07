import { expect, test } from "bun:test";

import {
  aggregateInteraction,
  aggregateSpend,
  aggregateWindow,
  branchSlug,
  classifyPath,
  costOf,
  declaredFromLabels,
  emptyTokens,
  IDLE_CAP_SECONDS,
  isFileWritingCommand,
  isHumanTurn,
  parseNumstat,
  readUsage,
  type SessionRecord,
} from "../index";

function assistant(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    type: "assistant",
    sessionId: "s1",
    gitBranch: "feat/x",
    timestamp: "2026-09-07T10:00:00.000Z",
    message: { role: "assistant", model: "claude-opus-5", content: [], usage: {} },
    ...overrides,
  };
}

function usage(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...fields,
  };
}

function toolUse(name: string, input: Record<string, unknown> = {}) {
  return { type: "tool_use", name, input };
}

// --- usage parsing ----------------------------------------------------------

test("readUsage splits cache creation by TTL", () => {
  const tokens = readUsage(
    usage({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 500,
      cache_creation: { ephemeral_1h_input_tokens: 700, ephemeral_5m_input_tokens: 300 },
      output_tokens_details: { thinking_tokens: 7 },
    }),
  );

  expect(tokens).toEqual({
    input: 10,
    output: 20,
    thinking: 7,
    cache_write_5m: 300,
    cache_write_1h: 700,
    cache_read: 500,
  });
});

// A transcript written before the TTL breakdown existed still has a total. The
// whole amount has to land in one bucket, and 5m is the cheaper multiplier —
// so an old card under-reports rather than inflating a cost nobody can check.
test("readUsage treats an absent TTL breakdown as all 5m", () => {
  const tokens = readUsage(usage({ cache_creation_input_tokens: 900 }));

  expect(tokens.cache_write_5m).toBe(900);
  expect(tokens.cache_write_1h).toBe(0);
});

test("readUsage of a missing usage object is all zeroes", () => {
  expect(readUsage(undefined)).toEqual(emptyTokens());
});

// --- cost -------------------------------------------------------------------

test("costOf applies the input, output and cache multipliers", () => {
  const cost = costOf(
    {
      input: 1_000_000,
      output: 1_000_000,
      thinking: 0,
      cache_write_5m: 1_000_000,
      cache_write_1h: 1_000_000,
      cache_read: 1_000_000,
    },
    "claude-opus-5",
  );

  // 5 (input) + 25 (output) + 6.25 (5m write) + 10 (1h write) + 0.5 (read)
  expect(cost).toBeCloseTo(46.75, 6);
});

// Thinking tokens are already inside output_tokens on the wire — billing them
// again would silently inflate every card that used adaptive thinking.
test("costOf does not bill thinking tokens on top of output", () => {
  const withThinking = costOf(
    { ...emptyTokens(), output: 1_000_000, thinking: 900_000 },
    "claude-opus-5",
  );

  expect(withThinking).toBeCloseTo(25, 6);
});

test("costOf rates an unknown model at zero rather than guessing", () => {
  expect(costOf({ ...emptyTokens(), output: 5_000_000 }, "claude-nextgen-9")).toBe(0);
});

test("aggregateSpend names unpriced models so the gap is visible", () => {
  const spend = aggregateSpend([
    assistant({ message: { model: "claude-nextgen-9", usage: usage({ output_tokens: 10 }) } }),
  ]);

  expect(spend.unpriced_models).toEqual(["claude-nextgen-9"]);
  expect(spend.usd_equivalent).toBe(0);
  expect(spend.tokens.output).toBe(10);
});

test("aggregateSpend splits main and subagent spend", () => {
  const spend = aggregateSpend([
    assistant({ message: { model: "claude-opus-5", usage: usage({ output_tokens: 100 }) } }),
    assistant({
      isSidechain: true,
      message: { model: "claude-opus-5", usage: usage({ output_tokens: 400 }) },
    }),
  ]);

  expect(spend.by_actor.main.tokens.output).toBe(100);
  expect(spend.by_actor.subagent.tokens.output).toBe(400);
  expect(spend.tokens.output).toBe(500);
});

test("aggregateSpend ignores user records", () => {
  const spend = aggregateSpend([
    { type: "user", message: { content: "hello", usage: usage({ output_tokens: 999 }) } },
  ]);

  expect(spend.tokens.output).toBe(0);
});

// --- window -----------------------------------------------------------------

test("aggregateWindow caps each idle gap but keeps the raw span", () => {
  const window = aggregateWindow([
    assistant({ timestamp: "2026-09-07T10:00:00.000Z" }),
    assistant({ timestamp: "2026-09-07T10:01:00.000Z" }),
    assistant({ timestamp: "2026-09-07T12:00:00.000Z" }),
  ]);

  expect(window.span_seconds).toBe(7200);
  // 60s worked, then a two-hour gap that counts as one capped interval.
  expect(window.active_seconds).toBe(60 + IDLE_CAP_SECONDS);
});

// Two sessions a day apart are two bursts of work. Sorting every timestamp
// into one list would charge the gap between them to a single capped interval,
// which is a real interval of work that never happened.
test("aggregateWindow sums active time per session, not across them", () => {
  const window = aggregateWindow([
    assistant({ sessionId: "a", timestamp: "2026-09-07T10:00:00.000Z" }),
    assistant({ sessionId: "a", timestamp: "2026-09-07T10:00:30.000Z" }),
    assistant({ sessionId: "b", timestamp: "2026-09-08T10:00:00.000Z" }),
    assistant({ sessionId: "b", timestamp: "2026-09-08T10:00:10.000Z" }),
  ]);

  expect(window.sessions).toBe(2);
  expect(window.active_seconds).toBe(40);
});

test("aggregateWindow survives records with no timestamps", () => {
  const window = aggregateWindow([assistant({ timestamp: undefined })]);

  expect(window.first_ts).toBeNull();
  expect(window.active_seconds).toBe(0);
});

// --- interaction ------------------------------------------------------------

test("isHumanTurn rejects the machinery that also arrives as role user", () => {
  expect(isHumanTurn({ type: "user", message: { content: "fix the auth bug" } })).toBe(true);
  expect(isHumanTurn({ type: "user", message: { content: "<system-reminder>x" } })).toBe(false);
  expect(isHumanTurn({ type: "user", message: { content: "   " } })).toBe(false);
  expect(isHumanTurn({ type: "user", isSidechain: true, message: { content: "go" } })).toBe(false);
  expect(isHumanTurn({ type: "user", message: { content: [{ type: "tool_result" }] } })).toBe(
    false,
  );
});

// A prompt typed while the agent is working never becomes a `user` record — it
// lands as a `queued_command` attachment. That is exactly the mid-flight
// correction `corrective_turns` claims to measure, so reading only `user`
// records scored every interruption as zero.
test("isHumanTurn reads a prompt queued while the agent was working", () => {
  expect(
    isHumanTurn({
      type: "attachment",
      attachment: { type: "queued_command", prompt: "put it under tools instead" },
    }),
  ).toBe(true);

  expect(isHumanTurn({ type: "attachment", attachment: { type: "file", prompt: "x" } })).toBe(
    false,
  );
  expect(
    isHumanTurn({ type: "attachment", attachment: { type: "queued_command", prompt: "  " } }),
  ).toBe(false);
});

test("aggregateInteraction counts a queued prompt as a correction", () => {
  const interaction = aggregateInteraction([
    { type: "user", sessionId: "s1", timestamp: "…01", message: { content: "build it" } },
    assistant({
      timestamp: "…02",
      message: { model: "claude-opus-5", content: [toolUse("Read")], usage: usage({}) },
    }),
    {
      type: "attachment",
      sessionId: "s1",
      timestamp: "…03",
      attachment: { type: "queued_command", prompt: "under tools, not scripts" },
    },
  ]);

  expect(interaction.user_turns).toBe(2);
  expect(interaction.corrective_turns).toBe(1);
});

// A dequeued prompt is sometimes echoed back as a `user` record. Both copies
// are one instruction and must not count twice.
test("aggregateInteraction collapses a queued prompt echoed as a user record", () => {
  const interaction = aggregateInteraction([
    assistant({
      timestamp: "…01",
      message: { model: "claude-opus-5", content: [toolUse("Read")], usage: usage({}) },
    }),
    {
      type: "attachment",
      sessionId: "s1",
      timestamp: "…02",
      attachment: { type: "queued_command", prompt: "use tools/" },
    },
    { type: "user", sessionId: "s1", timestamp: "…03", message: { content: "use tools/" } },
  ]);

  expect(interaction.user_turns).toBe(1);
});

// ...but two genuine `user` turns with the same text are two acts of steering.
test("aggregateInteraction does not collapse two identical typed turns", () => {
  const interaction = aggregateInteraction([
    { type: "user", sessionId: "s1", timestamp: "…01", message: { content: "continue" } },
    assistant({
      timestamp: "…02",
      message: { model: "claude-opus-5", content: [toolUse("Read")], usage: usage({}) },
    }),
    { type: "user", sessionId: "s1", timestamp: "…03", message: { content: "continue" } },
  ]);

  expect(interaction.user_turns).toBe(2);
});

// The opening brief is not a correction. Only turns that land after the agent
// has already picked up tools are steering it off a path it had started down.
test("aggregateInteraction counts only mid-flight turns as corrective", () => {
  const interaction = aggregateInteraction([
    { type: "user", sessionId: "s1", timestamp: "…01", message: { content: "build the thing" } },
    assistant({
      timestamp: "…02",
      message: { model: "claude-opus-5", content: [toolUse("Read")], usage: usage({}) },
    }),
    { type: "user", sessionId: "s1", timestamp: "…03", message: { content: "no, not that file" } },
  ]);

  expect(interaction.user_turns).toBe(2);
  expect(interaction.corrective_turns).toBe(1);
});

test("aggregateInteraction stops counting exploration at the first edit", () => {
  const interaction = aggregateInteraction([
    assistant({
      timestamp: "…01",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Grep")],
        usage: usage({ output_tokens: 100 }),
      },
    }),
    assistant({
      timestamp: "…02",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Edit", { file_path: "a.ts" })],
        usage: usage({ output_tokens: 20 }),
      },
    }),
    assistant({
      timestamp: "…03",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Edit", { file_path: "a.ts" })],
        usage: usage({ output_tokens: 5000 }),
      },
    }),
  ]);

  // The editing message itself counts — it is the last one spent getting there.
  expect(interaction.tokens_before_first_edit).toBe(120);
});

// A second session re-reading the same files to find its feet is exactly the
// waste this field exists to surface, so it is charged again rather than being
// hidden behind the first session's answer — but only once that session shows
// an edit of its own. Session `b` below never edits anything, so its boundary
// is unknown and its tokens are not banked. Counting them would assert that
// every token it spent was exploration, which is a different claim entirely.
test("aggregateInteraction banks a session's exploration only once it edits", () => {
  const interaction = aggregateInteraction([
    assistant({
      sessionId: "a",
      timestamp: "…01",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Edit", { file_path: "a.ts" })],
        usage: usage({ output_tokens: 10 }),
      },
    }),
    assistant({
      sessionId: "b",
      timestamp: "…02",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Grep")],
        usage: usage({ output_tokens: 70 }),
      },
    }),
  ]);

  expect(interaction.tokens_before_first_edit).toBe(10);
  expect(interaction.sessions_with_observed_edit).toBe(1);
});

test("aggregateInteraction records skills, subagents and edit churn", () => {
  const interaction = aggregateInteraction([
    assistant({
      timestamp: "…01",
      message: {
        model: "claude-opus-5",
        content: [
          toolUse("Skill", { skill: "prep-pr" }),
          toolUse("Agent", { subagent_type: "Explore" }),
          toolUse("Edit", { file_path: "a.ts" }),
          toolUse("Edit", { file_path: "a.ts" }),
          toolUse("Edit", { file_path: "a.ts" }),
          toolUse("Edit", { file_path: "b.ts" }),
        ],
        usage: usage({}),
      },
    }),
  ]);

  expect(interaction.skills).toEqual({ "prep-pr": 1 });
  expect(interaction.subagents).toEqual({ Explore: 1 });
  expect(interaction.edit_churn).toEqual({ files_edited_3plus: 1, max_edits_one_file: 3 });
  expect(interaction.tool_calls.Edit).toBe(4);
});

// --- diff -------------------------------------------------------------------

test("classifyPath puts generated files ahead of every other bucket", () => {
  expect(classifyPath("bun.lock")).toBe("generated");
  expect(classifyPath(".changeset/nervous-pugs-cheer.md")).toBe("generated");
  expect(classifyPath("cire/db/drizzle/0003_add_vendors.sql")).toBe("generated");
  expect(classifyPath("osn/api/tests/auth.test.ts")).toBe("test");
  expect(classifyPath("wiki/systems/sessions.md")).toBe("docs");
  expect(classifyPath("README.md")).toBe("docs");
  expect(classifyPath(".github/workflows/ci.yml")).toBe("config");
  expect(classifyPath("osn/api/src/routes/auth.ts")).toBe("source");
});

test("parseNumstat buckets lines and collects packages", () => {
  const diff = parseNumstat(
    [
      "312\t88\tosn/api/src/routes/auth.ts",
      "140\t0\tosn/api/tests/auth.test.ts",
      "210\t40\twiki/systems/sessions.md",
      "800\t60\tbun.lock",
      "12\t2\tshared/crypto/src/index.ts",
    ].join("\n"),
    6,
  );

  expect(diff.loc.source).toEqual({ added: 324, deleted: 90 });
  expect(diff.loc.test).toEqual({ added: 140, deleted: 0 });
  expect(diff.loc.generated).toEqual({ added: 800, deleted: 60 });
  expect(diff.files.source).toBe(2);
  expect(diff.packages).toEqual(["osn/api", "shared/crypto"]);
  expect(parseNumstat("1\t0\ttools/pr-metrics/index.ts", 1).packages).toEqual(["tools/pr-metrics"]);
  expect(diff.commits).toBe(6);
});

test("parseNumstat counts a binary file without inventing lines", () => {
  const diff = parseNumstat("-\t-\tcire/invites/public/hero.webp", 1);

  expect(diff.files.source).toBe(1);
  expect(diff.loc.source).toEqual({ added: 0, deleted: 0 });
});

test("parseNumstat flags a migration", () => {
  expect(parseNumstat("5\t0\tcire/db/drizzle/0004_x.sql", 1).touches_migration).toBe(true);
  expect(parseNumstat("5\t0\tosn/api/src/a.ts", 1).touches_migration).toBe(false);
});

// --- declared complexity ----------------------------------------------------

test("declaredFromLabels reads a confirmed rating", () => {
  expect(declaredFromLabels(["product:cire", "complexity:3"])).toEqual({
    declared: 3,
    method: "confirmed",
  });
});

test("declaredFromLabels marks an unconfirmed rating", () => {
  expect(declaredFromLabels(["complexity:5", "complexity:unconfirmed"])).toEqual({
    declared: 5,
    method: "unconfirmed",
  });
});

test("declaredFromLabels returns none when no rating is present", () => {
  expect(declaredFromLabels(["product:osn-core", "area:ops"])).toEqual({
    declared: null,
    method: "none",
  });
});

// The scale is 1/2/3/5/8. A `complexity:4` is somebody inventing a value, and
// silently honouring it would put a number in the denominator that the rubric
// never defined.
test("declaredFromLabels rejects a rating outside the Fibonacci scale", () => {
  expect(declaredFromLabels(["complexity:4"]).declared).toBeNull();
  expect(declaredFromLabels(["complexity:13"]).declared).toBeNull();
});

// Two ratings is a labelling mistake, not a value to average. Reading it as
// unrated makes the mistake visible instead of quietly resolving it.
test("declaredFromLabels treats two ratings as unrated", () => {
  expect(declaredFromLabels(["complexity:2", "complexity:5"]).declared).toBeNull();
});

test("declaredFromLabels ignores the unconfirmed marker on its own", () => {
  expect(declaredFromLabels(["complexity:unconfirmed"])).toEqual({
    declared: null,
    method: "none",
  });
});

// --- slug -------------------------------------------------------------------

test("branchSlug flattens a branch into one filename", () => {
  expect(branchSlug("feat/pr-session-metrics")).toBe("feat-pr-session-metrics");
  expect(branchSlug("fix/osn-api/bot~traffic")).toBe("fix-osn-api-bot-traffic");
  expect(branchSlug("///")).toBe("unknown");
});

// --- edits made through the shell ------------------------------------------

// This repository's own agent instructions tell agents to change files "with
// sed, heredocs, or short scripts, rather than using the dedicated Edit tool".
// Counting only Edit/Write meant 15 of the first 34 pull requests changed real
// source with no observed edit at all, and each reported 100% exploration.
test("isFileWritingCommand sees the shell forms that write files", () => {
  expect(isFileWritingCommand("sed -i '' 's/a/b/' src/x.ts")).toBe(true);
  expect(isFileWritingCommand("cat > src/x.ts <<'EOF'")).toBe(true);
  expect(isFileWritingCommand("echo hi >> notes.md")).toBe(true);
  expect(isFileWritingCommand("printf '%s' x | tee config.json")).toBe(true);
  expect(isFileWritingCommand("mv old.ts new.ts")).toBe(true);
});

// A false positive moves the boundary too early and under-reports exploration,
// which is the more misleading direction — so the read-only shapes that appear
// in almost every command must not count.
test("isFileWritingCommand ignores redirects that write nothing", () => {
  expect(isFileWritingCommand("bun test 2>&1 | tail -5")).toBe(false);
  expect(isFileWritingCommand("command -v gh >/dev/null")).toBe(false);
  expect(isFileWritingCommand("ls -la")).toBe(false);
  expect(isFileWritingCommand("grep -rn 'x' src/")).toBe(false);
});

test("aggregateInteraction treats a shell write as the first edit", () => {
  const interaction = aggregateInteraction([
    assistant({
      timestamp: "…01",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Grep")],
        usage: usage({ output_tokens: 100 }),
      },
    }),
    assistant({
      timestamp: "…02",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Bash", { command: "sed -i '' 's/a/b/' src/x.ts" })],
        usage: usage({ output_tokens: 20 }),
      },
    }),
    assistant({
      timestamp: "…03",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Bash", { command: "bun test" })],
        usage: usage({ output_tokens: 9000 }),
      },
    }),
  ]);

  expect(interaction.tokens_before_first_edit).toBe(120);
});

// "We never saw the boundary" and "every token was exploration" are different
// claims. Reporting the second when only the first is true is what broke the
// per-package ranking.
test("aggregateInteraction reports null when no edit was ever observed", () => {
  const interaction = aggregateInteraction([
    assistant({
      timestamp: "…01",
      message: {
        model: "claude-opus-5",
        content: [toolUse("Read"), toolUse("Grep")],
        usage: usage({ output_tokens: 5000 }),
      },
    }),
  ]);

  expect(interaction.tokens_before_first_edit).toBeNull();
  expect(interaction.sessions_with_observed_edit).toBe(0);
});
