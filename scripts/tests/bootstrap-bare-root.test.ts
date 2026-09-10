import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bareRootFrom,
  bootstrap,
  GUARD_MARKER,
  guardCommand,
  parseWorktreeList,
  planSettings,
} from "../bootstrap-bare-root";

// ---------------------------------------------------------------- detection

test("an ordinary clone is not this layout", () => {
  expect(bareRootFrom("/home/ac/code/osn/.git", ["/home/ac/code/osn"])).toBeNull();
});

test("the worktree-holding parent is detected", () => {
  expect(bareRootFrom("/w/osn.git", ["/w/osn.git", "/w/osn.git/main", "/w/osn.git/feat-x"])).toBe(
    "/w/osn.git",
  );
});

// `git clone --bare` plus worktrees: `core.bare` is true and the porcelain
// output carries a `bare` line, but the shape this script cares about — the
// worktrees sit inside the common directory — is the same.
test("a true bare repository with worktrees is detected", () => {
  const porcelain = "bare\n\nworktree /w/cire.git/main\nHEAD abc\nbranch refs/heads/main\n";
  expect(bareRootFrom("/w/cire.git", parseWorktreeList(porcelain))).toBe("/w/cire.git");
});

// The phantom first entry: git reports the common directory itself as a
// worktree here. On its own it proves nothing, so the descendant test is
// strict.
test("the common directory listing itself is not a descendant of itself", () => {
  expect(bareRootFrom("/w/osn.git", ["/w/osn.git"])).toBeNull();
});

// `--separate-git-dir`: the common directory is named something other than
// `.git`, and the working tree is somewhere else entirely.
test("a separate-git-dir clone is not this layout", () => {
  expect(bareRootFrom("/elsewhere/osn-gitdir", ["/home/ac/code/osn"])).toBeNull();
});

// A prefix test without the separator would read `/w/osn.gitx/main` as living
// inside `/w/osn.git`.
test("a sibling directory sharing a prefix is not a descendant", () => {
  expect(bareRootFrom("/w/osn.git", ["/w/osn.gitx/main"])).toBeNull();
});

test("trailing slashes do not change the answer", () => {
  expect(bareRootFrom("/w/osn.git/", ["/w/osn.git/main/"])).toBe("/w/osn.git");
});

test("parseWorktreeList reads the paths and ignores every other field", () => {
  const porcelain = [
    "worktree /w/osn.git",
    "HEAD a1840dd0773d6902fcb12efaf8f68e6d4a299c9f",
    "branch refs/heads/main",
    "",
    "worktree /w/osn.git/main",
    "HEAD a1840dd0773d6902fcb12efaf8f68e6d4a299c9f",
    "detached",
    "",
  ].join("\n");

  expect(parseWorktreeList(porcelain)).toEqual(["/w/osn.git", "/w/osn.git/main"]);
});

// ------------------------------------------------------------- the refusal

// The two things the refusal exists to say. An agent that only hears "you are
// in the wrong directory" moves into a worktree and carries on unharnessed,
// because moving does not reload project settings; and an agent that meets
// `fatal: this operation must be run in a work tree` without being told why
// starts trying to repair a repository that is not damaged. Softening either
// line brings back a failure this guard was written for.
test("the hook text tells the session to stop, and not to move instead", () => {
  const command = guardCommand();
  expect(command).toContain("STOP");
  expect(command).toContain("EnterWorktree");
  expect(command).toContain("Do no work here");
});

test("the hook text explains the git errors rather than leaving them to be read as damage", () => {
  const command = guardCommand();
  expect(command).toContain("this operation must be run in a work tree");
  expect(command).toContain("nothing to repair");
});

// Every line is passed to `printf` inside single quotes, so one apostrophe in
// the prose would end the quote and change what the shell runs.
test("no line of the hook text carries a quote that would break the command", () => {
  const quoted = guardCommand().slice(guardCommand().indexOf("'"));
  expect(quoted.split("'").length % 2).toBe(1);
});

// --------------------------------------------------------------- the plan

test("with no settings.json, one is created carrying the guard", () => {
  const plan = planSettings(null);
  expect(plan.action).toBe("created");
  if (plan.action !== "created") return;

  const parsed = JSON.parse(plan.json) as {
    hooks: { SessionStart: readonly { hooks: readonly { command: string }[] }[] };
  };
  expect(parsed.hooks.SessionStart).toHaveLength(1);
  expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toContain(GUARD_MARKER);
});

test("running against its own output changes nothing", () => {
  const first = planSettings(null);
  if (first.action !== "created") throw new Error("expected created");

  expect(planSettings(first.json).action).toBe("unchanged");
});

test("an unrelated hook and every other key survive the merge", () => {
  const existing = JSON.stringify({
    permissions: { allow: ["Bash(git worktree *)"] },
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "echo hello" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }],
    },
  });

  const plan = planSettings(existing);
  expect(plan.action).toBe("merged");
  if (plan.action !== "merged") return;

  const parsed = JSON.parse(plan.json) as {
    permissions: { allow: readonly string[] };
    hooks: {
      SessionStart: readonly { hooks: readonly { command: string }[] }[];
      SessionEnd: readonly unknown[];
    };
  };
  expect(parsed.permissions.allow).toEqual(["Bash(git worktree *)"]);
  expect(parsed.hooks.SessionEnd).toHaveLength(1);
  expect(parsed.hooks.SessionStart).toHaveLength(2);
  expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toBe("echo hello");
  expect(parsed.hooks.SessionStart[1]?.hooks[0]?.command).toContain(GUARD_MARKER);
});

