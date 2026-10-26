import type { Gate, GateStatus } from "../types";

export type Plan = { issue: string | null; gates: Gate[] };

const MAX_GATES = 30;
const SEPARATOR = /^\|?\s*:?-{3,}/;
const BULLET = /^([-*+]|\d+\.)\s+/;
const SECTION_END = /^#{1,2}\s/;

const classify = (text: string): GateStatus => {
  if (/NOT RUN|pending|todo|to do|not yet|\[ \]/i.test(text)) return "pending";
  if (/\bfail|\bred\b|broken|✗|❌/i.test(text)) return "fail";
  if (/\bpass|green|clean|\bok\b|done|✓|✅|\[x\]|\bran\b/i.test(text)) return "pass";
  return "info";
};

const tidy = (text: string) =>
  text
    .replaceAll(/\*\*|`|\[[ x]\]/gi, "")
    .replaceAll(/\s+/g, " ")
    .trim();

// The `Issue:` line anywhere in NEW-FEAT.md, and every row of its `## Gates`
// section up to the next heading of level 1 or 2: each data row of a table
// (its header and separator skipped) and each bullet, at most 30.
export const parsePlan = (text: string): Plan => {
  const lines = text.split("\n").map((line) => line.trim());
  const issueLine = lines.find((line) => /^Issues?:/i.test(line));
  const issue = issueLine ? issueLine.replace(/^Issues?:/i, "").trim() || null : null;

  const start = lines.findIndex((line) => /^##\s+Gates\s*$/i.test(line));
  const gates: Gate[] = [];
  if (start === -1) return { issue, gates };

  for (const [index, line] of lines.entries()) {
    if (index <= start) continue;
    if (SECTION_END.test(line) || gates.length >= MAX_GATES) break;
    if (SEPARATOR.test(line)) continue;

    if (line.startsWith("|")) {
      const isHeader = SEPARATOR.test(lines[index + 1] ?? "");
      const cells = line.split("|").map(tidy).filter(Boolean);
      if (isHeader || cells.length === 0) continue;
      gates.push({ label: cells.join(" — "), status: classify(cells.slice(1).join(" ")) });
    } else if (BULLET.test(line)) {
      gates.push({ label: tidy(line.replace(BULLET, "")), status: classify(line) });
    }
  }

  return { issue, gates };
};
