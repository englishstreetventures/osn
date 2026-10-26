// The PreToolUse guard refuses tool calls that break AGENTS.md standing rules.
// Each test here is one entry of the failure list written before the guard:
// a refusal it must make, or a near-miss it must let through. They call
// `decide` with an in-memory filesystem and branch table; the CLI tests run the
// hook command itself against real git repositories.
//
// Tracker-shaped IDs use the severity letter Q, which no finding uses, so no
// real finding ID lands in this public file.

import { describe, expect, test } from "bun:test";

import { decide, toolArgs, type GuardIo, type HookInput } from "../agent-guard";

const ROOT = "/r/osn";
const FEATURE = `${ROOT}`;
const MAIN_WT = "/r/osn-main";

interface World {
  readonly files?: Readonly<Record<string, string>>;
  readonly branches?: Readonly<Record<string, string>>;
}

function io(world: World = {}): GuardIo {
  const files: Record<string, string> = {
    [`${ROOT}/bun.lock`]: "",
    [`${ROOT}/osn/api/package.json`]: "{}",
    [`${ROOT}/cire/a/package.json`]: "{}",
    [`${MAIN_WT}/bun.lock`]: "",
    [`${MAIN_WT}/osn/api/package.json`]: "{}",
    "/tmp/x/package.json": "{}",
    "/tmp/other-repo/pkg/package.json": "{}",
    ...world.files,
  };
  const branches: Record<string, string> = {
    [FEATURE]: "feat/x",
    [MAIN_WT]: "main",
    ...world.branches,
  };
  const inside = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);
  return {
    branch: (dir) => {
      const root = Object.keys(branches)
        .filter((r) => inside(dir, r))
        .toSorted((a, b) => b.length - a.length)[0];
      return root === undefined ? null : (branches[root] ?? null);
    },
    read: (path) => files[path] ?? null,
    exists: (path) =>
      path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
    commonDir: (dir) => (inside(dir, ROOT) || inside(dir, MAIN_WT) ? "/r/osn.git" : null),
  };
}

const call = (tool_name: string, args: unknown, cwd = FEATURE): HookInput => ({
  tool_name,
  tool_input: toolArgs(args),
  cwd,
});

const bash = (command: string, cwd = FEATURE): HookInput => call("Bash", { command }, cwd);

const refused = (input: HookInput, world?: World) => decide(input, io(world), ROOT) !== null;

describe("1-2. installs", () => {
  test("a bare install is refused in a tree with bun.lock", () => {
    expect(refused(bash("bun install"))).toBe(true);
    expect(refused(bash("bun i"))).toBe(true);
    expect(refused(bash("cd osn/api && bun install"))).toBe(true);
    expect(refused(bash("FOO=1 bun install"))).toBe(true);
    expect(refused(bash("(cd osn/api && bun install)"))).toBe(true);
    expect(refused(bash("bun update"))).toBe(true);
  });

  test("bun add --filter is refused", () => {
    expect(refused(bash("bun add zod --filter @osn/api"))).toBe(true);
  });

  test("11. frozen, global, add --cwd and bunx pass", () => {
    expect(refused(bash("bun install --frozen-lockfile"))).toBe(false);
    expect(refused(bash("(cd osn/api && bun install --frozen-lockfile)"))).toBe(false);
    expect(refused(bash("bun install -g lefthook"))).toBe(false);
    expect(refused(bash("bun add zod --cwd osn/api"))).toBe(false);
    expect(refused(bash("bunx --bun tsc -p scripts/tsconfig.json"))).toBe(false);
  });

  test("11. an install with no bun.lock above it passes", () => {
    expect(refused(bash("bun install", "/tmp/scratch"))).toBe(false);
  });
});

describe("3. heredoc inside $(…)", () => {
  test("a heredoc in a command substitution is refused", () => {
    expect(refused(bash("git commit -m \"$(cat <<'EOF'\nfeat: x\nEOF\n)\""))).toBe(true);
    expect(refused(bash('git commit -m "`cat <<EOF\nfeat: x\nEOF\n`"'))).toBe(true);
  });

  test("12. a plain heredoc, arithmetic, a here-string and a quoted pattern pass", () => {
    const body = "cat > f <<'EOF'\nbun install\ngit push origin main\ndon't\nEOF";
    expect(refused(bash(body))).toBe(false);
    expect(refused(bash("echo $((1<<2))"))).toBe(false);
    expect(refused(bash("x=$(tr a b <<<abc)"))).toBe(false);
    expect(refused(bash("grep '$(cat <<EOF' f"))).toBe(false);
  });
});

