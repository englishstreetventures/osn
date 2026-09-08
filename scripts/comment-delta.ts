#!/usr/bin/env bun
/**
 * Report how many comment lines a branch adds and removes against a base.
 *
 * A number to look at, never a gate. There is no threshold: a cleanup that
 * rewraps a block nets near zero, and joining wrapped lines would game any
 * threshold anyway. What it catches is a branch that calls itself a comment
 * cleanup while growing comment volume, which is otherwise invisible until a
 * human opens the diff and counts by eye.
 *
 * The base is passed in rather than resolved here. Resolving it with
 * `git merge-base` is wrong whenever the base branch has been force-pushed
 * since the branch was cut: the merge-base falls back to an older ancestor and
 * the base's own commits land in the count, turning a branch that removes 40
 * comment lines into one that appears to add 85.
 */

export interface CommentDelta {
  readonly added: number;
  readonly removed: number;
  readonly addedComments: number;
  readonly removedComments: number;
  readonly netComments: number;
}

/**
 * Whether a diffed source line is comment text.
 *
 * Line-oriented and therefore approximate: a string literal whose continuation
 * line starts with `*` counts, and a commented-out block of code counts as
 * comment. Both are rare enough not to move the figure, and the alternative —
 * parsing every revision of every file — buys precision this does not need.
 */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

/** Count added/removed lines in a unified diff, and how many of them are comments. */
export function countCommentDelta(diff: string): CommentDelta {
  let added = 0;
  let removed = 0;
  let addedComments = 0;
  let removedComments = 0;

  for (const line of diff.split("\n")) {
    // `+++`/`---` are file headers, not content, and would otherwise be counted
    // as an added and a removed line in every file the diff touches.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added++;
      if (isCommentLine(line.slice(1))) addedComments++;
    } else if (line.startsWith("-")) {
      removed++;
      if (isCommentLine(line.slice(1))) removedComments++;
    }
  }

  return {
    added,
    removed,
    addedComments,
    removedComments,
    netComments: addedComments - removedComments,
  };
}

const EXTENSIONS = ["*.ts", "*.tsx", "*.mjs", "*.js"];

function gitDiff(base: string): string {
  return new TextDecoder().decode(
    Bun.spawnSync({ cmd: ["git", "diff", `${base}...HEAD`, "--", ...EXTENSIONS], stdout: "pipe" })
      .stdout,
  );
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: bun run scripts/comment-delta.ts <base-ref>");
    process.exit(2);
  }
  const d = countCommentDelta(gitDiff(base));
  console.log(
    `comment lines: +${d.addedComments} -${d.removedComments} (net ${signed(d.netComments)})`,
  );
  console.log(`all lines:     +${d.added} -${d.removed} (net ${signed(d.added - d.removed)})`);
  if (d.netComments > 0) {
    console.log(
      `\nThis branch adds ${d.netComments} comment lines. Not a failure — but on a\n` +
        `cleanup branch, check the diff for parentheticals that became paragraphs.`,
    );
  }
}
