import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  changeClass,
  changedLines,
  classifyPath,
  designCandidate,
  parseRawZ,
  reviewScope,
  stateCandidate,
  writesState,
} from "../review-scope";

// --- what each path is --------------------------------------------------------

test("Markdown outside the exclusions is a doc", () => {
  expect(classifyPath("wiki/conventions/session-metrics.md")).toBe("doc");
  expect(classifyPath("README.md")).toBe("doc");
  expect(classifyPath("tools/pr-metrics/README.md")).toBe("doc");
  expect(classifyPath(".changeset/quiet-owls-sing.md")).toBe("doc");
  expect(classifyPath("docs/superpowers/plans/plan.md")).toBe("doc");
});

// MDX carries components and script, so it is source, not prose.
test("only plain Markdown counts as a doc, wherever it sits", () => {
  expect(classifyPath("docs/page.mdx")).toBe("other");
  expect(classifyPath("wiki/assets/diagram.svg")).toBe("other");
  expect(classifyPath("docs/plugin.js")).toBe("other");
});

test("test code and snapshots under tests/, or named .test./.spec., are tests", () => {
  expect(classifyPath("tools/pr-metrics/tests/backfill.test.ts")).toBe("test");
  expect(classifyPath("scripts/tests/changeset-required.test.sh")).toBe("test");
  expect(classifyPath("osn/api/tests/helpers/db.ts")).toBe("test");
  expect(classifyPath("tools/lab/widget.spec.tsx")).toBe("test");
  expect(classifyPath("shared/ui/tests/__snapshots__/button.test.tsx.snap")).toBe("test");
  expect(classifyPath("scripts/tests/fixture.mjs")).toBe("test");
});

// A fixture or config file under tests/ can be read by a build or a workflow
// as easily as by a test.
test("a tests/ file that is not test code is not a test", () => {
  expect(classifyPath("osn/api/tests/fixtures/user.json")).toBe("other");
  expect(classifyPath("cire/api/tests/wrangler.toml")).toBe("other");
  expect(classifyPath("tests/fixtures/payload.yml")).toBe("other");
});

// Each exclusion beats every class it could otherwise fall into.
test("nothing under a src/ directory qualifies, tests and Markdown included", () => {
  expect(classifyPath("osn/api/src/routes/auth.ts")).toBe("other");
  expect(classifyPath("cire/api/src/lib/claim.test.ts")).toBe("other");
  expect(classifyPath("pulse/web/src/README.md")).toBe("other");
  expect(classifyPath("src/notes.md")).toBe("other");
});

test("nothing under .github/ qualifies, Markdown included", () => {
  expect(classifyPath(".github/workflows/ci.yml")).toBe("other");
  expect(classifyPath(".github/workflows/README.md")).toBe("other");
  expect(classifyPath(".github/pull_request_template.md")).toBe("other");
  expect(classifyPath(".github/CODEOWNERS")).toBe("other");
});

test("no package.json and no lockfile qualifies, wherever it sits", () => {
  expect(classifyPath("package.json")).toBe("other");
  expect(classifyPath("osn/api/tests/package.json")).toBe("other");
  expect(classifyPath("bun.lock")).toBe("other");
  expect(classifyPath("skills-lock.json")).toBe("other");
});

// Agent instructions decide what an agent may do — a SKILL.md can widen its
// `allowed-tools`, and the review skills and prep-pr define this gate — so
// none of them is prose.
test("agent instructions are never trivial, whatever their extension", () => {
  expect(classifyPath("AGENTS.md")).toBe("other");
  expect(classifyPath("CLAUDE.md")).toBe("other");
  expect(classifyPath("osn/api/AGENTS.md")).toBe("other");
  expect(classifyPath("cire/CLAUDE.local.md")).toBe("other");
  // macOS reads `claude.md` as `CLAUDE.md`.
  expect(classifyPath("pulse/claude.md")).toBe("other");
  expect(classifyPath(".claude/skills/prep-pr/SKILL.md")).toBe("other");
  expect(classifyPath(".claude/skills/review-security/SKILL.md")).toBe("other");
  expect(classifyPath(".claude/agents/reviewer.md")).toBe("other");
  expect(classifyPath(".claude/evals/prep-pr-finding-routing/prompt.md")).toBe("other");
  expect(classifyPath(".claude/metrics/chore-x.json")).toBe("other");
  expect(classifyPath(".agents/skills/webgpu-threejs-tsl/SKILL.md")).toBe("other");
  expect(classifyPath("tools/lab/.claude/settings.json")).toBe("other");
});

