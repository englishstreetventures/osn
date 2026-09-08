// `gitBranch` is a property of the session, captured once when it starts and
// inherited by every subagent, so a subagent working in a task worktree records
// the branch its PARENT started on. These tests cover the resolver that reads
// the branch back out of the dispatch prompt instead.
//
// They live in their own file rather than at the end of `pr-metrics.test.ts`
// because #931 appends there; a separate file has no conflict to resolve.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRecordsForBranch,
  recordsByBranch,
  resolveDispatchBranch,
  unattributedSubagentFiles,
} from "../index";

/** A sessions tree shaped like `~/.claude/projects`. Returns the root. */
async function tree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-dispatch-"));
  await mkdir(join(dir, "proj/sess-1/subagents"), { recursive: true });
  return dir;
}

/** The parent's assistant record carrying the dispatch. The tool is named
 * `Agent` in real transcripts — never `Task`. */
function dispatch(toolUseId: string, prompt: string, gitBranch = "main"): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    gitBranch,
    timestamp: "2026-09-08T10:00:00.000Z",
    message: {
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { prompt } }],
    },
  });
}

test("resolves the branch from a TASK-BRANCH marker in the parent's dispatch prompt", async () => {
  const dir = await tree();
  try {
    const subagent = join(dir, "proj/sess-1/subagents/agent-aaa.jsonl");
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_1", "TASK-BRANCH: feat/x\n\nDo the thing.")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
      JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_1", spawnDepth: 1 }),
    );
    await writeFile(
      subagent,
      `${JSON.stringify({ type: "assistant", gitBranch: "main", isSidechain: true })}\n`,
    );

    expect(resolveDispatchBranch(subagent)).toBe("feat/x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 79 of this machine's 363 subagent transcripts are `spawnDepth: 2`, and every
// one of their parents is a sibling `subagents/*.jsonl` rather than the session
// file. Searching only the session file finds nothing for 8.3% of subagent spend.
test("finds the dispatch in a sibling subagent transcript, not just the session file", async () => {
  const dir = await tree();
  try {
    const child = join(dir, "proj/sess-1/subagents/agent-child.jsonl");
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_parent", "TASK-BRANCH: feat/x\n\nOuter.")}\n`,
    );

    // The depth-1 agent dispatches the depth-2 one; its transcript holds the
    // `tool_use`, and it carries a marker of its own.
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-parent.jsonl"),
      `${dispatch("toolu_child", "TASK-BRANCH: feat/x\n\nInner.")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-child.meta.json"),
      JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_child", spawnDepth: 2 }),
    );
    await writeFile(
      child,
      `${JSON.stringify({ type: "assistant", gitBranch: "main", isSidechain: true })}\n`,
    );

    expect(resolveDispatchBranch(child)).toBe("feat/x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The depth-2 prompts are written by `stress-plan`, `prep-pr` and
// `superpowers:subagent-driven-development` — the last a plugin nobody in this
// repository can edit — so requiring a marker on every dispatch would lose
// their spend for good. A child with no marker inherits the branch of whatever
// dispatched it.
test("a child with no marker inherits the branch of the transcript that dispatched it", async () => {
  const dir = await tree();
  try {
    const child = join(dir, "proj/sess-1/subagents/agent-child.jsonl");
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_parent", "TASK-BRANCH: feat/x\n\nOuter.")}\n`,
    );

    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-parent.meta.json"),
      JSON.stringify({ toolUseId: "toolu_parent", spawnDepth: 1 }),
    );
    // No marker in the inner dispatch — this is the real shape.
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-parent.jsonl"),
      `${dispatch("toolu_child", "Attack the plan at NEW-FEAT.md. Report findings.")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-child.meta.json"),
      JSON.stringify({ toolUseId: "toolu_child", spawnDepth: 2 }),
    );
    await writeFile(
      child,
      `${JSON.stringify({ type: "assistant", gitBranch: "main", isSidechain: true })}\n`,
    );

    expect(resolveDispatchBranch(child)).toBe("feat/x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns null when no marker appears anywhere in the chain", async () => {
  const dir = await tree();
  try {
    const subagent = join(dir, "proj/sess-1/subagents/agent-aaa.jsonl");
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_1", "Just do the thing.")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
      JSON.stringify({ toolUseId: "toolu_1", spawnDepth: 1 }),
    );
    await writeFile(
      subagent,
      `${JSON.stringify({ type: "assistant", gitBranch: "main", isSidechain: true })}\n`,
    );

    expect(resolveDispatchBranch(subagent)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The reader is where the resolver has to actually bite. Two things break it if
// missed: the cheap `line.includes(branch)` reject drops these lines before the
// parse (they are stamped `main` and carry `feat/x` nowhere), and the equality
// test that follows compares the stamped branch rather than the resolved one.
test("readRecordsForBranch returns subagent records the marker assigns to the branch", async () => {
  const dir = await tree();
  try {
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_1", "TASK-BRANCH: feat/x\n\nGo.")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
      JSON.stringify({ toolUseId: "toolu_1", spawnDepth: 1 }),
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        gitBranch: "main",
        isSidechain: true,
        requestId: "req-1",
        timestamp: "2026-09-08T10:01:00.000Z",
        message: { model: "claude-opus-5", usage: { output_tokens: 1234 } },
      })}\n`,
    );

    const records = readRecordsForBranch(dir, "feat/x");

    expect(records).toHaveLength(1);
    expect(records[0]?.message?.usage?.output_tokens).toBe(1234);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Claude Code sometimes writes one conversation into two session files: 615 of
// this machine's assistant records, 5.2% of session spend, are present twice.
// The reader has always counted both.
test("readRecordsForBranch counts a record present in two session files once", async () => {
  const dir = await tree();
  try {
    const line = `${JSON.stringify({
      type: "assistant",
      sessionId: "sess-1",
      gitBranch: "feat/x",
      isSidechain: false,
      requestId: "req-dup",
      timestamp: "2026-09-08T10:02:00.000Z",
      message: { model: "claude-opus-5", usage: { output_tokens: 500 } },
    })}\n`;
    await writeFile(join(dir, "proj/sess-1.jsonl"), line);
    await writeFile(join(dir, "proj/sess-2.jsonl"), line);

    expect(readRecordsForBranch(dir, "feat/x")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `backfill.ts` had its own reader grouping on `gitBranch`, so a backfilled card
// and a live card disagreed on the same branch. Both now go through this.
test("recordsByBranch groups a marker-resolved subagent file under the marked branch", async () => {
  const dir = await tree();
  try {
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_1", "TASK-BRANCH: feat/x\n\nGo.")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
      JSON.stringify({ toolUseId: "toolu_1", spawnDepth: 1 }),
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        gitBranch: "main",
        isSidechain: true,
        requestId: "req-1",
        message: { model: "claude-opus-5", usage: { output_tokens: 99 } },
      })}\n`,
    );

    const byBranch = recordsByBranch(dir);

    expect(byBranch.get("feat/x")).toHaveLength(1);
    // `main` is not a task branch and never gets a card.
    expect(byBranch.has("main")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Nothing enforces the marker — it is a line a skill tells an agent to write.
// So a forgotten one has to be visible, or it silently reproduces the bug this
// whole change exists to fix.
test("counts subagent files that resolve to nothing under a main or HEAD session", async () => {
  const dir = await tree();
  try {
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_1", "No marker here.", "HEAD")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
      JSON.stringify({ toolUseId: "toolu_1", spawnDepth: 1 }),
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.jsonl"),
      `${JSON.stringify({ type: "assistant", gitBranch: "HEAD", isSidechain: true, requestId: "r1" })}\n`,
    );

    expect(unattributedSubagentFiles(dir)).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resolved subagent file is not counted as unattributed", async () => {
  const dir = await tree();
  try {
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      `${dispatch("toolu_1", "TASK-BRANCH: feat/x\n\nGo.", "HEAD")}\n`,
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
      JSON.stringify({ toolUseId: "toolu_1", spawnDepth: 1 }),
    );
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-aaa.jsonl"),
      `${JSON.stringify({ type: "assistant", gitBranch: "HEAD", isSidechain: true, requestId: "r1" })}\n`,
    );

    expect(unattributedSubagentFiles(dir)).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-E1. The exclusion is the only thing keeping one branch's delegated spend
// off another branch's card, and a positive-only suite cannot see it: with the
// guard deleted every test above still passed, while every marked transcript
// would land on every card.
test("readRecordsForBranch excludes a subagent marked for a different branch", async () => {
  const dir = await tree();
  try {
    await writeFile(
      join(dir, "proj/sess-1.jsonl"),
      [
        dispatch("toolu_x", "TASK-BRANCH: feat/x\n\nMine."),
        dispatch("toolu_y", "TASK-BRANCH: feat/y\n\nSomeone else's."),
      ].join("\n"),
    );

    for (const [name, tool, out] of [
      ["agent-x", "toolu_x", 11],
      ["agent-y", "toolu_y", 22],
    ] as const) {
      await writeFile(
        join(dir, `proj/sess-1/subagents/${name}.meta.json`),
        JSON.stringify({ toolUseId: tool, spawnDepth: 1 }),
      );
      await writeFile(
        join(dir, `proj/sess-1/subagents/${name}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          gitBranch: "main",
          isSidechain: true,
          requestId: `req-${name}`,
          message: { model: "claude-opus-5", usage: { output_tokens: out } },
        })}\n`,
      );
    }

    // An equality, not an absence: this fails whether feat/y leaks in or
    // feat/x drops out.
    const output = readRecordsForBranch(dir, "feat/x").map(
      (r) => r.message?.usage?.output_tokens ?? 0,
    );
    expect(output).toEqual([11]);
    expect(readRecordsForBranch(dir, "feat/y").map((r) => r.message?.usage?.output_tokens)).toEqual(
      [22],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-E3. The third arm of the warning's condition: an unmarked subagent whose
// own gitBranch is already a real task branch is fine, and counting it would
// make the warning cry wolf on a healthy run.
test("unattributedSubagentFiles ignores an unmarked subagent already on a task branch", async () => {
  const dir = await tree();
  try {
    // No meta file at all, so the resolver returns null.
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-fine.jsonl"),
      `${JSON.stringify({ type: "assistant", gitBranch: "feat/already-right", isSidechain: true })}\n`,
    );
    expect(unattributedSubagentFiles(dir)).toBe(0);

    // A record with no branch at all is the other arm, and does count.
    await writeFile(
      join(dir, "proj/sess-1/subagents/agent-nobranch.jsonl"),
      `${JSON.stringify({ type: "assistant", isSidechain: true })}\n`,
    );
    expect(unattributedSubagentFiles(dir)).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-E4. Both readers call the resolver on every subagent file they see, so one
// bad sidecar escaping the catch would abort the whole card rather than
// degrade it.
test("resolveDispatchBranch survives a missing, empty or unparseable sidecar", async () => {
  const dir = await tree();
  try {
    const base = join(dir, "proj/sess-1/subagents");
    const record = `${JSON.stringify({ type: "assistant", gitBranch: "main", isSidechain: true })}\n`;

    await writeFile(join(base, "agent-nometa.jsonl"), record);

    await writeFile(join(base, "agent-nokey.jsonl"), record);
    await writeFile(join(base, "agent-nokey.meta.json"), JSON.stringify({ agentType: "x" }));

    await writeFile(join(base, "agent-garbage.jsonl"), record);
    await writeFile(join(base, "agent-garbage.meta.json"), "not json at all");

    expect(resolveDispatchBranch(join(base, "agent-nometa.jsonl"))).toBeNull();
    expect(resolveDispatchBranch(join(base, "agent-nokey.jsonl"))).toBeNull();
    expect(resolveDispatchBranch(join(base, "agent-garbage.jsonl"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-E4, the cycle. `parentCandidates` returns every sibling, so two files each
// naming the other's tool_use id recurse until the guard stops them. This test
// fails by hanging or overflowing the stack, not by asserting.
test("resolveDispatchBranch terminates when two siblings dispatch each other", async () => {
  const dir = await tree();
  try {
    const base = join(dir, "proj/sess-1/subagents");
    await writeFile(join(dir, "proj/sess-1.jsonl"), "");

    await writeFile(join(base, "agent-a.jsonl"), `${dispatch("toolu_b", "No marker here.")}\n`);
    await writeFile(join(base, "agent-a.meta.json"), JSON.stringify({ toolUseId: "toolu_a" }));
    await writeFile(join(base, "agent-b.jsonl"), `${dispatch("toolu_a", "None here either.")}\n`);
    await writeFile(join(base, "agent-b.meta.json"), JSON.stringify({ toolUseId: "toolu_b" }));

    expect(resolveDispatchBranch(join(base, "agent-a.jsonl"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-U1. `requestId` is the assistant side; `uuid` is the fallback for the
// records `user_turns` and `corrective_turns` are counted from. If it never
// fires those numbers double on a duplicated conversation.
test("the uuid fallback dedupes records that carry no requestId", async () => {
  const dir = await tree();
  try {
    const assistant = JSON.stringify({
      type: "assistant",
      gitBranch: "feat/x",
      requestId: "req-dup",
      message: { model: "claude-opus-5", usage: { output_tokens: 5 } },
    });
    const user = JSON.stringify({ type: "user", gitBranch: "feat/x", uuid: "u-dup" });
    const other = JSON.stringify({ type: "user", gitBranch: "feat/x", uuid: "u-different" });

    await writeFile(join(dir, "proj/sess-1.jsonl"), [assistant, user, other].join("\n"));
    await writeFile(join(dir, "proj/sess-2.jsonl"), [assistant, user].join("\n"));

    // One assistant, one deduped user, one near-neighbour that must survive —
    // deduping and dropping look the same from a single length assertion.
    expect(readRecordsForBranch(dir, "feat/x")).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-S1. `backfill` reads through `recordsByBranch`, so an un-deduped pass here
// is the live-card/backfilled-card disagreement the shared reader exists to end.
test("recordsByBranch dedupes a record present in two session files", async () => {
  const dir = await tree();
  try {
    const line = JSON.stringify({
      type: "assistant",
      gitBranch: "feat/x",
      requestId: "req-dup",
      message: { model: "claude-opus-5", usage: { output_tokens: 7 } },
    });
    await writeFile(join(dir, "proj/sess-1.jsonl"), `${line}\n`);
    await writeFile(join(dir, "proj/sess-2.jsonl"), `${line}\n`);

    expect(recordsByBranch(dir).get("feat/x")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// T-S2. The producer is `.claude/skills/orchestrate/SKILL.md` and the consumer
// is this parser; nothing else couples them. The last case reads the marker out
// of the skill file itself, so the two fail together the day either changes.
test("the marker is matched on its own line and nowhere else", async () => {
  const skill = await Bun.file(
    new URL("../../../.claude/skills/orchestrate/SKILL.md", import.meta.url).pathname,
  ).text();
  // The form the skill actually instructs, with a real branch substituted.
  expect(skill).toContain("TASK-BRANCH: <branch>");

  const cases: [string, string | null][] = [
    ["TASK-BRANCH: feat/x\n\nGo.", "feat/x"],
    // Not required to be the first line — a dispatch may lead with a worktree
    // instruction. This is the `m` flag's whole reason.
    ["Work only in /tmp/wt.\n\nTASK-BRANCH: feat/x\n\nGo.", "feat/x"],
    // Quoted mid-sentence: must not card someone else's branch.
    ["Use TASK-BRANCH: feat/x here.", null],
    // Trailing note: matches nothing, and the warning then counts the file.
    ["TASK-BRANCH: feat/x (worktree)", null],
  ];

  for (const [prompt, expected] of cases) {
    const dir = await tree();
    try {
      await writeFile(join(dir, "proj/sess-1.jsonl"), `${dispatch("toolu_1", prompt)}\n`);
      await writeFile(
        join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
        JSON.stringify({ toolUseId: "toolu_1" }),
      );
      const file = join(dir, "proj/sess-1/subagents/agent-aaa.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "assistant", isSidechain: true })}\n`);

      expect(resolveDispatchBranch(file)).toBe(expected as string);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// S-M1. `~/.claude/projects` holds every project on this machine, and the cards
// this tool writes are committed to a public repository. A marker is an
// attribution hint an agent wrote, not a provenance claim, so it must not on
// its own admit a transcript from another checkout — two projects using
// `fix/flaky-test` in the same week is a collision, not an attack.
test("a marked transcript from another project is not admitted to this repo's card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-scope-"));
  try {
    for (const project of ["-Users-ac--work-osn-git-mine", "-Users-ac--work-otherproj-main"]) {
      await mkdir(join(dir, project, "sess-1/subagents"), { recursive: true });
      await writeFile(
        join(dir, project, "sess-1.jsonl"),
        `${dispatch("toolu_1", "TASK-BRANCH: feat/x\n\nGo.")}\n`,
      );
      await writeFile(
        join(dir, project, "sess-1/subagents/agent-a.meta.json"),
        JSON.stringify({ toolUseId: "toolu_1" }),
      );
      await writeFile(
        join(dir, project, "sess-1/subagents/agent-a.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          gitBranch: "main",
          isSidechain: true,
          requestId: `req-${project}`,
          message: { model: "claude-opus-5", usage: { output_tokens: 1 } },
        })}\n`,
      );
    }

    const scoped = readRecordsForBranch(dir, "feat/x", {
      repoPaths: ["/Users/ac/.work/osn.git"],
    });

    expect(scoped.map((r) => r.requestId)).toEqual(["req--Users-ac--work-osn-git-mine"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// S-L2. A dispatch prompt routinely quotes text this repository did not author —
// issue bodies, review comments, fetched pages. A planted marker further down
// must not re-point a subagent's whole spend onto another branch's public card.
test("a marker planted below the window, or naming an implausible ref, is ignored", async () => {
  const quoted =
    "TASK-BRANCH: feat/real\n\nThe issue says:\n\n" +
    "TASK-BRANCH: feat/attacker-controlled\n\nHandle it.";

  const cases: [string, string | null][] = [
    // The real marker wins; the quoted one is out of the window anyway.
    [quoted, "feat/real"],
    // Only a quoted marker, well below the window: nothing is attributed.
    ["Context follows.\n\n\n\nTASK-BRANCH: feat/planted\n", null],
    // Implausible refs name no card rather than an unexpected one.
    ["TASK-BRANCH: ../../etc/passwd", null],
    ["TASK-BRANCH: -rf", null],
  ];

  for (const [prompt, expected] of cases) {
    const dir = await tree();
    try {
      await writeFile(join(dir, "proj/sess-1.jsonl"), `${dispatch("toolu_1", prompt)}\n`);
      await writeFile(
        join(dir, "proj/sess-1/subagents/agent-aaa.meta.json"),
        JSON.stringify({ toolUseId: "toolu_1" }),
      );
      const file = join(dir, "proj/sess-1/subagents/agent-aaa.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "assistant", isSidechain: true })}\n`);

      expect(resolveDispatchBranch(file)).toBe(expected as string);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