describe("4-5. main", () => {
  test("commit and push on main are refused", () => {
    expect(refused(bash("git commit -m x", MAIN_WT))).toBe(true);
    expect(refused(bash("git push", MAIN_WT))).toBe(true);
    expect(refused(bash(`cd ${MAIN_WT} && git commit -m x`))).toBe(true);
    expect(refused(bash(`git -C ${MAIN_WT} commit -m x`))).toBe(true);
    expect(refused(bash("git -c user.name=x commit -m x", MAIN_WT))).toBe(true);
    expect(refused(bash("git checkout main && git push"))).toBe(true);
  });

  test("a push naming main is refused from a feature branch", () => {
    for (const ref of ["main", "HEAD:main", "+main", '"main"', "refs/heads/main"]) {
      expect(refused(bash(`git push origin ${ref}`))).toBe(true);
    }
    expect(refused(bash("git push -u origin main"))).toBe(true);
  });

  test("13. feature pushes and branch changes pass", () => {
    expect(refused(bash("git push -u origin feat/x"))).toBe(false);
    expect(refused(bash("git push origin fix/main-nav"))).toBe(false);
    expect(refused(bash("git push origin mainline"))).toBe(false);
    expect(refused(bash("git status", MAIN_WT))).toBe(false);
    expect(refused(bash("git switch -c chore/x origin/main && git commit -m x", MAIN_WT))).toBe(
      false,
    );
    expect(refused(bash(`cd ${FEATURE} && git commit -m x`, MAIN_WT))).toBe(false);
    expect(refused(bash('cd "$WT" && git commit -m x', MAIN_WT))).toBe(false);
    expect(refused(bash("git rebase main && git push"))).toBe(false);
    expect(refused(bash("git checkout main -- f && git commit -m x"))).toBe(false);
    expect(refused(bash(`(cd ${MAIN_WT} && git log); git commit -m x`))).toBe(false);
  });
});

describe("6. tracker IDs in public text", () => {
  const world: World = {
    files: {
      [`${ROOT}/sub/rel.txt`]: "fix: closes S-Q9",
      [`${ROOT}/PR-BODY.md`]: "Fixes P-Q1 in claims",
      [`${ROOT}/f`]: "body with C-Q2",
      [`${ROOT}/f.json`]: '{"body":"S-Q3"}',
      [`${ROOT}/closes.md`]: "Closes englishstreetventures/osn-tracker#12\n\nAlso S-Q4.",
      [`${ROOT}/m`]: "S-Q9",
    },
  };
  const refusedHere = (command: string) => refused(bash(command), world);

  test("commit messages", () => {
    expect(refusedHere('git commit -m "fix S-Q9 timing"')).toBe(true);
    expect(refusedHere('git commit -am "fix S-Q9 timing"')).toBe(true);
    expect(refusedHere('git commit --message="fix S-Q9"')).toBe(true);
    expect(refusedHere("cd sub && git commit -F rel.txt")).toBe(true);
    expect(refusedHere("git commit -F - <<'EOF'\nfix S-Q9\nEOF")).toBe(true);
  });

  test("gh api, pr, issue and merge text", () => {
    expect(
      refusedHere("gh api repos/englishstreetventures/osn/pulls -f title=t -F body=@PR-BODY.md"),
    ).toBe(true);
    expect(
      refusedHere('gh api -X PATCH repos/englishstreetventures/osn/pulls/1 -f body="S-Q9"'),
    ).toBe(true);
    expect(refusedHere("gh api repos/englishstreetventures/osn/issues --input f.json")).toBe(true);
    expect(refusedHere("gh pr edit 1 -F f")).toBe(true);
    expect(refusedHere("gh pr edit 1 --body-file f")).toBe(true);
    expect(refusedHere('gh pr merge 1 --squash --subject "fix S-Q9"')).toBe(true);
    expect(
      refusedHere("gh issue create -R englishstreetventures/osn --title t --body-file f"),
    ).toBe(true);
    expect(refusedHere("gh pr edit 1 --body-file closes.md")).toBe(true);
  });

  test("14. tracker targets, bare references and placeholders pass", () => {
    expect(
      refusedHere('gh issue create -R englishstreetventures/osn-tracker --title t --body "C-Q1"'),
    ).toBe(false);
    expect(
      refusedHere('gh issue create --repo englishstreetventures/osn-tracker --body "C-Q1"'),
    ).toBe(false);
    expect(
      refusedHere('gh api repos/englishstreetventures/osn-tracker/issues -f body="S-Q9"'),
    ).toBe(false);
    expect(refusedHere('git commit -m "Closes englishstreetventures/osn-tracker#12"')).toBe(false);
    expect(refusedHere('git commit -m "IDs look like S-C/H/M/L"')).toBe(false);
    expect(refusedHere("printf 'x' > m && git commit -F m")).toBe(false);
  });
});

