import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkOrders } from "../../../scripts/check-migration-orders";

// The migration workflow end to end, on a throwaway repository holding a copy
// of cire's real schema and chain: branches that each run `db:generate`, merged
// in parallel, then checked the way the merge queue checks them. drizzle-kit
// writes the SQL; nothing here hand-writes a migration. The verdicts are
// written to e2e-artifacts/migrations/flow.json.
//
// Each `db:generate` runs drizzle-kit twice, a few seconds apiece.

const CIRE_DB = join(import.meta.dir, "..");
const REPO_ROOT = join(CIRE_DB, "..", "..");
const GENERATE = join(REPO_ROOT, "scripts", "db-generate.ts");

let repo: string;
let pkg: string;
const flow: Record<string, unknown> = {};

const git = (...args: string[]): string => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.email=flow@test", "-c", "user.name=flow", ...args],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

function generate(name: string, extra: string[] = []): { exitCode: number; output: string } {
  const result = Bun.spawnSync([process.execPath, "run", GENERATE, pkg, "--name", name, ...extra], {
    cwd: pkg,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const schemaPath = () => join(pkg, "src", "schema.ts");
const migrationsDir = () => join(pkg, "migrations");

/** Insert `line` as the first column of `table` in the working-tree schema. */
function addToTable(table: string, line: string): void {
  const schema = readFileSync(schemaPath(), "utf8");
  const anchor = new RegExp(`sqliteTable\\(\\s*"${table}",\\s*\\{\\n`);
  const match = anchor.exec(schema);
  if (!match) throw new Error(`no table ${table} in the schema`);
  const at = match.index + match[0].length;
  writeFileSync(schemaPath(), `${schema.slice(0, at)}    ${line}\n${schema.slice(at)}`);
}

/** Add an index to `table` by appending it to the table's extra-config array. */
function addIndexTo(table: string, index: string): void {
  const schema = readFileSync(schemaPath(), "utf8");
  const start = new RegExp(`sqliteTable\\(\\s*"${table}",`).exec(schema)?.index;
  if (start === undefined) throw new Error(`no table ${table} in the schema`);
  const open = schema.indexOf("(t) => [", start);
  if (open === -1) throw new Error(`table ${table} has no index list to add to`);
  const at = open + "(t) => [".length;
  writeFileSync(schemaPath(), `${schema.slice(0, at)}\n    ${index},${schema.slice(at)}`);
}

/** Commit the working tree, migration included, on the current branch. */
function commit(message: string): string[] {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("show", "--name-only", "--format=", "HEAD")
    .split("\n")
    .filter((path) => path.endsWith(".sql"))
    .map((path) => path.split("/").at(-1)!);
}

/** A branch off `main` that changes the schema and generates its migration. */
function branch(name: string, change: () => void): string[] {
  git("checkout", "-q", "-b", name, "main");
  change();
  const made = generate(name);
  expect(made.exitCode).toBe(0);
  const files = commit(name);
  expect(files).toHaveLength(1);
  git("checkout", "-q", "main");
  return files;
}

const sleepPastTheSecond = () => Bun.sleepSync(1_100);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "migration-flow-"));
  pkg = join(repo, "cire", "db");
  mkdirSync(pkg, { recursive: true });
  cpSync(join(CIRE_DB, "src"), join(pkg, "src"), { recursive: true });
  cpSync(join(CIRE_DB, "migrations"), join(pkg, "migrations"), { recursive: true });
  writeFileSync(
    join(pkg, "drizzle.config.ts"),
    'export default { dialect: "sqlite", schema: "./src/schema.ts", out: "./migrations" };\n',
  );
  symlinkSync(join(CIRE_DB, "node_modules"), join(pkg, "node_modules"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git("init", "-q", "-b", "main");
  commit("the chain as cire has it");
});

afterAll(() => {
  const out = join(REPO_ROOT, "e2e-artifacts", "migrations");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "flow.json"), `${JSON.stringify(flow, null, 2)}\n`);
  rmSync(repo, { recursive: true, force: true });
});

