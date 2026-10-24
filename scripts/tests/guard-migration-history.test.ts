import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { type Change, parseNameStatus, refusals } from "../guard-migration-history";

const FILES: Record<string, string> = {
  "cire/db/migrations/20261021031500_add_bio.sql": "ALTER TABLE `weddings` ADD `bio` text;",
  "osn/db/drizzle/20261021031500_add_bio.sql": "ALTER TABLE `users` ADD `bio` text;",
  "cire/db/migrations/20261021031501_comments_only.sql": "-- nothing to run yet\n",
  "cire/db/migrations/20261021031502_empty.sql": "",
  "cire/db/migrations/20261021031503_rebuild.sql":
    "CREATE TABLE `__new_weddings` (`id` text);\nINSERT INTO `__new_weddings` SELECT `id` FROM `weddings`;",
};
const read = (path: string): string => {
  const sql = FILES[path];
  if (sql === undefined) throw new Error(`no fixture for ${path}`);
  return sql;
};
const check = (changes: Change[], allowRewrite = false) =>
  refusals(changes, read, { allowRewrite });
/** The single reason `changes` are refused, so a test can name the rule that fired. */
const onlyReason = (changes: Change[], allowRewrite = false): string => {
  const reasons = check(changes, allowRewrite);
  expect(reasons).toHaveLength(1);
  return reasons[0]!;
};

// ── what an ordinary migration pull request does ─────────────────────────────

test("a new timestamped migration passes", () => {
  expect(check([{ status: "A", path: "cire/db/migrations/20261021031500_add_bio.sql" }])).toEqual(
    [],
  );
  expect(check([{ status: "A", path: "osn/db/drizzle/20261021031500_add_bio.sql" }])).toEqual([]);
});

test("a README beside the migrations may change", () => {
  expect(check([{ status: "M", path: "cire/db/migrations-archive/README.md" }])).toEqual([]);
});

test("removing drizzle-kit's meta/ journal is not a rewrite: wrangler never read it", () => {
  expect(
    check([
      { status: "D", path: "cire/db/migrations/meta/_journal.json" },
      { status: "D", path: "osn/db/drizzle/meta/0010_snapshot.json" },
    ]),
  ).toEqual([]);
});

test("files outside the migration directories are not its business", () => {
  expect(check([{ status: "D", path: "cire/db/src/schema.ts" }])).toEqual([]);
});

// ── refusals: history that already ran ───────────────────────────────────────

test("refuses an edited migration", () => {
  expect(
    onlyReason([{ status: "M", path: "cire/db/migrations/0088_contribution_item_title.sql" }]),
  ).toContain("was edited after it merged");
});

test("refuses a deleted migration", () => {
  expect(onlyReason([{ status: "D", path: "pulse/db/drizzle/0003_close_friends.sql" }])).toContain(
    "was deleted after it merged",
  );
});

test("refuses a renamed migration", () => {
  expect(
    check([
      {
        status: "R",
        from: "cire/db/migrations/0089_seating.sql",
        path: "cire/db/migrations/0091_seating.sql",
      },
    ])[0],
  ).toContain("0089_seating.sql was renamed to");
});

test("refuses an edited archived migration", () => {
  expect(onlyReason([{ status: "M", path: "cire/db/migrations-archive/0033_x.sql" }])).toContain(
    "was edited after it merged",
  );
});

test("refuses a file added to the archive, which only a squash does", () => {
  expect(onlyReason([{ status: "A", path: "cire/db/migrations-archive/0092_late.sql" }])).toContain(
    "added to the archive",
  );
});

// ── refusals: a new file that is not a migration wrangler will run ───────────

test("refuses a numbered file: the number is what two branches collide on", () => {
  expect(onlyReason([{ status: "A", path: "cire/db/migrations/0091_seating.sql" }])).toContain(
    "is not named <YYYYMMDDHHMMSS>_<snake_name>.sql",
  );
});