test("an environment file is never trivial, under any name", () => {
  expect(classifyPath(".env")).toBe("other");
  expect(classifyPath("cire/api/.env.example.md")).toBe("other");
  expect(classifyPath("osn/api/tests/.env.test.ts")).toBe("other");
});

test("config, hooks and scripts are not trivial", () => {
  expect(classifyPath("lefthook.yml")).toBe("other");
  expect(classifyPath("scripts/review-scope.ts")).toBe("other");
});

// `git diff --name-only` without `-z` wraps a path holding a quote, a
// backslash or a byte outside ASCII in double quotes and escapes it.
test("a quoted path is never trivial", () => {
  expect(classifyPath('"wiki/caf\\303\\251.md"')).toBe("other");
  expect(classifyPath('"wiki/a\\"b.md"')).toBe("other");
  // The closing quote would otherwise pass for part of a test file's extension.
  expect(classifyPath('"tests/caf\\303\\251.test.ts"')).toBe("other");
});

test("a path that climbs out or names itself is never trivial", () => {
  expect(classifyPath("../wiki/x.md")).toBe("other");
  expect(classifyPath("wiki/../osn/api/x.md")).toBe("other");
  expect(classifyPath("/wiki/x.md")).toBe("other");
  expect(classifyPath("./wiki/x.md")).toBe("other");
});

// --- what each change is ------------------------------------------------------

test("a symlink, a submodule or a mode change is never trivial", () => {
  expect(changeClass({ path: "wiki/a.md", modes: ["000000", "120000"] })).toBe("other");
  expect(changeClass({ path: "wiki/a.md", modes: ["120000", "100644"] })).toBe("other");
  expect(changeClass({ path: "docs/vendor.md", modes: ["000000", "160000"] })).toBe("other");
  expect(changeClass({ path: "scripts/tests/run.test.sh", modes: ["100644", "100755"] })).toBe(
    "other",
  );
  expect(changeClass({ path: "wiki/a.md", modes: [], symlink: true })).toBe("other");
});

test("an added, edited or deleted regular file takes its path's class", () => {
  expect(changeClass({ path: "wiki/a.md", modes: ["000000", "100644"] })).toBe("doc");
  expect(changeClass({ path: "wiki/a.md", modes: ["100644", "100644"] })).toBe("doc");
  expect(changeClass({ path: "wiki/a.md", modes: ["100644", "000000"] })).toBe("doc");
  expect(changeClass({ path: "wiki/a.md", modes: [] })).toBe("doc");
});

test("parseRawZ reads `git diff --raw -z --no-renames` output", () => {
  const output = [
    ":000000 100644 0000000 1234567 A",
    "wiki/new.md",
    ":100644 120000 89abcde 7654321 T",
    "wiki/link.md",
    ":100644 100644 1111111 2222222 M",
    "wiki/line\nbreak.md",
    "",
  ].join("\0");

  expect(parseRawZ(output)).toEqual([
    { path: "wiki/new.md", modes: ["000000", "100644"] },
    { path: "wiki/link.md", modes: ["100644", "120000"] },
    { path: "wiki/line\nbreak.md", modes: ["100644", "100644"] },
  ]);
  expect(parseRawZ("")).toEqual([]);
});

// --- the verdict --------------------------------------------------------------

const file = (path: string) => ({ path, modes: ["100644", "100644"] });

test("docs alone are trivial", () => {
  expect(reviewScope([file("wiki/a.md"), file("README.md")])).toBe("trivial");
});

test("a test among docs keeps review-tests", () => {
  expect(reviewScope([file("wiki/a.md"), file("scripts/tests/x.test.ts")])).toBe("trivial-tests");
  expect(reviewScope([file("tools/pr-metrics/tests/x.test.ts")])).toBe("trivial-tests");
});

