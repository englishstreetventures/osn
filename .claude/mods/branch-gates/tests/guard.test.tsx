import { expect, test } from "claude-code/testing";

import { world } from "./world";

test("a guard refusal raises one toast with its reason", async ($, on) => {
  const fake = world(on, {
    tool: {
      isError: true,
      result: undefined,
      text: "PreToolUse:Bash hook error: agent-guard: `bun install` without `--frozen-lockfile`.",
    },
  });

  const ran = await $.tool.call({ tool: "Bash", command: "bun install" });
  await fake.clock.settle();

  expect(ran.isError).toBe(true);
  expect(fake.toasts).toEqual(["Guard: `bun install` without `--frozen-lockfile`."]);
});

const QUIET = [
  [
    "a failing test whose output mentions agent-guard:",
    "Bash",
    'FAIL scripts/tests/agent-guard.test.ts\nexpected "PreToolUse:Bash hook error: agent-guard: x"',
    true,
  ],
  [
    "the refusal text in a result that is no error",
    "Bash",
    "PreToolUse:Bash hook error: agent-guard: x",
    false,
  ],
  ["another tool's refusal text", "Edit", "PreToolUse:Bash hook error: agent-guard: x", true],
] as const;

for (const [name, tool, text, isError] of QUIET) {
  test(`no toast for ${name}`, async ($, on) => {
    const fake = world(on, {
      tool: isError ? { isError: true, result: undefined, text } : { result: {}, text },
    });

    if (tool === "Edit") {
      await $.tool.call({ tool, file_path: "/repo/a.ts", old_string: "a", new_string: "b" });
    } else {
      await $.tool.call({ tool, command: "bun test" });
    }
    await fake.clock.settle();

    expect(fake.toasts).toEqual([]);
  });
}
