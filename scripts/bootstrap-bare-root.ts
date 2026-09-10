#!/usr/bin/env bun
/**
 * Install the agent guard in the directory that holds this repository's
 * worktrees.
 *
 * On the local machine the repository lives at `~/.work/osn.git`, and every
 * worktree — `main/` included — is a subdirectory of it. That parent is the
 * path a shell completes first and the place `git worktree list` is run, so a
 * session starts there often. It is not a worktree: it holds no `CLAUDE.md`,
 * no `.claude/settings.json` and no `.claude/skills/`, so a session rooted
 * there runs with no hooks, no skills and none of the repository's
 * instructions, and nothing says so.
 *
 * Nothing in that directory is tracked, so the fix cannot be committed there.
 * This script is what writes it: a `SessionStart` hook that tells the agent to
 * stop, and a link that at least puts the skills within reach. It is
 * idempotent, it never overwrites a `settings.json` it did not write, and in
 * an ordinary clone it does nothing and exits 0.
 *
 * Run it from any worktree:
 *
 *     bun run scripts/bootstrap-bare-root.ts
 *
 * `scripts/setup.sh` runs it as part of the standard setup. It is
 * repository-agnostic — run it from any checkout laid out this way and it
 * guards that repository's parent directory.
 */
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** Marks the hook as this script's, so a later run recognises its own work. */
export const GUARD_MARKER = "bare-root-guard";

/**
 * Bumped whenever the refusal text changes. A run replaces an older guard and
 * leaves an equal or newer one alone, so the text can be corrected on machines
 * that already have it.
 */
export const GUARD_VERSION = 1;

const GUARD_COMMENT = `# ${GUARD_MARKER} v${GUARD_VERSION}`;
const GUARD_PATTERN = new RegExp(`#\\s*${GUARD_MARKER}\\s+v(\\d+)`);

/**
 * What the session is told. Two things it would otherwise get wrong, because
 * both look reasonable from inside a session that has no idea where it is:
 *
 * - Moving into a worktree does not help. Project settings are read from the
 *   directory the session started in, so a `cd` or an `EnterWorktree` leaves
 *   the session on the same settings, hooks and skills it had — which are none.
 * - The git errors here are not a broken checkout. This directory holds git's
 *   own files and no working tree, so `status`, `add`, `checkout` and `stash`
 *   all exit 128 with `fatal: this operation must be run in a work tree`. An
 *   agent that reads that as damage starts trying to repair it.
 *
 * No line may contain a single quote: each is passed to `printf` inside one.
 */
const REFUSAL = [
  "STOP — this directory holds the repository worktrees. It is not one of them.",
  "This session has none of the repository configuration: no hooks, no skills, no CLAUDE.md.",
  "Moving does not fix it. Neither cd nor EnterWorktree reloads project settings — they are read from the directory the session started in.",
  "Do no work here. Ask the user to start a session inside a worktree (main/, or one beside it).",
  "Git commands that need a working tree fail here: fatal: this operation must be run in a work tree. Nothing is broken and there is nothing to repair — the working tree is in the worktrees.",
] as const;

/** The `SessionStart` hook command: the refusal, then the version marker. */
export function guardCommand(): string {
  const args = REFUSAL.map((line) => `'${line}'`).join(" ");
  return `printf '%s\\n' ${args} ${GUARD_COMMENT}`;
}

/** One hook and the group it sits in — the shape `settings.json` uses. */
type Hook = { readonly type: "command"; readonly command: string; readonly timeout: number };
type HookGroup = { readonly hooks: readonly Hook[] };

/**
 * The hook group this script installs. `matcher` is omitted, which is the
 * documented way to match every session start.
 */
function guardGroup(): HookGroup {
  return { hooks: [{ type: "command", command: guardCommand(), timeout: 5 }] };
}

/**
 * A settings file as read back from disk. Anyone may have put anything in it,
 * so every value is a `JsonValue` until a check narrows it.
 */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

export type SettingsPlan =
  | { readonly action: "created" | "merged"; readonly json: string; readonly note: string }
  | { readonly action: "unchanged" | "refused"; readonly note: string };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The guard's version inside a hook group, or `null` if it holds no guard. */
function guardVersionOf(group: unknown): number | null {
  if (!isObject(group) || !Array.isArray(group.hooks)) return null;

  for (const hook of group.hooks) {
    if (!isObject(hook) || typeof hook.command !== "string") continue;
    const match = GUARD_PATTERN.exec(hook.command);
    if (match?.[1] !== undefined) return Number(match[1]);
  }

  return null;
}