test("one change outside the list makes the whole diff full", () => {
  expect(reviewScope([file("wiki/a.md"), file(".claude/skills/prep-pr/SKILL.md")])).toBe("full");
  expect(reviewScope([file("wiki/a.md"), { path: "wiki/b.md", modes: ["000000", "120000"] }])).toBe(
    "full",
  );
});

// An empty list means the wrong range was diffed, never that nothing changed,
// so it gets every review there is, the state and design reviews included.
test("an empty list is full-state-design", () => {
  expect(reviewScope([])).toBe("full-state-design");
});

test("a full diff that writes state is full-state", () => {
  expect(reviewScope([file("pulse/api/src/services/events.ts")], true)).toBe("full-state");
  expect(reviewScope([file("pulse/api/src/services/events.ts")], false)).toBe("full");
});

test("a full diff that changes how a screen looks is full-design", () => {
  expect(reviewScope([file("cire/host/src/components/Foo.tsx")], false, true)).toBe("full-design");
});

test("state and design together are full-state-design", () => {
  expect(reviewScope([file("pulse/web/src/pages/Event.tsx")], true, true)).toBe(
    "full-state-design",
  );
});

// A trivial diff holds no source, so neither flag can lift it; the flags are
// only ever computed for a full diff, and this holds if a caller passes them.
test("neither state nor design lifts a trivial verdict", () => {
  expect(reviewScope([file("wiki/a.md")], true, true)).toBe("trivial");
  expect(reviewScope([file("wiki/a.md"), file("tests/a.test.ts")], true, true)).toBe(
    "trivial-tests",
  );
});

// --- whether the diff writes state --------------------------------------------

const SERVICE = "pulse/api/src/services/events.ts";
const UPDATE_CHAIN = [
  "export const close = (id: string) =>",
  "  db",
  "    .update(events)",
  "    .set({",
  '      status: "finished",',
  "    })",
  "    .where(eq(events.id, id));",
].join("\n");

test("only source and migrations are read for state, never tests or tooling", () => {
  expect(stateCandidate(file(SERVICE))).toBe(true);
  expect(stateCandidate(file("cire/db/src/schema.ts"))).toBe(true);
  expect(stateCandidate(file("cire/db/migrations/0091_task_assignees.sql"))).toBe(true);
  expect(stateCandidate(file("pulse/web/src/pages/Event.tsx"))).toBe(true);

  expect(stateCandidate(file("pulse/api/tests/services/events.test.ts"))).toBe(false);
  expect(stateCandidate(file("pulse/api/tests/helpers/db.ts"))).toBe(false);
  expect(stateCandidate(file("cire/db/tests/migrations/0001_seed.sql"))).toBe(false);
  expect(stateCandidate(file("cire/api/src/lib/claim.test.ts"))).toBe(false);
  expect(stateCandidate(file("cire/api/src/lib/claim.spec.ts"))).toBe(false);

  expect(stateCandidate(file("scripts/review-scope.ts"))).toBe(false);
  expect(stateCandidate(file("scripts/cire-db-migrate.ts"))).toBe(false);
  expect(stateCandidate(file("pulse/api/src/README.md"))).toBe(false);
  expect(stateCandidate(file("cire/api/src/fixtures/rows.json"))).toBe(false);
});

test("a symlink or a submodule is never read for state", () => {
  expect(stateCandidate({ path: SERVICE, modes: ["000000", "120000"] })).toBe(false);
  expect(stateCandidate({ path: SERVICE, modes: ["100644", "160000"] })).toBe(false);
  expect(stateCandidate({ path: SERVICE, modes: [], symlink: true })).toBe(false);
});

test("a status line counts when the file writes the database, though the line holds no write call", () => {
  expect(writesState(SERVICE, ['      status: "cancelled",'], UPDATE_CHAIN)).toBe(true);
});

