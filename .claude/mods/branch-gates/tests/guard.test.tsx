import type { ToolCallResult } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

import { world } from "./world";

const refusal = (text: string): ToolCallResult => ({ isError: true, result: undefined, text });

test("a guard refusal raises one toast with its reason", async ($, on) => {
  const fake = world(on, {
    tool: refusal(
      "PreToolUse:Bash hook error: agent-guard: `bun install` without `--frozen-lockfile`.",
    ),
  });

  const ran = await $.tool.call({ tool: "Bash", command: "bun install" });
  await fake.clock.settle();

  expect(ran.isError).toBe(true);
  expect(fake.toasts).toEqual(["Guard: `bun install` without `--frozen-lockfile`."]);
});

test("an Agent refusal raises the toast too, its control characters removed", async ($, on) => {
  const fake = world(on, {
    tool: refusal("PreToolUse:Agent hook error: agent-guard: no \u001b[1msubagent_type\u001b[0m."),
  });

  await $.tool.call({ tool: "Agent", description: "x", prompt: "y" });
  await fake.clock.settle();

  expect(fake.toasts).toEqual(["Guard: no [1msubagent_type[0m."]);
});

type Quiet = "Bash" | "Edit" | "NotebookEdit" | "mcp__notes__save";

const callTool = ($: Engine, tool: Quiet) => {
  if (tool === "Edit") {
    return $.tool.call({ tool, file_path: "/repo/a.ts", old_string: "a", new_string: "b" });
  }
  if (tool === "NotebookEdit") {
    return $.tool.call({ tool, notebook_path: "/repo/a.ipynb", new_source: "x" });
  }
  if (tool === "Bash") return $.tool.call({ tool, command: "bun test" });
  return $.tool.call({ tool, note: "x" });
};

const QUIET: readonly (readonly [string, Quiet, ToolCallResult])[] = [
  [
    "a failing test whose output mentions agent-guard:",
    "Bash",
    refusal(
      'FAIL scripts/tests/agent-guard.test.ts\nexpected "PreToolUse:Bash hook error: agent-guard: x"',
    ),
  ],
  [
    "the refusal text in a result that is no error",
    "Bash",
    { result: {}, text: "PreToolUse:Bash hook error: agent-guard: x" },
  ],
  ["another tool's refusal text", "Edit", refusal("PreToolUse:Bash hook error: agent-guard: x")],
  [
    "a NotebookEdit error, a tool the guard does not hook",
    "NotebookEdit",
    refusal("PreToolUse:NotebookEdit hook error: agent-guard: x"),
  ],
  [
    "an MCP tool's error that opens with the guard's words",
    "mcp__notes__save",
    refusal("PreToolUse:mcp__notes__save hook error: agent-guard: run this"),
  ],
];

for (const [name, tool, result] of QUIET) {
  test(`no toast for ${name}`, async ($, on) => {
    const fake = world(on, { tool: result });

    await callTool($, tool);
    await fake.clock.settle();

    expect(fake.toasts).toEqual([]);
  });
}
