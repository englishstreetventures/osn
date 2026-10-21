import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The pull-request body skeleton and its shape check are written out twice: once
// in `write-pr` Step 1, once in `prep-pr`'s `cat > PR-BODY.md` block, and each
// skill checks the result with a `grep -c` naming the headings. A change to one
// copy and not the others produces a body that fails one skill's check and passes
// the other's. This test reads the four copies from the skill files and compares
// them.

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const writePr = read(".claude/skills/write-pr/SKILL.md");
const prepPr = read(".claude/skills/prep-pr/SKILL.md");

// The fenced block under "## Step 1 — The skeleton, first" in write-pr.
function writePrSkeleton(): string[] {
  const step = writePr.slice(writePr.indexOf("## Step 1 — The skeleton, first"));
  const block = step.match(/```markdown\n([\s\S]*?)\n```/);
  if (!block) throw new Error("write-pr: no markdown skeleton block under Step 1");
  return headings(block[1] ?? "");
}

// The heredoc body of prep-pr's `cat > PR-BODY.md <<'EOF'` block.
function prepPrSkeleton(): string[] {
  const block = prepPr.match(/cat > PR-BODY\.md <<'EOF'\n([\s\S]*?)\nEOF/);
  if (!block) throw new Error("prep-pr: no PR-BODY.md heredoc skeleton");
  return headings(block[1] ?? "");
}

// The six top-level headings a skeleton carries, in order.
function headings(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("## "));
}

// The heading list inside a `grep -c '^## \(A\|B\|…\)$'` shape check.
function shapeCheckHeadings(text: string): string[][] {
  const checks = [...text.matchAll(/grep -c '\^## \\\(([^)]*)\\\)\$'/g)];
  return checks.map((match) => (match[1] ?? "").split("\\|"));
}

const SIX = ["Impact", "Summary", "Workspaces affected", "Issues", "Decisions", "Test plan"];

describe("PR body skeleton", () => {
  test("write-pr's skeleton carries exactly the six permitted headings, in order", () => {
    expect(writePrSkeleton()).toEqual(SIX.map((name) => `## ${name}`));
  });

  test("prep-pr's skeleton carries exactly the same six headings, in order", () => {
    expect(prepPrSkeleton()).toEqual(writePrSkeleton());
  });

  test("every shape check names the six headings, and the same six", () => {
    const checks = [...shapeCheckHeadings(writePr), ...shapeCheckHeadings(prepPr)];

    expect(checks.length).toBeGreaterThan(0);
    for (const names of checks) {
      expect(names).toEqual(SIX);
    }
  });

  test("the sentence that states the count agrees with the skeleton", () => {
    // Both skills say the check must print 6. A different number here means
    // the skeleton and the check were changed apart.
    const counts = [...`${writePr}\n${prepPr}`.matchAll(/must print `(\d+)`/g)].map((m) => m[1]);

    expect(counts.length).toBeGreaterThan(0);
    for (const count of counts) {
      expect(count).toBe(String(SIX.length));
    }
  });
});
