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
 *   full-state-design  full, and the diff both writes state and changes how a
 *                      screen looks; the state and design reviews run too
 *   full-state         full, and the diff writes state; the state review runs
 *                      too
 *   full-design        full, and the diff changes how a screen looks; the
 *                      design review runs too
 *   full               some change is outside the list below; the test,
 *                      security and performance reviews run
 *   trivial-tests      docs and tests only, and a test changed; only the test
 *                      review runs
 *   trivial            docs only; no review agent runs
 *
 * `prep-pr` (`.claude/skills/prep-pr/SKILL.md` Steps 4 and 6) reads the word.
 * A review agent costs about the same whatever the diff, so a one-line wiki
 * fix paid for a security and a performance review that had nothing to read.
 *
 * The diff writes state when a changed application source file or migration
 * (`src/` or `migrations/`, never test code) has a changed line naming a state
 * — a status, state, phase or stage; a lifecycle timestamp, actor or reason
 * such as `completedAt`, `revokedBy` or `cancellationReason`; a flag key; an
 * enum, literal union, CHECK or trigger — and the file writes the database: a
 * migration always, otherwise a Drizzle write chain, a table declaration or
 * upper-case SQL. Removed lines count, so a deleted guard does. Comment lines
 * do not. `.claude/skills/review-state/SKILL.md` is the review it starts.
 *
 * The diff changes how a screen looks when it changes a regular file that is
 * not test code, outside the tooling, docs and agent trees (`tools/`,
 * `scripts/`, `wiki/`, `docs/`, `.claude/`, `.agents/`, `.github/`,
 * `.changeset/`), that is either markup or style (`.tsx`, `.jsx`, `.astro`,
 * `.css`, `.html`, `.svg`, `.mdx`) or any file under the `src/` of a
 * component or token package (`shared/ui`, `cire/ui`, `osn/auth-ui`,
 * `shared/design-tokens`), whose plain `.ts` modules build classes every
 * surface importing them draws with. Added and deleted files count.
 * `.claude/skills/review-design/SKILL.md` is the review it starts.
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
 * no changes at all prints `full-state-design`, since it means the wrong
 * range was read and every review should look. Without a base, or when git
 * fails, it prints nothing and exits 1, which `prep-pr` also reads as
 * `full-state-design`.
 * Tests in `scripts/tests/review-scope.test.ts`.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PathClass = "doc" | "test" | "other";
export type ReviewScope =
  | "full"
  | "full-state"
  | "full-design"
  | "full-state-design"
  | "trivial"
  | "trivial-tests";

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

/** Extensions a state can be written from: code and SQL. */
const STATE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".sql"]);

/** Whether a change is read for state at all: application source or a
 * migration, as a regular file. Test code is a fixture, and tooling outside
 * `src/` writes no application state. */
export function stateCandidate(change: ChangedPath): boolean {
  if (change.symlink === true) return false;
  if (change.modes.some((mode) => mode === SYMLINK || mode === SUBMODULE)) return false;

  const segments = change.path.split("/");
  const name = segments.at(-1) ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  if (!STATE_EXTENSIONS.has(extension)) return false;
  if (segments.includes("tests") || /\.(test|spec)\./.test(name)) return false;

  return segments.includes("src") || segments.includes("migrations");
}

/** The added and removed lines of a `git diff -U0` for one file, without
 * their `+` or `-`. Everything before the first hunk is the header, so a
 * removed `-- comment` or an added `++i` is content, not a header line. */
export function changedLines(patch: string): string[] {
  const lines: string[] = [];
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) lines.push(line.slice(1));
  }

  return lines;
}

/** A word that names a state, or a value that travels with one. */
const STATE_TOKEN = new RegExp(
  [
    // status, state, phase or stage, alone or as a suffix: `rsvpStatus`, `payment_state`
    String.raw`\b(?:status|state|phase|stage|lifecycle)\b`,
    String.raw`[a-z](?:Status|State|Phase|Stage)\b`,
    String.raw`_(?:status|state|phase|stage)\b`,
    // when, by whom and why a state was reached; a creation or edit stamp
    // (`createdAt`, `imagesUpdatedAt`, `last_updated_by`) is not a state, and
    // `orderBy` is no actor
    String.raw`\b[a-z]\w*?(?<!reated|pdated)(?:At|_at)\b`,
    String.raw`\b[a-z]\w*ed(?<!reated|pdated)(?:By|_by)\b`,
    String.raw`\b[a-z]\w*(?:Reason|_reason)\b`,
    // a flag as a key or an annotation; a local `const isOwner =` is not one
    String.raw`\b(?:is|has|was)[A-Z]\w*\??\s*:`,
    String.raw`\bmode:\s*["']boolean["']`,
    // the value set: an enum, a literal union, a CHECK, a trigger
    String.raw`\benum:\s*\[`,
    String.raw`\bSchema\.Literals?\(`,
    String.raw`"[\w-]+"\s*\|\s*"[\w-]+"`,
    String.raw`\bcheck\(\s*["'\x60]`,
    String.raw`\bCHECK\s*\(`,
    String.raw`\bCREATE\s+TRIGGER\b`,
  ].join("|"),
);