test("a removed guard counts: the removed line is the one naming the status", () => {
  const patch = [
    "diff --git a/pulse/api/src/services/events.ts b/pulse/api/src/services/events.ts",
    "index 1111111..2222222 100644",
    "--- a/pulse/api/src/services/events.ts",
    "+++ b/pulse/api/src/services/events.ts",
    "@@ -7 +7 @@",
    '-    .where(and(eq(events.id, id), ne(events.status, "cancelled")));',
    "+    .where(eq(events.id, id));",
    "",
  ].join("\n");

  expect(writesState(SERVICE, changedLines(patch), UPDATE_CHAIN)).toBe(true);
});

test("timestamps, actors and reasons that travel with a state count", () => {
  for (const line of [
    "      completedAt: new Date(),",
    "    set.paidAt = null;",
    "      revokedBy: callerId,",
    '      cancellationReason: "organiser",',
    "      hardDeleteAt: nowSec + window,",
    "      isArchived: true,",
  ]) {
    expect(writesState(SERVICE, [line], UPDATE_CHAIN)).toBe(true);
  }
});

test("a state declared in a schema file counts", () => {
  const schema =
    'export const imports = sqliteTable("imports", {\n  id: text("id").primaryKey(),\n});';
  for (const line of [
    '    kind: text("kind", { enum: ["import", "editor"] }).notNull(),',
    '    selected: integer("selected", { mode: "boolean" }).notNull(),',
    'export type Tier = "gold" | "crimson";',
    "    check(\"unlock_codes_tier_ck\", sql`tier in ('gold','crimson')`),",
    'const Tier = Schema.Literals(["gold", "crimson"]);',
  ]) {
    expect(writesState("cire/db/src/schema.ts", [line], schema)).toBe(true);
  }
});

test("a migration that adds a state column, a CHECK or a trigger counts", () => {
  const migration = "cire/db/migrations/20261104091938_vendor_status_check.sql";
  for (const line of [
    "ALTER TABLE `tasks` ADD `archived_at` integer;",
    "CREATE TRIGGER `vendors_tier` BEFORE INSERT ON `vendors`",
    "\tCONSTRAINT `unlock_codes_tier_ck` CHECK(tier in ('gold','crimson')),",
    "\t`payment_status` text NOT NULL,",
  ]) {
    expect(writesState(migration, [line], "")).toBe(true);
  }
});

test("creation and update stamps alone are not state", () => {
  const lines = [
    "      createdAt: now,",
    "      updatedAt: now,",
    "      imagesUpdatedAt: now,",
    "  `created_by` text NOT NULL,",
    "  `last_updated_at` integer,",
    "      lastUpdatedBy: callerId,",
  ];
  expect(writesState(SERVICE, lines, UPDATE_CHAIN)).toBe(false);
  expect(writesState("cire/db/migrations/0092_x.sql", lines, "")).toBe(false);
});

test("orderBy and groupBy are not actor markers", () => {
  const lines = ["    .orderBy(desc(events.startTime))", "    .groupBy(registryClaims.weddingId)"];
  expect(writesState(SERVICE, lines, UPDATE_CHAIN)).toBe(false);
});

test("a status word in code that writes no database is not state", () => {
  const route = 'app.get("/events/:id", ({ set }) => {\n  set.status = 404;\n});';
  expect(writesState("pulse/api/src/routes/events.ts", ["  set.status = 404;"], route)).toBe(false);
  expect(
    writesState(
      "pulse/web/src/pages/Event.tsx",
      ["  const [status, setStatus] = createSignal();"],
      "",
    ),
  ).toBe(false);
});

test("a local boolean in a file that writes the database is not a flag", () => {
  const lines = ["    const isOwner = existing.createdByProfileId === callerId;"];
  expect(writesState(SERVICE, lines, UPDATE_CHAIN)).toBe(false);
});

test("a comment naming a status is not state", () => {
  const lines = [
    "    // status moves to cancelled here",
    "   * The status column is terminal once cancelled.",
    "    /* status */",
  ];
  expect(writesState(SERVICE, lines, UPDATE_CHAIN)).toBe(false);
  expect(writesState("cire/db/migrations/0092_x.sql", ["-- status is a stage"], "")).toBe(false);
});

