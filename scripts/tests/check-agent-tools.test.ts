import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAgentTools } from "../check-agent-tools";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const REAL_SCRIPT = new URL("../check-agent-tools.ts", import.meta.url).pathname;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "check-agent-tools-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function agent(name: string, tools: string | null, body: string) {
  await mkdir(join(root, ".claude/agents"), { recursive: true });
  const toolsLine = tools === null ? "" : `tools: ${tools}\n`;
  await writeFile(
    join(root, ".claude/agents", `${name}.md`),
    `---\nname: ${name}\nmodel: opus\n${toolsLine}---\n\n${body}\n`,
  );
}

async function skill(name: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, ".claude/skills", name, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
}

test("an MCP tool a reachable skill names, missing from the agent's list, is a finding", async () => {
  await agent("designer", "Read, Bash", "Load the `design-system` skill first.");
  await skill("design-system", { "SKILL.md": "Open it with `mcp__claude-in-chrome__navigate`." });

  expect(await checkAgentTools(root)).toEqual([
    { agent: "designer", tool: "mcp__claude-in-chrome__navigate", via: "design-system" },
  ]);
});

test("a server wildcard on the list covers every tool of that server", async () => {
  await agent("designer", "Read, mcp__claude-in-chrome__*", "Load the `design-system` skill.");
  await skill("design-system", {
    "SKILL.md": "Use `mcp__claude-in-chrome__*`, e.g. `mcp__claude-in-chrome__navigate`.",
  });

  expect(await checkAgentTools(root)).toEqual([]);
});

test("a skill reached through another skill, or its references, counts", async () => {
  await agent("implementer", "Read, Bash", "Start with the `new-feat` skill.");
  await skill("new-feat", { "SKILL.md": "Then run `prep-pr`." });
  await skill("prep-pr", { "references/steps.md": "Call `mcp__resend__send_email`." });

  expect(await checkAgentTools(root)).toEqual([
    { agent: "implementer", tool: "mcp__resend__send_email", via: "prep-pr" },
  ]);
});

test("a server every skill gives a shell fallback for is not required", async () => {
  await agent("reviewer", "Read, Bash", "Run the `review-docs` skill.");
  await skill("review-docs", {
    "SKILL.md": "On a full sweep `mcp__obsidian-wiki__find_broken_links`.",
  });

  expect(await checkAgentTools(root)).toEqual([]);
});

test("an agent with no tools line inherits everything and is not checked", async () => {
  await agent("general", null, "Load the `design-system` skill.");
  await skill("design-system", { "SKILL.md": "`mcp__claude-in-chrome__navigate`" });

  expect(await checkAgentTools(root)).toEqual([]);
});

test("the real tree has no agent missing a tool its skills name", async () => {
  const proc = Bun.spawn(["bun", REAL_SCRIPT], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
});
