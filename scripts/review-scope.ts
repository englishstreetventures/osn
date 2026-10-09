#!/usr/bin/env bun
/**
 * Decide how much review a branch needs, given its changed paths on stdin (one
 * per line). Prints one word:
 *
 *   full           some path is outside the list below; every review agent runs
 *   trivial-tests  docs, skills and tests only, and a test changed; only the
 *                  test review runs
 *   trivial        docs and skills only; no review agent runs
 *
 * `prep-pr` (`.claude/skills/prep-pr/SKILL.md` Step 4) reads the word. Every
 * review agent costs about the same whatever the diff, so a one-line wiki fix
 * paid for a security and a performance review that had nothing to read.
 *
 * The test is an allowlist, like `scripts/changeset-required.sh`: a path is
 * trivial only when it is a doc, a skill or a test, and anything unknown makes
 * the diff full. Three exclusions beat every class, whatever the file's name:
 * a path under any `src/` directory, anything under `.github/workflows/`, and
 * any `package.json` or lockfile. So a one-line change to auth, a schema, a
 * route, a Worker binding or a build config always gets the full reviews —
 * catching a small dangerous diff is what the security review is for.
 *
 * Feed it the old path of a rename as well as the new one
 * (`git diff --name-only --no-renames`), or a file moved out of `src/` reads as
 * a new doc. An empty list prints `full`: it means the wrong range was diffed.
 * Tests in `scripts/tests/review-scope.test.ts`.
 */

export type PathClass = "doc" | "skill" | "test" | "other";
export type ReviewScope = "full" | "trivial" | "trivial-tests";

const LOCKFILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "skills-lock.json",
]);

/** Which class one changed path falls in. The first matching rule wins. */
export function classifyPath(path: string): PathClass {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";

  // `git diff --name-only` never prints these, but a path that climbs out of
  // the tree names a file no rule below was written for.
  if (path.startsWith("/") || segments.some((s) => s === ".." || s === "." || s === "")) {
    return "other";
  }

  if (segments.includes("src")) return "other";
  if (path.startsWith(".github/workflows/")) return "other";
  if (LOCKFILES.has(name)) return "other";

  // Third-party skill text, agent definitions (each sets an agent's tools and
  // model) and session-metrics cards are Markdown or data, but not this
  // repository's prose.
  if (path.startsWith(".agents/") || path.startsWith(".claude/agents/")) return "other";
  if (path.startsWith(".claude/metrics/")) return "other";

  // Skill text only. A script under a skill runs, and the tracked symlink
  // `.claude/skills/<name>` points into `.agents/`; neither is prose.
  if (path.startsWith(".claude/skills/") && name.endsWith(".md")) return "skill";
  if (segments.slice(0, -1).includes("tests") || /\.(test|spec)\.[^.]+$/.test(name)) return "test";
  // Plain Markdown only. `.mdx` carries components and script, and no build
  // here reads Markdown from outside a `src/` directory today: a change that
  // makes one do so is not trivial either.
  if (name.endsWith(".md")) return "doc";

  return "other";
}

export function reviewScope(paths: readonly string[]): ReviewScope {
  const changed = paths.map((p) => p.trim()).filter(Boolean);
  if (changed.length === 0) return "full";

  const classes = new Set(changed.map(classifyPath));
  if (classes.has("other")) return "full";

  return classes.has("test") ? "trivial-tests" : "trivial";
}

if (import.meta.main) {
  // A bare run at a terminal would wait on a list nobody is typing; refuse it
  // rather than print a verdict for nothing.
  if (process.stdin.isTTY) {
    process.stderr.write(
      [
        "error: review-scope.ts reads the changed-file list on stdin.",
        '       git diff --name-only --no-renames "$DIFF_BASE"...HEAD | bun run scripts/review-scope.ts',
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const input = await new Response(Bun.stdin.stream()).text();
  process.stdout.write(`${reviewScope(input.split("\n"))}\n`);
}