test("refuses a drizzle-kit folder or a meta/ journal coming back", () => {
  expect(
    onlyReason([{ status: "A", path: "zap/db/drizzle/20261021031500_x/migration.sql" }]),
  ).toContain("is inside a directory");
  expect(onlyReason([{ status: "A", path: "zap/db/drizzle/meta/_journal.json" }])).toContain(
    "is inside a directory",
  );
});

test("refuses a migration with no statement in it", () => {
  expect(
    onlyReason([{ status: "A", path: "cire/db/migrations/20261021031501_comments_only.sql" }]),
  ).toContain("holds no statement");
  expect(
    onlyReason([{ status: "A", path: "cire/db/migrations/20261021031502_empty.sql" }]),
  ).toContain("holds no statement");
});

test("refuses a copy-and-swap table rebuild", () => {
  expect(
    onlyReason([{ status: "A", path: "cire/db/migrations/20261021031503_rebuild.sql" }]),
  ).toContain("copy-and-swap");
});

// ── the label ────────────────────────────────────────────────────────────────

test("the migrations:rewrite label lets a squash or a deliberate rebuild through", () => {
  const squash: Change[] = [
    {
      status: "R",
      from: "cire/db/migrations/0082_unlock_codes.sql",
      path: "cire/db/migrations-archive/0082_unlock_codes.sql",
    },
    { status: "M", path: "cire/db/migrations/0001_initial.sql" },
    { status: "A", path: "cire/db/migrations/20261021031503_rebuild.sql" },
  ];
  expect(check(squash)).not.toEqual([]);
  expect(check(squash, true)).toEqual([]);
});

test("the label never lets a migration with no statement through", () => {
  expect(
    onlyReason(
      [{ status: "A", path: "cire/db/migrations/20261021031501_comments_only.sql" }],
      true,
    ),
  ).toContain("holds no statement");
});

// ── reading git ──────────────────────────────────────────────────────────────

test("parseNameStatus reads adds, edits, deletes and renames from NUL-separated output", () => {
  expect(
    parseNameStatus(
      "A\0cire/db/migrations/20261021031500_add_bio.sql\0M\0README.md\0D\0x.sql\0R100\0a.sql\0b.sql\0",
    ),
  ).toEqual([
    { status: "A", path: "cire/db/migrations/20261021031500_add_bio.sql" },
    { status: "M", path: "README.md" },
    { status: "D", path: "x.sql" },
    { status: "R", from: "a.sql", path: "b.sql" },
  ]);
});

// ── the command, on a real repository ────────────────────────────────────────

