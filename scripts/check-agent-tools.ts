#!/usr/bin/env bun
/**
 * Guard: an agent that lists its tools can call every MCP tool the skills it
 * reaches tell it to use.
 *
 * A `tools:` line in `.claude/agents/<name>.md` replaces the inherited tool
 * set, and a tool left off it is not an error anywhere: the agent finds the
 * call missing mid-task and falls back, or reports the step as not run. So
 * this reads each agent's body, follows every skill it names in backticks —
 * and every skill those name, through their reference files — and collects
 * each backticked `mcp__<server>__<tool>` name. One is covered by the exact
 * name or by `mcp__<server>__*` on the agent's line.
 *
 * An agent with no `tools:` line inherits everything and is not checked.
 *
 * Tests in scripts/tests/check-agent-tools.test.ts, which also run this
 * against the real tree on every pull request.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Servers every skill that names them also gives a shell fallback for, so an
 * agent without them still finishes the step. */
const OPTIONAL_SERVERS = new Set([
  // Obsidian's MCP runs only on the maintainer's Mac with Obsidian open; each
  // skill that names it says to drop to grep when it is absent.
  "obsidian-wiki",
]);

const MCP_NAME = /`(mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__[A-Za-z0-9_*]+)`/g;
const BACKTICKED = /`([a-z][a-z0-9-]*)`/g;

export type Finding = {
  readonly agent: string;
  readonly tool: string;
  readonly via: string;
};

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function markdownIn(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return markdownIn(full);
      return entry.name.endsWith(".md") ? readFileSync(full, "utf8") : "";
    })
    .join("\n");
}

function toolsLine(text: string): string[] | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const line = /^tools:\s*(.+)$/m.exec(front)?.[1];
  return line === undefined ? null : line.split(",").map((tool) => tool.trim());
}

function covered(tool: string, server: string, listed: readonly string[]): boolean {
  return (
    OPTIONAL_SERVERS.has(server) || listed.includes(tool) || listed.includes(`mcp__${server}__*`)
  );
}

export function checkAgentTools(root: string): readonly Finding[] {
  const agentsDir = join(root, ".claude/agents");
  const skillsDir = join(root, ".claude/skills");
  const skillText = new Map<string, string>();

  const skillNamesIn = (text: string): string[] =>
    [...new Set([...text.matchAll(BACKTICKED)].map((m) => m[1]))].filter((name) =>
      isDir(join(skillsDir, name)),
    );

  const textOf = (name: string): string => {
    const cached = skillText.get(name);
    if (cached !== undefined) return cached;
    const text = markdownIn(join(skillsDir, name));
    skillText.set(name, text);
    return text;
  };

  const findings: Finding[] = [];
  const agentFiles = readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .toSorted();

  for (const file of agentFiles) {
    const text = readFileSync(join(agentsDir, file), "utf8");
    const listed = toolsLine(text);
    if (listed === null) continue;

    const agent = file.replace(/\.md$/, "");
    const seen = new Set<string>();
    const queue = skillNamesIn(text);
    const sources: [string, string][] = [[agent, text]];

    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);

      const body = textOf(name);
      sources.push([name, body]);
      queue.push(...skillNamesIn(body));
    }

    const reported = new Set<string>();
    for (const [via, body] of sources) {
      for (const [, tool, server] of body.matchAll(MCP_NAME)) {
        if (reported.has(tool) || covered(tool, server, listed)) continue;
        reported.add(tool);
        findings.push({ agent, tool, via });
      }
    }
  }

  return findings;
}

if (import.meta.main) {
  const findings = checkAgentTools(new URL("../", import.meta.url).pathname);

  for (const { agent, tool, via } of findings) {
    process.stderr.write(
      `${agent}: \`${via}\` names ${tool}, which is not on its tools: line. Add it, or mcp__<server>__*.\n`,
    );
  }

  process.exit(findings.length > 0 ? 1 : 0);
}
