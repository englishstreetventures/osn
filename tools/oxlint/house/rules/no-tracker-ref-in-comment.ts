import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Standards that number their clauses the way an internal plan numbers its
 * phases. A citation to one of these is a stable external reference and the
 * kind of pointer this rule exists to encourage, so it is not a match.
 */
const normativeCitation = /\b(?:Copenhagen Book|RFC|NIST|OWASP|WCAG|ISO|FIPS|SP)\s*$/;

type CommentPattern = {
  readonly messageId: "trackerRef" | "findingId" | "phaseCode" | "narrativePhrase";
  readonly regex: RegExp;
  /** Given the comment's text and a match offset, whether to let the match pass. */
  readonly skip?: (value: string, index: number) => boolean;
};

/**
 * The reference shapes that rot, each reported under its own message.
 *
 * `createOnce` builds the visitor once and reuses it for every file, so nothing
 * here may hold per-file state. `matchAll` clones the regex rather than
 * advancing `lastIndex` on the shared object, which is what keeps these safe to
 * hoist to module scope.
 */
const patterns: readonly CommentPattern[] = [
  { messageId: "trackerRef", regex: /osn-tracker#\d+/gi },
  { messageId: "findingId", regex: /\b[CDPST]-[A-Z]\d+\b/g },
  // The lookbehind rejects a hyphen as well as a word character. A finding tag
  // used as a label ends in a colon too, and without that its own tail would
  // report a second time as a plan code that was never there.
  {
    messageId: "phaseCode",
    regex: /(?<![-\w])[A-Z]\d+:/g,
    skip: (value, index) => normativeCitation.test(value.slice(0, index)),
  },
  {
    messageId: "narrativePhrase",
    regex: /\bused to be\b|\bwas reported as\b|\bnot a fold target in this plan\b/gi,
  },
];

/** Where a match inside a comment's text sits in the file's own coordinates. */
function locateMatch(comment: ESTree.Comment, index: number, length: number) {
  const before = comment.value.slice(0, index);
  const lastBreak = before.lastIndexOf("\n");
  const line = comment.loc.start.line + before.split("\n").length - 1;
  // `value` excludes the two-character opening marker that `loc.start` counts,
  // so only a match on the comment's own first line has to add it back.
  const column = lastBreak === -1 ? comment.loc.start.column + 2 + index : index - lastBreak - 1;
  return { start: { line, column }, end: { line, column: column + length } };
}

/** Disallow comments that cite a tracker issue, a finding tag, a plan code, or a past bug. */
export const noTrackerRefInCommentRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow comments that reference work-tracking state — a tracker issue number, a review finding ID, a phase or plan code — or that narrate a bug's history. All four stop meaning anything once the issue closes or the plan ships, and the code they annotate is then left with a reason nobody can resolve.",
    },
    messages: {
      trackerRef:
        "`{{match}}` names a tracker issue, which stops resolving once that issue closes — and osn is public, so a comment pointing at a private finding is itself a disclosure. State the constraint the code is holding to instead.",
      findingId:
        "`{{match}}` is a review finding tag. It means nothing to a reader who cannot open the tracker, and nothing at all once the finding is closed. State the durable reason this code is written this way instead.",
      phaseCode:
        "`{{match}}` is a phase or plan code. The plan ships and the code stops referring to anything. State what this value or branch actually guarantees instead.",
      narrativePhrase:
        "This comment narrates how the code got here rather than what it now guarantees. The history belongs in the commit and the pull request, which keep it accurately; a comment only decays.",
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        for (const comment of node.comments) {
          for (const { messageId, regex, skip } of patterns) {
            for (const match of comment.value.matchAll(regex)) {
              if (skip?.(comment.value, match.index) === true) continue;
              context.report({
                messageId,
                loc: locateMatch(comment, match.index, match[0].length),
                data: { match: match[0] },
              });
            }
          }
        }
      },
    };
  },
});