/** Run the guard in a throwaway repository whose last commit makes `change`. */
function runOnCommit(change: (root: string) => void, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "guard-history-"));
  const git = (...a: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=g@t", "-c", "user.name=g", ...a], { cwd: root });
  try {
    mkdirSync(join(root, "cire", "db", "migrations"), { recursive: true });
    writeFileSync(
      join(root, "cire/db/migrations/0001_initial.sql"),
      "CREATE TABLE `t` (`id` text);",
    );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    change(root);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const result = Bun.spawnSync(
      [process.execPath, "run", join(import.meta.dir, "..", "guard-migration-history.ts"), ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const NEW_FILE = "cire/db/migrations/20261021031500_add_bio.sql";
const BASELINE = "cire/db/migrations/0001_initial.sql";

test("the command passes a new timestamped migration and fails an edit, naming it", () => {
  const added = runOnCommit((root) =>
    writeFileSync(join(root, NEW_FILE), "ALTER TABLE `t` ADD `bio` text;"),
  );
  expect(added.exitCode).toBe(0);

  const edited = runOnCommit((root) =>
    writeFileSync(join(root, BASELINE), "CREATE TABLE `t` (`id` integer);"),
  );
  expect(edited.exitCode).toBe(1);
  expect(edited.output).toContain("0001_initial.sql was edited after it merged");
});

test("the command lets an edit through with --allow-rewrite", () => {
  const edited = runOnCommit(
    (root) => writeFileSync(join(root, BASELINE), "CREATE TABLE `t` (`id` integer);"),
    ["--allow-rewrite"],
  );
  expect(edited.exitCode).toBe(0);
});

test("the command checks an added file whose name git would quote, not skip it", () => {
  // Without NUL-separated output git writes this path quoted, with escapes, and
  // it would match no migration directory: every added-file rule skipped.
  const quoted = runOnCommit((root) =>
    writeFileSync(join(root, "cire/db/migrations/20261021031500_café.sql"), "-- nothing to run\n"),
  );
  expect(quoted.exitCode).toBe(1);
  expect(quoted.output).toContain("20261021031500_café.sql");
});

// ── the workflow: main's guard decides, whatever the pull request changes ────

interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, string | number | boolean>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly "working-directory"?: string;
}

const REPO = join(import.meta.dir, "..", "..");
const ON_PULL_REQUEST = "github.event_name == 'pull_request'";

/** The guard job's steps, and the four the guarantee rests on. */
function workflowSteps() {
  const workflow = Bun.YAML.parse(
    readFileSync(join(REPO, ".github/workflows/migration-history.yml"), "utf8"),
  ) as { jobs: { guard: { steps: readonly WorkflowStep[] } } };
  const steps = workflow.jobs.guard.steps;
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@") === true);
  const main = checkouts.find((step) => step.with?.ref !== undefined);
  const pr = checkouts.find((step) => step.with?.ref === undefined);
  const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@") === true);
  const guard = steps.find((step) => step.run?.includes("guard-migration-history.ts") === true);
  if (!main || !pr || !bun || !guard || checkouts.length !== 2) {
    throw new Error("migration-history.yml: expected two checkouts, setup-bun and a guard step");
  }
  return { steps, main, pr, bun, guard };
}

const pathOf = (step: WorkflowStep): string => String(step.with?.path ?? "");

/**
 * Lay out a runner workspace as the workflow does — `main`'s checkout holding
 * this repository's scripts, the pull request's checkout as a repository whose
 * last commit edits a merged migration after `tamper` ran — then run the guard
 * step's own `run:` text where the step runs it.
 */
function runWorkflowGuard({
  tamper = () => {},
  allowRewrite = false,
}: {
  tamper?: (pr: string, workspace: string) => void;
  allowRewrite?: boolean;
}) {
  const { main, pr, guard } = workflowSteps();
  const workspace = mkdtempSync(join(tmpdir(), "guard-workflow-"));
  const git = (cwd: string, ...a: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=g@t", "-c", "user.name=g", ...a], { cwd });
  try {
    const base = join(workspace, pathOf(main));
    cpSync(join(REPO, "scripts"), join(base, "scripts"), {
      recursive: true,
      filter: (source) => !source.split(sep).includes("node_modules"),
    });
    cpSync(join(REPO, ".bun-version"), join(base, ".bun-version"));

    const root = join(workspace, pathOf(pr));
    mkdirSync(join(root, "cire", "db", "migrations"), { recursive: true });
    writeFileSync(join(root, BASELINE), "CREATE TABLE `t` (`id` text);");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    tamper(root, workspace);
    writeFileSync(join(root, BASELINE), "CREATE TABLE `t` (`id` integer);");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change");

    // Only ALLOW_REWRITE comes from the event; every other value is literal.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(guard.env ?? {})) {
      if (!value.includes("${{")) env[name] = value;
    }
    expect(
      Object.entries(guard.env ?? {})
        .filter(([, value]) => value.includes("${{"))
        .map(([name]) => name),
    ).toEqual(["ALLOW_REWRITE"]);
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined,
    );
    const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", guard.run ?? ""], {
      cwd: join(workspace, guard["working-directory"] ?? ""),
      env: {
        ...Object.fromEntries(inherited),
        ...env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        GITHUB_WORKSPACE: workspace,
        ALLOW_REWRITE: String(allowRewrite),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const EDIT_REFUSED = `::error::guard-migration-history: ${BASELINE} was edited after it merged`;

test("the workflow refuses the edit when the pull request replaces its own guard with a pass", () => {
  const run = runWorkflowGuard({
    tamper: (root) => {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts/guard-migration-history.ts"), "process.exit(0);\n");
    },
  });
  expect(run.output).toContain(EDIT_REFUSED);
  expect(run.exitCode).toBe(1);
});

test("the workflow refuses the edit when the pull request adds a bunfig preload that passes", () => {
  const run = runWorkflowGuard({
    tamper: (root) => {
      writeFileSync(join(root, "pass.ts"), "process.exit(0);\n");
      writeFileSync(join(root, "bunfig.toml"), 'preload = ["./pass.ts"]\n');
    },
  });
  expect(run.output).toContain(EDIT_REFUSED);
  expect(run.exitCode).toBe(1);
});

test("the workflow refuses the edit when the pull request's .env points git at a repository with no change", () => {
  const run = runWorkflowGuard({
    tamper: (root, workspace) => {
      const decoy = join(workspace, "decoy");
      mkdirSync(decoy);
      const git = (...a: string[]) =>
        Bun.spawnSync(["git", "-c", "user.email=g@t", "-c", "user.name=g", ...a], { cwd: decoy });
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "one");
      git("commit", "-q", "--allow-empty", "-m", "two");
      writeFileSync(join(root, ".env"), `GIT_DIR=${join(decoy, ".git")}\n`);
    },
  });
  expect(run.output).toContain(EDIT_REFUSED);
  expect(run.exitCode).toBe(1);
});

test("the workflow refuses the edit when the pull request adds a package script or a git named like the guard's", () => {
  const run = runWorkflowGuard({
    tamper: (root, workspace) => {
      const { main } = workflowSteps();
      const guardPath = join(workspace, pathOf(main), "scripts/guard-migration-history.ts");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "pr", scripts: { [guardPath]: "exit 0" } }),
      );
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "git"), 0o755);
    },
  });
  expect(run.output).toContain(EDIT_REFUSED);
  expect(run.exitCode).toBe(1);
});

