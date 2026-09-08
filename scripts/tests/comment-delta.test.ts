// The counting half of scripts/comment-delta.ts, exercised against literal
// diff text so no repository state is involved. The CLI half is a `git diff`
// and two `console.log`s, which is why only the counter is exported.
//
// No `bun install`: this imports `bun:test` and the script under test, matching
// every other file under scripts/.

import { expect, test } from "bun:test";

import { countCommentDelta, isCommentLine } from "../comment-delta";

test("classifies the three comment openers and nothing else", () => {
  expect(isCommentLine("// a line comment")).toBe(true);
  expect(isCommentLine("  /* block open */")).toBe(true);
  expect(isCommentLine(" * continuation")).toBe(true);
  expect(isCommentLine("const x = 1;")).toBe(false);
  expect(isCommentLine("")).toBe(false);
  // `*` as a bare operator or a glob in a string is not comment text, but a
  // line-oriented check cannot tell — documented as accepted imprecision.
  expect(isCommentLine("  * 2;")).toBe(true);
});

test("ignores the +++/--- file headers", () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "+// added", "-// removed"].join("\n");
  const d = countCommentDelta(diff);
  expect(d.added).toBe(1);
  expect(d.removed).toBe(1);
  expect(d.netComments).toBe(0);
});

test("nets negative when a parenthetical is stripped in place", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "-// Bound checked at the edge (S-M1).",
    "-// A second line of the same block.",
    "+// Bound checked at the edge.",
  ].join("\n");
  expect(countCommentDelta(diff).netComments).toBe(-1);
});

test("nets positive when a one-liner becomes a paragraph — the case this exists to catch", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "-// Never cached or stored (tracker#468).",
    "+// The response is never cached or stored. A per-user list in a shared",
    "+// cache would serve one caller's suggestions to another, so the header",
    "+// is set on every response rather than inferred from the route.",
  ].join("\n");
  expect(countCommentDelta(diff).netComments).toBe(2);
});

test("separates comment lines from code lines in the same diff", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "+// a comment",
    "+const added = 1;",
    "-const removed = 2;",
  ].join("\n");
  const d = countCommentDelta(diff);
  expect(d).toMatchObject({ added: 2, removed: 1, addedComments: 1, removedComments: 0 });
});