test("changedLines keeps every added and removed line after the hunk header", () => {
  const patch = [
    "diff --git a/cire/db/migrations/0092_x.sql b/cire/db/migrations/0092_x.sql",
    "index 1111111..2222222 100644",
    "--- a/cire/db/migrations/0092_x.sql",
    "+++ b/cire/db/migrations/0092_x.sql",
    "@@ -2 +2 @@",
    "--- an old comment",
    "+++retries;",
    "@@ -9,0 +10 @@",
    "+ALTER TABLE `t` ADD `s` text;",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  expect(changedLines(patch)).toEqual([
    "-- an old comment",
    "++retries;",
    "ALTER TABLE `t` ADD `s` text;",
  ]);
  expect(changedLines("")).toEqual([]);
});

// --- whether the diff changes how a screen looks ------------------------------

test("markup and style files in a product count", () => {
  expect(designCandidate(file("cire/host/src/components/invite/EnvelopePicker.tsx"))).toBe(true);
  expect(designCandidate(file("pulse/web/src/explore/NavPill.jsx"))).toBe(true);
  expect(designCandidate(file("cire/landing/src/components/sections/Faq.astro"))).toBe(true);
  expect(designCandidate(file("cire/host/src/styles/global.css"))).toBe(true);
  expect(designCandidate(file("musubi/social/index.html"))).toBe(true);
  expect(designCandidate(file("pulse/web/public/marker.svg"))).toBe(true);
  expect(designCandidate(file("pulse/landing/src/pages/guide.mdx"))).toBe(true);
});

// The component packages build classes in plain `.ts` modules too
// (`shared/ui/src/ui/control.ts`, `cire/ui/src/sign-in-card-class.ts`), and
// every surface that imports them changes with them. `@cire/theme` holds the
// guest site's palette and type in `.ts` alone.
test("any source file in a component, token or theme package counts", () => {
  expect(designCandidate(file("shared/ui/src/ui/control.ts"))).toBe(true);
  expect(designCandidate(file("shared/ui/src/lib/utils.ts"))).toBe(true);
  expect(designCandidate(file("cire/ui/src/sign-in-card-class.ts"))).toBe(true);
  expect(designCandidate(file("osn/auth-ui/src/index.ts"))).toBe(true);
  expect(designCandidate(file("shared/design-tokens/src/index.ts"))).toBe(true);
  expect(designCandidate(file("cire/theme/src/palette.ts"))).toBe(true);
  expect(designCandidate(file("cire/theme/src/typography.ts"))).toBe(true);
});

test("a plain .ts file outside the component packages does not count", () => {
  expect(designCandidate(file("pulse/api/src/services/events.ts"))).toBe(false);
  expect(designCandidate(file("cire/host/src/lib/api.ts"))).toBe(false);
  expect(designCandidate(file("shared/ui/package.json"))).toBe(false);
  expect(designCandidate(file("cire/ui/README.md"))).toBe(false);
});

test("test code never counts, a browser test included", () => {
  expect(designCandidate(file("cire/host/tests/components/Foo.test.tsx"))).toBe(false);
  expect(designCandidate(file("cire/host/tests/styles/chip-contrast.browser.test.tsx"))).toBe(
    false,
  );
  expect(designCandidate(file("cire/host/tests/fixtures/page.html"))).toBe(false);
  expect(designCandidate(file("shared/ui/tests/ui/button.test.tsx"))).toBe(false);
  expect(designCandidate(file("shared/ui/src/ui/button.spec.tsx"))).toBe(false);
});

test("tooling, docs and agent trees never count", () => {
  expect(designCandidate(file("tools/lab/src/stories/shared-ui/Button.story.tsx"))).toBe(false);
  expect(designCandidate(file("tools/metrics/index.html"))).toBe(false);
  expect(designCandidate(file("scripts/report.html"))).toBe(false);
  expect(designCandidate(file("wiki/assets/diagram.svg"))).toBe(false);
  expect(designCandidate(file("docs/superpowers/mock.html"))).toBe(false);
  expect(designCandidate(file(".claude/mods/panel/index.tsx"))).toBe(false);
  expect(designCandidate(file(".agents/skills/stageshow/kit/frame.css"))).toBe(false);
  expect(designCandidate(file(".github/assets/badge.svg"))).toBe(false);
  expect(designCandidate(file(".changeset/x.mdx"))).toBe(false);
});

test("a symlink or a submodule never counts", () => {
  const view = "cire/host/src/components/Foo.tsx";
  expect(designCandidate({ path: view, modes: ["000000", "120000"] })).toBe(false);
  expect(designCandidate({ path: view, modes: ["100644", "160000"] })).toBe(false);
  expect(designCandidate({ path: view, modes: [], symlink: true })).toBe(false);
});

test("an added or deleted view counts", () => {
  const view = "cire/host/src/components/Foo.tsx";
  expect(designCandidate({ path: view, modes: ["000000", "100644"] })).toBe(true);
  expect(designCandidate({ path: view, modes: ["100644", "000000"] })).toBe(true);
});

// --- the command, in a real repository ----------------------------------------

const SCRIPT = new URL("../review-scope.ts", import.meta.url).pathname;

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "review-scope-"));
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

  git("init", "-q", "-b", "main");
  await mkdir(join(dir, "wiki"));
  await writeFile(join(dir, "wiki", "a.md"), "# a\n");
  await writeFile(join(dir, "run.sh"), "echo\n");
  git("add", ".");
  git("commit", "-qm", "seed");
  git("checkout", "-qb", "work");

  return { dir, git };
}

