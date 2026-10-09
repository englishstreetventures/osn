#!/usr/bin/env bun
/**
 * Decide how much review a branch needs. Run from anywhere in the checkout
 * with the base it merges into:
 *
 *   bun run scripts/review-scope.ts origin/main
 *
 * It reads the committed diff against that base, the uncommitted changes and
 * the untracked files, and prints one word:
 *
 *   full           some change is outside the list below; every review agent
 *                  runs
 *   trivial-tests  docs and tests only, and a test changed; only the test
 *                  review runs
 *   trivial        docs only; no review agent runs
 *
 * `prep-pr` (`.claude/skills/prep-pr/SKILL.md` Step 4) reads the word. A
 * review agent costs about the same whatever the diff, so a one-line wiki fix
 * paid for a security and a performance review that had nothing to read.
 *
 * The test is an allowlist, like `scripts/changeset-required.sh`: a change is
 * trivial only when it is a plain Markdown doc or test code, and anything else
 * makes the diff full. These beat every class, whatever the file's name: a
 * path under any `src/` directory; anything under `.github/`; any
 * `package.json` or lockfile; agent instructions (`AGENTS.md`, `CLAUDE.md`,
 * anything under `.claude/` or `.agents/` — a skill can widen its own tools,
 * and the review skills define this gate); an `.env` file; a symlink, a
 * submodule, or a file whose mode changed. So a one-line change to auth, a
 * schema, a route, a Worker binding or a build config always gets every
 * review — catching a small dangerous diff is what the security review is for.
 *
 * Git is read with `-z` and `--no-renames`: a name arrives whole however odd
 * it is, and a file moved out of `src/` still shows its old path. A diff with
 * no changes at all prints `full`, since it means the wrong range was read.
 * Without a base, or when git fails, it prints nothing and exits 1.
 * Tests in `scripts/tests/review-scope.test.ts`.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";

export type PathClass = "doc" | "test" | "other";
export type ReviewScope = "full" | "trivial" | "trivial-tests";

/** One changed path, with the file modes git reported for it — old then new,
 * `000000` where the file is absent — or none for an untracked file, whose
 * `symlink` comes from the disk instead. */
export interface ChangedPath {
  readonly path: string;
  readonly modes: readonly string[];
  readonly symlink?: boolean;
}

const LOCKFILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "skills-lock.json",
]);

/** Files an agent reads as instructions, compared without case: macOS opens
 * `claude.md` for `CLAUDE.md`. */
const AGENT_FILES = new Set(["agents.md", "claude.md", "claude.local.md"]);

/** Test code and snapshots; a fixture or config file under `tests/` can be
 * read by a build or a workflow as easily as by a test. */
const TEST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".snap"]);

const ABSENT = "000000";
const SYMLINK = "120000";
const SUBMODULE = "160000";

/** Which class one changed path falls in. The first matching rule wins. */
export function classifyPath(path: string): PathClass {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  // A path that climbs out of the tree, or one git quoted (it does without
  // `-z`), names a file no rule below was written for.
  if (path.startsWith('"') || path.startsWith("/")) return "other";
  if (segments.some((s) => s === ".." || s === "." || s === "")) return "other";

  if (name.startsWith(".env")) return "other";
  if (segments.includes("src")) return "other";
  if (segments[0] === ".github") return "other";
  if (LOCKFILES.has(name)) return "other";
  if (segments.includes(".claude") || segments.includes(".agents")) return "other";
  if (AGENT_FILES.has(name.toLowerCase())) return "other";

  const testNamed = segments.slice(0, -1).includes("tests") || /\.(test|spec)\./.test(name);
  if (testNamed && TEST_EXTENSIONS.has(extension)) return "test";

  // Plain Markdown only: `.mdx` carries components and script.
  if (extension === ".md") return "doc";

  return "other";
}

/** A change's class: its path's, unless git saw a symlink, a submodule or a
 * mode change, none of which is prose or test code whatever it is called. */
export function changeClass(change: ChangedPath): PathClass {
  if (change.symlink === true) return "other";
  if (change.modes.some((mode) => mode === SYMLINK || mode === SUBMODULE)) return "other";
  if (new Set(change.modes.filter((mode) => mode !== ABSENT)).size > 1) return "other";

  return classifyPath(change.path);
}

/** `git diff --raw -z --no-renames`: a `:<old mode> <new mode> <old> <new>
 * <status>` header, then the path, each ended by NUL. */
export function parseRawZ(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const changes: ChangedPath[] = [];

  for (let i = 0; i < fields.length - 1; i += 1) {
    const header = fields[i]!;
    if (!header.startsWith(":")) continue;

    const [oldMode = "", newMode = ""] = header.slice(1).split(" ");
    changes.push({ path: fields[i + 1]!, modes: [oldMode, newMode] });
    i += 1;
  }

  return changes;
}

export function reviewScope(changes: readonly ChangedPath[]): ReviewScope {
  if (changes.length === 0) return "full";

  const classes = new Set(changes.map(changeClass));
  if (classes.has("other")) return "full";

  return classes.has("test") ? "trivial-tests" : "trivial";
}

if (import.meta.main) {
  const base = process.argv[2];

  if (base === undefined || base === "") {
    process.stderr.write(
      "error: review-scope.ts needs the base the branch merges into.\n" +
        '       bun run scripts/review-scope.ts "$DIFF_BASE"\n',
    );
    process.exit(1);
  }

  const git = (cwd: string | undefined, args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (!result.success) {
      process.stderr.write(`error: git ${args.join(" ")} failed:\n${result.stderr.toString()}`);
      process.exit(1);
    }

    return result.stdout.toString();
  };

  // Every path below is relative to the top of the checkout, whichever
  // directory this runs from.
  const root = git(undefined, ["rev-parse", "--show-toplevel"]).trim();
  const committed = git(root, ["diff", "--raw", "-z", "--no-renames", `${base}...HEAD`]);
  const uncommitted = git(root, ["diff", "--raw", "-z", "--no-renames", "HEAD"]);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .map((path): ChangedPath => ({
      path,
      modes: [],
      symlink: lstatSync(join(root, path)).isSymbolicLink(),
    }));

  const changes = [...parseRawZ(committed), ...parseRawZ(uncommitted), ...untracked];
  process.stdout.write(`${reviewScope(changes)}\n`);
}