function render(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Decide what to do with an existing `settings.json`, given its text (or
 * `null` when there is none).
 *
 * The file may already carry someone's own hooks and permissions, so this
 * never rewrites it wholesale: it keeps every key and every other hook, and
 * appends or replaces one `SessionStart` group. Any shape the merge cannot
 * reason about is refused rather than guessed at — and each of those shapes is
 * also one Claude Code itself rejects, so a refusal here names a file that is
 * already broken for the harness.
 *
 * The round trip through `JSON.parse` and `JSON.stringify` reprints the file:
 * comments are impossible in this format anyway, but indentation and blank
 * lines do not survive.
 */
export function planSettings(existing: string | null): SettingsPlan {
  if (existing === null || existing.trim() === "") {
    return {
      action: "created",
      json: render({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        hooks: { SessionStart: [guardGroup()] },
      }),
      note: "no settings.json was there",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return {
      action: "refused",
      note: "settings.json is not valid JSON — Claude Code cannot read it either; fix it, then run this again",
    };
  }

  if (!isObject(parsed)) return { action: "refused", note: "settings.json is not a JSON object" };

  const hooks = parsed.hooks;
  if (hooks !== undefined && !isObject(hooks)) {
    return { action: "refused", note: 'settings.json has a "hooks" that is not an object' };
  }

  const sessionStart = isObject(hooks) ? hooks.SessionStart : undefined;
  if (sessionStart !== undefined && !Array.isArray(sessionStart)) {
    return {
      action: "refused",
      note: 'settings.json has a "hooks.SessionStart" that is not an array',
    };
  }

  const groups: readonly JsonValue[] = Array.isArray(sessionStart) ? sessionStart : [];
  for (const group of groups) {
    if (!isObject(group) || (group.hooks !== undefined && !Array.isArray(group.hooks))) {
      return {
        action: "refused",
        note: "settings.json has a SessionStart entry this script does not recognise as a hook group",
      };
    }
  }

  const existingIndex = groups.findIndex((group) => guardVersionOf(group) !== null);
  if (existingIndex !== -1) {
    const version = guardVersionOf(groups[existingIndex]) ?? 0;
    if (version >= GUARD_VERSION) {
      return { action: "unchanged", note: `the guard is already there (v${version})` };
    }
  }

  const merged: readonly JsonValue[] =
    existingIndex === -1
      ? [...groups, guardGroup()]
      : groups.map((group, index) => (index === existingIndex ? guardGroup() : group));

  const otherHooks: JsonObject = isObject(hooks) ? hooks : {};

  return {
    action: "merged",
    json: render({ ...parsed, hooks: { ...otherHooks, SessionStart: merged } }),
    note:
      existingIndex === -1
        ? "kept every other key and hook"
        : "replaced an older version of the guard",
  };
}

/** The worktree paths in `git worktree list --porcelain` output. */
export function parseWorktreeList(porcelain: string): readonly string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path !== "");
}

function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/**
 * The directory that holds the worktrees, or `null` when this checkout is not
 * laid out that way.
 *
 * Two conditions, and both are needed. The common directory is git's own
 * directory: in an ordinary clone it is `<repo>/.git`, and in this layout it
 * is the directory the worktrees sit in. So the basename decides the shape.
 * A `--separate-git-dir` clone also has a common directory named something
 * else, which is what the second condition rules out: at least one registered
 * worktree has to live inside it.
 *
 * `git worktree list` reports the common directory itself first — that row is
 * how git names the repository's main worktree, which in this layout has no
 * working tree of its own — so the descendant test is strict. That row is also
 * why the skills link below names `main/` directly instead of looking for "the
 * worktree on main", which would find this one.
 *
 * Both arguments must already be resolved to real paths: macOS resolves `/tmp`
 * to `/private/tmp`, and a prefix test on the two spellings of one directory
 * answers no.
 */
export function bareRootFrom(commonDir: string, worktrees: readonly string[]): string | null {
  const root = withoutTrailingSlash(commonDir.trim());
  if (root === "" || basename(root) === ".git") return null;

  const prefix = root.endsWith("/") ? root : `${root}/`;
  const holdsAWorktree = worktrees.some((worktree) => {
    const path = withoutTrailingSlash(worktree.trim());
    return path !== root && path.startsWith(prefix);
  });

  return holdsAWorktree ? root : null;
}