async function scope(dir: string, args: string[] = ["main"]) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

test("the command sizes committed, uncommitted and untracked work together", async () => {
  const { dir, git } = await repo();
  try {
    await writeFile(join(dir, "wiki", "a.md"), "# a, edited\n");
    git("commit", "-qam", "doc");
    expect(await scope(dir)).toEqual({ stdout: "trivial\n", stderr: "", exitCode: 0 });

    // Uncommitted test code joins the committed doc change.
    await mkdir(join(dir, "tests"));
    await writeFile(join(dir, "tests", "a.test.ts"), "export {};\n");
    expect((await scope(dir)).stdout).toBe("trivial-tests\n");

    // And an untracked source file outweighs both.
    await writeFile(join(dir, "app.ts"), "export {};\n");
    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds a committed symlink with a Markdown name", async () => {
  const { dir, git } = await repo();
  try {
    await symlink("../run.sh", join(dir, "wiki", "link.md"));
    git("add", ".");
    git("commit", "-qm", "link");

    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds an untracked symlink with a Markdown name", async () => {
  const { dir } = await repo();
  try {
    await symlink("../run.sh", join(dir, "wiki", "link.md"));

    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds a file made executable", async () => {
  const { dir, git } = await repo();
  try {
    await chmod(join(dir, "wiki", "a.md"), 0o755);
    git("commit", "-qam", "mode");

    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Without `-z` git would print this name quoted; with it, the name arrives
// whole and is judged as it is.
test("the command reads a path with a quote and a newline whole", async () => {
  const { dir, git } = await repo();
  try {
    await writeFile(join(dir, "wiki", 'say "hi"\nthere.md'), "# hi\n");
    git("add", ".");
    git("commit", "-qm", "odd name");

    expect((await scope(dir)).stdout).toBe("trivial\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const WRITER = [
  "export const close = (id: string) =>",
  "  db",
  "    .update(events)",
  "    .set({ endTime: now })",
  "    .where(eq(events.id, id));",
  "",
].join("\n");

test("the command finds state in committed, uncommitted and untracked source", async () => {
  const { dir, git } = await repo();
  try {
    await mkdir(join(dir, "svc", "src"), { recursive: true });
    await writeFile(join(dir, "svc", "src", "events.ts"), WRITER);
    git("add", ".");
    git("commit", "-qm", "a writer of no state");
    expect((await scope(dir)).stdout).toBe("full\n");

    // An uncommitted edit to the committed writer.
    await writeFile(
      join(dir, "svc", "src", "events.ts"),
      WRITER.replace("{ endTime: now }", '{ endTime: now, status: "finished" }'),
    );
    expect((await scope(dir)).stdout).toBe("full-state\n");

    // Committed, it still counts.
    git("commit", "-qam", "close writes status");
    expect((await scope(dir)).stdout).toBe("full-state\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds state in an untracked file", async () => {
  const { dir } = await repo();
  try {
    await mkdir(join(dir, "svc", "src"), { recursive: true });
    await writeFile(
      join(dir, "svc", "src", "events.ts"),
      WRITER.replace("{ endTime: now }", '{\n      status: "finished",\n    }'),
    );
    expect((await scope(dir)).stdout).toBe("full-state\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds state in a deleted writer", async () => {
  const { dir, git } = await repo();
  try {
    git("checkout", "-q", "main");
    await mkdir(join(dir, "svc", "src"), { recursive: true });
    await writeFile(
      join(dir, "svc", "src", "events.ts"),
      WRITER.replace("{ endTime: now }", '{ status: "finished" }'),
    );
    git("add", ".");
    git("commit", "-qm", "a writer of status");
    git("checkout", "-q", "-B", "work");
    git("rm", "-q", "svc/src/events.ts");
    git("commit", "-qm", "drop the writer");

    expect((await scope(dir)).stdout).toBe("full-state\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command reads no state from test code or tooling", async () => {
  const { dir } = await repo();
  try {
    await mkdir(join(dir, "svc", "tests"), { recursive: true });
    await writeFile(
      join(dir, "svc", "tests", "events.test.ts"),
      WRITER.replace("{ endTime: now }", '{ status: "finished" }'),
    );
    expect((await scope(dir)).stdout).toBe("trivial-tests\n");

    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(
      join(dir, "scripts", "seed.ts"),
      WRITER.replace("{ endTime: now }", '{ status: "finished" }'),
    );
    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds a view changed in committed, uncommitted and untracked work", async () => {
  const { dir, git } = await repo();
  try {
    await mkdir(join(dir, "app", "src"), { recursive: true });
    await writeFile(join(dir, "app", "src", "logic.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-qm", "logic");
    expect((await scope(dir)).stdout).toBe("full\n");

    // An untracked view.
    await writeFile(join(dir, "app", "src", "View.tsx"), "export const V = () => <p />;\n");
    expect((await scope(dir)).stdout).toBe("full-design\n");

    // Committed, then edited and left uncommitted, it still counts.
    git("add", ".");
    git("commit", "-qm", "view");
    expect((await scope(dir)).stdout).toBe("full-design\n");
    await writeFile(join(dir, "app", "src", "View.tsx"), "export const V = () => <b />;\n");
    expect((await scope(dir)).stdout).toBe("full-design\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds a deleted stylesheet", async () => {
  const { dir, git } = await repo();
  try {
    git("checkout", "-q", "main");
    await mkdir(join(dir, "app", "src"), { recursive: true });
    await writeFile(join(dir, "app", "src", "global.css"), "a { color: red; }\n");
    git("add", ".");
    git("commit", "-qm", "styles");
    git("checkout", "-q", "-B", "work");
    git("rm", "-q", "app/src/global.css");
    git("commit", "-qm", "drop the styles");

    expect((await scope(dir)).stdout).toBe("full-design\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds state and design in one diff", async () => {
  const { dir } = await repo();
  try {
    await mkdir(join(dir, "svc", "src"), { recursive: true });
    await writeFile(
      join(dir, "svc", "src", "events.ts"),
      WRITER.replace("{ endTime: now }", '{ status: "finished" }'),
    );
    await writeFile(join(dir, "svc", "src", "Close.tsx"), "export const C = () => <p />;\n");

    expect((await scope(dir)).stdout).toBe("full-state-design\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command reads no design from test code or tooling", async () => {
  const { dir } = await repo();
  try {
    await mkdir(join(dir, "app", "tests"), { recursive: true });
    await writeFile(join(dir, "app", "tests", "View.test.tsx"), "export {};\n");
    expect((await scope(dir)).stdout).toBe("trivial-tests\n");

    await mkdir(join(dir, "tools", "lab", "src"), { recursive: true });
    await writeFile(join(dir, "tools", "lab", "src", "Story.tsx"), "export {};\n");
    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command refuses to run without a base", async () => {
  const { dir } = await repo();
  try {
    const run = await scope(dir, []);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("base");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command fails rather than answering when git cannot diff", async () => {
  const { dir } = await repo();
  try {
    const run = await scope(dir, ["no-such-ref"]);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