/** A file that writes the database: a Drizzle write chain, a table
 * declaration, or upper-case SQL. `\s` spans the newlines of a chain. */
const DATABASE_WRITE = new RegExp(
  [
    String.raw`\.update\(\s*[\w.]+\s*\)\s*\.set\(`,
    String.raw`\.insert\(\s*[\w.]+\s*\)\s*\.values\(`,
    String.raw`\.delete\(\s*[\w.]+\s*\)\s*\.(?:where|returning)\(`,
    String.raw`\.onConflictDo(?:Update|Nothing)\(`,
    String.raw`\bsqliteTable\(`,
    String.raw`\bUPDATE\s+\S+\s+SET\b`,
    String.raw`\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|CREATE\s+(?:TABLE|TRIGGER)|ALTER\s+TABLE)\b`,
  ].join("|"),
);

/** A line that is only a comment: `//`, `/*`, a block comment's `*`, or SQL's `--`. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|--)/;

/** Whether one candidate file's change writes state: a changed line names a
 * state, and the file writes the database. `contents` is the file as it now
 * stands, or its removed lines when it was deleted; a migration needs none. */
export function writesState(path: string, lines: readonly string[], contents: string): boolean {
  const named = lines.some((line) => !COMMENT_LINE.test(line) && STATE_TOKEN.test(line));
  if (!named) return false;

  return path.endsWith(".sql") || DATABASE_WRITE.test(contents);
}

/** Extensions that draw a screen: markup and style. */
const DESIGN_EXTENSIONS = new Set([".tsx", ".jsx", ".astro", ".css", ".html", ".svg", ".mdx"]);

/** Trees that ship no screen a design document governs: tooling, docs, agent
 * instructions and release notes. */
const NO_SCREEN_ROOTS = new Set([
  "tools",
  "scripts",
  "wiki",
  "docs",
  ".claude",
  ".agents",
  ".github",
  ".changeset",
]);

/** The component and token packages, whose every source file is look. */
const DESIGN_PACKAGES = [
  "shared/ui/src/",
  "cire/ui/src/",
  "osn/auth-ui/src/",
  "shared/design-tokens/src/",
];

/** Whether a change can alter how a screen looks: markup or style in a
 * product tree, or any source in a component or token package, as a regular
 * file. Test code draws no screen anyone ships. */
export function designCandidate(change: ChangedPath): boolean {
  if (change.symlink === true) return false;
  if (change.modes.some((mode) => mode === SYMLINK || mode === SUBMODULE)) return false;

  const segments = change.path.split("/");
  const name = segments.at(-1) ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  if (NO_SCREEN_ROOTS.has(segments[0] ?? "")) return false;
  if (segments.slice(0, -1).includes("tests") || /\.(test|spec)\./.test(name)) return false;

  if (DESIGN_EXTENSIONS.has(extension)) return true;
  return DESIGN_PACKAGES.some((prefix) => change.path.startsWith(prefix));
}

/** The verdict. `state`, whether the diff writes state, and `design`, whether
 * it changes how a screen looks, each add their suffix to `full`, in that
 * order; nothing lifts a trivial verdict, since a state is only ever written
 * from source and a screen only ever drawn from it. */
export function reviewScope(
  changes: readonly ChangedPath[],
  state = false,
  design = false,
): ReviewScope {
  if (changes.length === 0) return "full-state-design";

  const classes = new Set(changes.map(changeClass));
  if (classes.has("other")) {
    if (state && design) return "full-state-design";
    if (state) return "full-state";
    return design ? "full-design" : "full";
  }

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
  const scope = reviewScope(changes);

  // Only a full diff can write state, and one path that does settles it.
  // `--literal-pathspecs` keeps a name holding `*` or `:` from being read as
  // a pattern.
  const untrackedPaths = new Set(untracked.map((change) => change.path));
  const diffOf = (range: string, path: string) =>
    changedLines(
      git(root, [
        "--literal-pathspecs",
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        range,
        "--",
        path,
      ]),
    );
  const state =
    scope === "full" &&
    [...new Set(changes.filter(stateCandidate).map((change) => change.path))].some((path) => {
      const full = join(root, path);
      const lines = untrackedPaths.has(path)
        ? readFileSync(full, "utf8").split("\n")
        : [...diffOf(`${base}...HEAD`, path), ...diffOf("HEAD", path)];
      const contents = existsSync(full) ? readFileSync(full, "utf8") : lines.join("\n");

      return writesState(path, lines, contents);
    });
  const design = scope === "full" && changes.some(designCandidate);

  process.stdout.write(`${reviewScope(changes, state, design)}\n`);
}