export type Step = {
  /** `settings` or `skills`. */
  readonly what: string;
  /** What happened: `created`, `merged`, `unchanged`, `refused`, `linked`, `skipped`. */
  readonly action: string;
  readonly note: string;
};

/**
 * `lstat`, not `stat`: a link whose target is missing must still read as a
 * link, or a second run would replace it.
 */
async function pathKind(path: string): Promise<"missing" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink() ? "symlink" : "other";
  } catch {
    return "missing";
  }
}

async function symlinkTarget(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch {
    return null;
  }
}

async function writeSettings(claudeDir: string): Promise<Step> {
  const path = join(claudeDir, "settings.json");

  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = null;
  }

  const plan = planSettings(existing);
  if (!("json" in plan)) return { what: "settings", action: plan.action, note: plan.note };

  // A worktree session may be reading this directory while this runs — Claude
  // Code writes every worktree session's approvals into the `settings.local.json`
  // beside it. Rename is atomic within a directory, so no reader sees a
  // half-written file.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, plan.json);
  await rename(temporary, path);

  return { what: "settings", action: plan.action, note: plan.note };
}

async function linkSkills(bareRoot: string, claudeDir: string): Promise<Step> {
  const link = join(claudeDir, "skills");
  const target = join(bareRoot, "main", ".claude", "skills");
  const relative = join("..", "main", ".claude", "skills");

  const kind = await pathKind(link);
  if (kind === "symlink") {
    const current = await symlinkTarget(link);
    const points = current === null ? null : resolve(claudeDir, current);
    return points === target
      ? { what: "skills", action: "unchanged", note: `already linked to ${relative}` }
      : {
          what: "skills",
          action: "skipped",
          note: `a link is already there, pointing at ${current ?? "nothing readable"}`,
        };
  }

  if (kind === "other") {
    return {
      what: "skills",
      action: "skipped",
      note: "a real directory is already there — left alone",
    };
  }

  if ((await pathKind(target)) === "missing") {
    return { what: "skills", action: "skipped", note: `no skills to link at ${target}` };
  }

  await symlink(relative, link);
  return { what: "skills", action: "linked", note: `${link} -> ${relative}` };
}

/**
 * Write the guard into `<bareRoot>/.claude/`, and link the skills there to the
 * `main` worktree's. Reports one step each; neither ever replaces something it
 * did not write.
 */
export async function bootstrap(bareRoot: string): Promise<readonly Step[]> {
  const claudeDir = join(bareRoot, ".claude");
  await mkdir(claudeDir, { recursive: true });

  return [await writeSettings(claudeDir), await linkSkills(bareRoot, claudeDir)];
}

/**
 * The real path, or the path as given when it cannot be resolved. Both sides
 * of the descendant test have to agree on spelling: macOS resolves `/tmp` to
 * `/private/tmp`, and git reports whichever it was handed.
 */
async function realPathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function git(...args: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.log(`bootstrap-bare-root: git ${args[0]} failed — ${stderr.trim()}`);
      return null;
    }

    return stdout;
  } catch {
    // No git on PATH: a source tarball, or a sandbox without it. Nothing to
    // detect, and nothing this script could safely write.
    console.log("bootstrap-bare-root: no git on PATH, nothing to do");
    return null;
  }
}

if (import.meta.main) {
  // `--path-format` needs git 2.31. On anything older the call fails and git's
  // own message is what prints.
  const commonDir = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const worktreeList = commonDir === null ? null : await git("worktree", "list", "--porcelain");

  if (commonDir === null || worktreeList === null) process.exit(0);

  const resolved = await realPathOr(commonDir.trim());
  const worktrees = await Promise.all(parseWorktreeList(worktreeList).map(realPathOr));

  const bareRoot = bareRootFrom(resolved, worktrees);

  if (bareRoot === null) {
    console.log("bootstrap-bare-root: this checkout keeps its worktrees elsewhere, nothing to do");
    process.exit(0);
  }

  const steps = await bootstrap(bareRoot);
  console.log(`bootstrap-bare-root: ${bareRoot}`);
  for (const step of steps) console.log(`   ${step.what}: ${step.action} — ${step.note}`);

  const refused = steps.some((step) => step.action === "refused");
  if (refused) {
    console.error(
      "bootstrap-bare-root: the guard is NOT installed — a session started there still gets no warning.",
    );
  }

  // Always 0: `scripts/setup.sh` runs under `set -e`, and a machine that
  // cannot take the guard is not a reason to stop a setup.
  process.exit(0);
}