test("the workflow passes --allow-rewrite when the pull request carries the label", () => {
  const run = runWorkflowGuard({ allowRewrite: true });
  expect(run.output).toContain("guard-migration-history: no migration history rewritten");
  expect(run.exitCode).toBe(0);
});

test("the workflow checks main out beside the pull request, pins main's Bun and runs the guard in the pull request's checkout", () => {
  const { steps, main, pr, bun, guard } = workflowSteps();
  expect(main.with).toEqual({
    ref: "refs/heads/main",
    path: pathOf(main),
    "sparse-checkout": "scripts",
    "persist-credentials": false,
  });
  expect(pr.with).toEqual({ path: pathOf(pr), "fetch-depth": 2, "persist-credentials": false });
  expect(pathOf(main)).not.toBe(pathOf(pr));
  expect([pathOf(main), pathOf(pr)].every((path) => path !== "" && !path.includes("/"))).toBe(true);
  expect(bun.with).toEqual({ "bun-version-file": `${pathOf(main)}/.bun-version` });
  expect(guard["working-directory"]).toBe(pathOf(pr));
  // setup-bun reads main's pin, so main's checkout comes first; the guard needs both.
  const at = (step: WorkflowStep) => steps.indexOf(step);
  expect(at(main)).toBeLessThan(at(bun));
  expect(at(pr)).toBeLessThan(at(bun));
  expect(at(bun)).toBeLessThan(at(guard));
  // A merge-queue group has no checkout: every step but its echo is skipped there.
  const [echo, ...rest] = steps;
  expect(echo?.if).toBe("github.event_name == 'merge_group'");
  expect(rest.map((step) => step.if)).toEqual(rest.map(() => ON_PULL_REQUEST));
});
