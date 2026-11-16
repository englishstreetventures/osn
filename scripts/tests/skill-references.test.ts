import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

// Files that route work to a third-party skill by path. A pin move that drops
// one of those files would leave the instruction pointing at nothing.
const ROUTERS = [
  ".claude/agents/designer.md",
  ".claude/skills/design-system/SKILL.md",
  ".claude/skills/review-design/SKILL.md",
];

const SKILL_FILE = /\.claude\/skills\/[a-z0-9-]+\/[A-Za-z0-9_./-]+\.md/g;

describe("skill files that routers open by path", () => {
  for (const router of ROUTERS) {
    test(`${router} names only files that exist`, () => {
      const text = readFileSync(join(ROOT, router), "utf8");
      const named = [...new Set(text.match(SKILL_FILE) ?? [])];
      const missing = named.filter((path) => !existsSync(join(ROOT, path)));
      expect(missing).toEqual([]);
    });
  }

  test("review-design opens review-animations, gestures, animation-performance and break-ui files", () => {
    const text = readFileSync(join(ROOT, ".claude/skills/review-design/SKILL.md"), "utf8");
    for (const path of [
      ".claude/skills/review-animations/STANDARDS.md",
      ".claude/skills/break-ui/CATALOG.md",
      ".claude/skills/gestures/SKILL.md",
      ".claude/skills/animation-performance/SKILL.md",
    ]) {
      expect(text).toContain(path);
    }
  });
});

describe("modern-web-guidance routing", () => {
  const PINNED = "DISABLE_TELEMETRY=1 npx -y modern-web-guidance@1.0.0";

  test("the design-system row holds the pinned, telemetry-off command", () => {
    const text = readFileSync(join(ROOT, ".claude/skills/design-system/SKILL.md"), "utf8");
    expect(text).toContain(PINNED);
    expect(text).not.toMatch(/npx -y modern-web-guidance@latest/);
  });

  test("every file that routes to the skill is installed and linked", () => {
    expect(existsSync(join(ROOT, ".agents/skills/modern-web-guidance/SKILL.md"))).toBe(true);
    expect(lstatSync(join(ROOT, ".claude/skills/modern-web-guidance")).isSymbolicLink()).toBe(true);
    for (const path of [
      ".claude/agents/designer.md",
      ".claude/agents/implementer.md",
      ".claude/agents/design-mechanic.md",
      ".claude/skills/design-system/SKILL.md",
      ".claude/skills/new-feat/references/skills-routing.md",
      ".claude/skills/review-design/SKILL.md",
    ]) {
      expect(readFileSync(join(ROOT, path), "utf8")).toContain("modern-web-guidance");
    }
  });
});