test("a settings.json with no hooks key at all gains one", () => {
  const plan = planSettings(JSON.stringify({ outputStyle: "Concise" }));
  expect(plan.action).toBe("merged");
  if (plan.action !== "merged") return;

  const parsed = JSON.parse(plan.json) as { outputStyle: string; hooks: Record<string, unknown> };
  expect(parsed.outputStyle).toBe("Concise");
  expect(parsed.hooks.SessionStart).toBeDefined();
});

// The marker carries a version so the refusal can be corrected later. Without
// it, every machine that ran an early version would keep that text for good.
test("an older guard is replaced, and only one guard is left", () => {
  const stale = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `printf 'old text' # ${GUARD_MARKER} v0` }] },
      ],
    },
  });

  const plan = planSettings(stale);
  expect(plan.action).toBe("merged");
  if (plan.action !== "merged") return;

  const parsed = JSON.parse(plan.json) as {
    hooks: { SessionStart: readonly { hooks: readonly { command: string }[] }[] };
  };
  expect(parsed.hooks.SessionStart).toHaveLength(1);
  expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toContain("STOP");
});

test("a newer guard than this script writes is left alone", () => {
  const newer = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `printf 'newer' # ${GUARD_MARKER} v99` }] },
      ],
    },
  });

  expect(planSettings(newer).action).toBe("unchanged");
});

// Each refused shape is one Claude Code itself rejects, so refusing names a
// file that is already broken rather than one this script broke.
test.each([
  ["not JSON at all", "{ this is not json }"],
  ["a JSON array", "[]"],
  ["a JSON string", '"hello"'],
  ['a "hooks" that is not an object', '{ "hooks": [] }'],
  ['a "SessionStart" that is not an array', '{ "hooks": { "SessionStart": {} } }'],
  ["a SessionStart entry that is not an object", '{ "hooks": { "SessionStart": ["x"] } }'],
  [
    "a hook group whose hooks are not an array",
    '{ "hooks": { "SessionStart": [{ "hooks": {} }] } }',
  ],
])("refuses %s rather than overwriting it", (_name, text) => {
  expect(planSettings(text).action).toBe("refused");
});

// ------------------------------------------------------ the filesystem side

async function withTree(
  run: (root: string) => Promise<void>,
  { withMainSkills = true }: { withMainSkills?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bootstrap-bare-root-"));
  try {
    if (withMainSkills) {
      const skill = join(root, "main", ".claude", "skills", "new-feat");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "linked through");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a first run writes the settings and links the skills", async () => {
  await withTree(async (root) => {
    const steps = await bootstrap(root);

    expect(steps.map((step) => step.action)).toEqual(["created", "linked"]);
    expect(await readFile(join(root, ".claude", "settings.json"), "utf8")).toContain(GUARD_MARKER);
    expect(await readlink(join(root, ".claude", "skills"))).toBe("../main/.claude/skills");
    expect(await readFile(join(root, ".claude", "skills", "new-feat", "SKILL.md"), "utf8")).toBe(
      "linked through",
    );
  });
});

test("a second run changes nothing", async () => {
  await withTree(async (root) => {
    await bootstrap(root);
    const steps = await bootstrap(root);

    expect(steps.map((step) => step.action)).toEqual(["unchanged", "unchanged"]);
  });
});

// The one file in that directory that is not this script's to touch: Claude
// Code writes every worktree session's permission approvals into it.
test("settings.local.json is left exactly as it was", async () => {
  await withTree(async (root) => {
    const local = join(root, ".claude", "settings.local.json");
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(local, '{ "outputStyle": "Concise" }');

    await bootstrap(root);

    expect(await readFile(local, "utf8")).toBe('{ "outputStyle": "Concise" }');
  });
});

test("a settings.json it cannot read is reported, not replaced", async () => {
  await withTree(async (root) => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(path, "{ broken");

    const steps = await bootstrap(root);

    expect(steps[0]?.action).toBe("refused");
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });
});

test("a real skills directory already there is left alone", async () => {
  await withTree(async (root) => {
    await mkdir(join(root, ".claude", "skills", "mine"), { recursive: true });

    const steps = await bootstrap(root);

    expect(steps[1]?.action).toBe("skipped");
    expect((await lstat(join(root, ".claude", "skills"))).isDirectory()).toBe(true);
  });
});

test("a link pointing somewhere else is reported, not repointed", async () => {
  await withTree(async (root) => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await symlink("../somewhere-else", join(root, ".claude", "skills"));

    const steps = await bootstrap(root);

    expect(steps[1]?.action).toBe("skipped");
    expect(await readlink(join(root, ".claude", "skills"))).toBe("../somewhere-else");
  });
});

test("with no main worktree the settings are still written", async () => {
  await withTree(
    async (root) => {
      const steps = await bootstrap(root);

      expect(steps[0]?.action).toBe("created");
      expect(steps[1]?.action).toBe("skipped");
    },
    { withMainSkills: false },
  );
});