describe("7. GitHub MCP writes", () => {
  const mcp = (tool: string, input: object): HookInput =>
    call(`mcp__github__${tool}`, { owner: "englishstreetventures", repo: "osn", ...input });

  test("an ID in any string of a public write is refused", () => {
    expect(refused(mcp("create_pull_request", { title: "t", body: "fixes S-Q9" }))).toBe(true);
    expect(refused(mcp("issue_write", { method: "create", body: "S-Q9" }))).toBe(true);
    expect(refused(mcp("add_issue_comment", { body: "S-Q9" }))).toBe(true);
    expect(refused(mcp("update_pull_request", { title: "S-Q9" }))).toBe(true);
    expect(
      refused(mcp("push_files", { files: [{ path: "a.md", content: "S-Q9" }], message: "m" })),
    ).toBe(true);
  });

  test("14. the tracker and reads pass", () => {
    expect(refused(mcp("issue_write", { repo: "osn-tracker", body: "S-Q9" }))).toBe(false);
    expect(refused(mcp("search_issues", { query: "S-Q9" }))).toBe(false);
    expect(
      refused(mcp("create_pull_request", { body: "Closes englishstreetventures/osn-tracker#3" })),
    ).toBe(false);
  });
});

describe("8. test location", () => {
  const write = (file_path: string) => call("Write", { file_path, content: "x" });
  const edit = (file_path: string) => call("Edit", { file_path, old_string: "a", new_string: "b" });

  test("a test under a workspace's src/ is refused, in any worktree of the repo", () => {
    expect(refused(write(`${ROOT}/osn/api/src/routes/a.test.ts`))).toBe(true);
    expect(refused(edit(`${ROOT}/cire/a/src/b/C.Spec.tsx`))).toBe(true);
    expect(refused(write(`${ROOT}/osn/api/src/x_test.go`))).toBe(true);
    expect(refused(write(`${MAIN_WT}/osn/api/src/a.test.ts`))).toBe(true);
  });

  test("15. tests/, ordinary names, non-workspaces and other repos pass", () => {
    expect(refused(write(`${ROOT}/osn/api/tests/routes/a.test.ts`))).toBe(false);
    expect(refused(write(`${ROOT}/osn/api/src/contest.ts`))).toBe(false);
    expect(refused(write(`${ROOT}/wiki/src/a.test.ts`))).toBe(false);
    expect(refused(write("/tmp/other-repo/pkg/src/x.test.ts"))).toBe(false);
  });
});

describe("9. Agent", () => {
  const agent = (subagent_type?: string) =>
    call("Agent", { description: "d", prompt: "p", ...(subagent_type ? { subagent_type } : {}) });

  test("an Agent call with no subagent_type is refused", () => {
    expect(refused(agent())).toBe(true);
  });

  test("16. a named type passes, general-purpose included", () => {
    expect(refused(agent("general-purpose"))).toBe(false);
    expect(refused(agent("reviewer"))).toBe(false);
    expect(refused(agent("fork"))).toBe(false);
  });
});

describe("10. quotes", () => {
  test("text inside quotes is not a command", () => {
    expect(refused(bash('grep -E "heredoc|bun install" f'))).toBe(false);
    expect(refused(bash('echo "bun install"'))).toBe(false);
    expect(refused(bash("rg 'a;bun i' ."))).toBe(false);
    expect(refused(bash('echo "git commit"', MAIN_WT))).toBe(false);
    expect(refused(bash("echo 'git push origin main'"))).toBe(false);
  });
});

describe("17. fail open", () => {
  test("a missing message file and an unknown repo pass", () => {
    expect(refused(bash("git commit -F missing.txt"))).toBe(false);
    expect(refused(bash("git commit -m x", "/nowhere"))).toBe(false);
  });

  test("a missing tool_input passes", () => {
    expect(refused(call("Bash", undefined))).toBe(false);
  });
});