describe("db:generate, parallel branches and the merge-queue check", () => {
  test("two branches that change different tables merge in either order and check clean", () => {
    const first = branch("flow_wedding_note", () =>
      addToTable("weddings", 'flowNote: text("flow_note"),'),
    );
    sleepPastTheSecond();
    const second = branch("flow_family_note", () =>
      addToTable("families", 'flowNote: text("flow_note"),'),
    );

    // The second branch merges after the first, though generated later; the
    // merge queue checks its file against main with the first already in.
    git("merge", "-q", "--no-edit", "flow_wedding_note");
    git("merge", "-q", "--no-edit", "flow_family_note");
    expect(checkOrders(migrationsDir(), second)).toEqual({ ok: true });
    expect(checkOrders(migrationsDir(), [...first, ...second])).toEqual({ ok: true });

    // main's schema and chain agree: nothing is left to generate.
    const settled = generate("settled");
    expect(settled.exitCode).toBe(1);
    expect(settled.output).toContain("no schema change");
    flow.parallel = { files: [...first, ...second], ok: true };
  }, 120_000);

  test("two branches whose indexes share a name fail the check, though each table is its own", () => {
    sleepPastTheSecond();
    const weddings = branch("flow_idx_weddings", () =>
      addIndexTo("guests", 'index("flow_shared_idx").on(t.familyId)'),
    );
    sleepPastTheSecond();
    const families = branch("flow_idx_families", () =>
      addIndexTo("families", 'index("flow_shared_idx").on(t.weddingId)'),
    );
    git("merge", "-q", "--no-edit", "flow_idx_weddings");
    git("merge", "-q", "--no-edit", "flow_idx_families");
    const verdict = checkOrders(migrationsDir(), families);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("flow_shared_idx");
    flow.indexNameClash = { files: [...weddings, ...families], verdict };
    git("reset", "-q", "--hard", "HEAD~2");
  }, 120_000);

  test("a possible rename is never guessed: without a terminal it exits 2 and asks for --hints", () => {
    const schema = readFileSync(schemaPath(), "utf8");
    writeFileSync(
      schemaPath(),
      schema.replace('flowNote: text("flow_note"),', 'flowRemark: text("flow_remark"),'),
    );
    const before = readdirSync(migrationsDir()).length;
    const asked = generate("flow_rename");
    expect(asked.exitCode).toBe(2);
    expect(asked.output).toContain("--hints");
    expect(readdirSync(migrationsDir())).toHaveLength(before);
    flow.rename = { exitCode: asked.exitCode };
    git("checkout", "-q", "--", ".");
  }, 60_000);

  test("a second migration on one branch starts from the commit holding the first", () => {
    git("checkout", "-q", "-b", "flow_two_steps", "main");
    sleepPastTheSecond();
    addToTable("weddings", 'flowStepOne: text("flow_step_one"),');
    expect(generate("flow_step_one").exitCode).toBe(0);
    commit("step one");
    sleepPastTheSecond();
    addToTable("weddings", 'flowStepTwo: text("flow_step_two"),');
    const two = generate("flow_step_two");
    expect(two.exitCode).toBe(0);
    const file = two.output.trim().split("\n").at(-1)!;
    expect(readFileSync(join(repo, file), "utf8")).toBe(
      "ALTER TABLE `weddings` ADD `flow_step_two` text;",
    );
    flow.twoSteps = { second: file };
  }, 60_000);

  test("an uncommitted migration in the directory stops the next one", () => {
    sleepPastTheSecond();
    addToTable("families", 'flowStepThree: text("flow_step_three"),');
    const refused = generate("flow_step_three");
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain("commit the migration already in");
    git("checkout", "-q", "-f", "main");
    git("clean", "-qfd");
  }, 60_000);
});
