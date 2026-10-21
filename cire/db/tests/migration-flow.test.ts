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

// The migration workflow end to end, on throwaway repositories holding copies
// of cire's and osn's real schemas and chains: branches that each run
// `db:generate`, merged in parallel, then checked the way the merge queue
// checks them. drizzle-kit writes the SQL; nothing here hand-writes a
// migration. Every `db:generate` runs with its own TMPDIR, which must hold none
// of its working directories when it exits, whichever way it exits. The verdicts are written to
// e2e-artifacts/migrations/flow.json, with timestamps and temporary paths
// taken out so a rerun writes the same file.
//
// Each `db:generate` runs drizzle-kit twice, a few seconds apiece, and the
// order cases wait for the clock to pass a second so their files sort apart.

const CIRE_DB = join(import.meta.dir, "..");
const REPO_ROOT = join(CIRE_DB, "..", "..");
const GENERATE = join(REPO_ROOT, "scripts", "db-generate.ts");
const SLOW = 300_000;

const flow: Record<string, unknown> = {};
let generateTmp: string;

/** A file name with its stamp, and a reason with its temporary paths, made stable. */
const stable = (text: string): string =>
  text.replaceAll(/\d{14}_/g, "<stamp>_").replaceAll(/\/[^\s:]*migration-flow-[^/\s]+/g, "<repo>");

/** A throwaway repository holding a copy of one db package. */
function workspace(packageDir: string, copy: readonly string[], config: string) {
  const repo = mkdtempSync(join(tmpdir(), "migration-flow-"));
  const relative = packageDir.slice(REPO_ROOT.length + 1);
  const pkg = join(repo, relative);
  mkdirSync(pkg, { recursive: true });
  for (const entry of copy) cpSync(join(packageDir, entry), join(pkg, entry), { recursive: true });
  writeFileSync(join(pkg, "drizzle.config.ts"), config);
  symlinkSync(join(packageDir, "node_modules"), join(pkg, "node_modules"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");

  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(
      ["git", "-c", "user.email=flow@test", "-c", "user.name=flow", ...args],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };

  /** `db:generate` in this package; it must leave its TMPDIR empty. */
  const generate = (name: string, extra: string[] = []) => {
    const result = Bun.spawnSync(
      [process.execPath, "run", GENERATE, pkg, "--name", name, ...extra],
      {
        cwd: pkg,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TMPDIR: generateTmp },
      },
    );
    // Its own working directories only: drizzle-kit keeps a transpile cache
    // (`jiti/`) in TMPDIR on purpose, and reuses it across runs.
    expect(readdirSync(generateTmp).filter((entry) => entry.startsWith("db-generate-"))).toEqual(
      [],
    );
    return {
      exitCode: result.exitCode ?? 1,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  };

  /** Commit the working tree; the names of the `.sql` files the commit adds. */
  const commit = (message: string): string[] => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("show", "--name-only", "--format=", "HEAD")
      .split("\n")
      .filter((path) => path.endsWith(".sql"))
      .map((path) => path.split("/").at(-1)!);
  };

  git("init", "-q", "-b", "main");
  commit("the chain as it is");
  return { repo, pkg, git, generate, commit };
}

type Workspace = ReturnType<typeof workspace>;

/** Insert `line` as the first column of `table` in the working-tree schema. */
function addToTable(schemaPath: string, table: string, line: string): void {
  const schema = readFileSync(schemaPath, "utf8");
  const match = new RegExp(`sqliteTable\\(\\s*"${table}",\\s*\\{\\n`).exec(schema);
  if (!match) throw new Error(`no table ${table} in the schema`);
  const at = match.index + match[0].length;
  writeFileSync(schemaPath, `${schema.slice(0, at)}    ${line}\n${schema.slice(at)}`);
}

/** Add an index to `table` by prepending it to the table's extra-config array. */
function addIndexTo(schemaPath: string, table: string, index: string): void {
  const schema = readFileSync(schemaPath, "utf8");
  const start = new RegExp(`sqliteTable\\(\\s*"${table}",`).exec(schema)?.index;
  if (start === undefined) throw new Error(`no table ${table} in the schema`);
  const open = schema.indexOf("(t) => [", start);
  if (open === -1) throw new Error(`table ${table} has no index list to add to`);
  const at = open + "(t) => [".length;
  writeFileSync(schemaPath, `${schema.slice(0, at)}\n    ${index},${schema.slice(at)}`);
}

const sleepPastTheSecond = () => Bun.sleepSync(1_100);

beforeAll(() => {
  generateTmp = mkdtempSync(join(tmpdir(), "migration-flow-generate-"));
});

afterAll(() => {
  const out = join(REPO_ROOT, "e2e-artifacts", "migrations");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "flow.json"), `${JSON.stringify(flow, null, 2)}\n`);
  rmSync(generateTmp, { recursive: true, force: true });
});

describe("db:generate on cire, parallel branches and the merge-queue check", () => {
  let cire: Workspace;
  const schema = () => join(cire.pkg, "src", "schema.ts");
  const migrations = () => join(cire.pkg, "migrations");

  /** A branch off `main` that changes the schema and generates its migration. */
  const branch = (name: string, change: () => void): string => {
    cire.git("checkout", "-q", "-b", name, "main");
    change();
    const made = cire.generate(name);
    expect(made.exitCode).toBe(0);
    const files = cire.commit(name);
    expect(files).toHaveLength(1);
    cire.git("checkout", "-q", "main");
    return files[0]!;
  };

  beforeAll(() => {
    cire = workspace(
      CIRE_DB,
      ["src", "migrations"],
      'export default { dialect: "sqlite", schema: "./src/schema.ts", out: "./migrations" };\n',
    );
  });

  afterAll(() => {
    rmSync(cire.repo, { recursive: true, force: true });
  });

  test(
    "a branch generated first and merged last applies in both orders, and leaves nothing to generate",
    () => {
      const earlier = branch("flow_wedding_note", () =>
        addToTable(schema(), "weddings", 'flowNote: text("flow_note"),'),
      );
      sleepPastTheSecond();
      const later = branch("flow_family_note", () =>
        addToTable(schema(), "families", 'flowNote: text("flow_note"),'),
      );

      // The later file merges first; the earlier one, merged last, is the one
      // the dev tier applies after everything else but a build from zero
      // applies before `later`.
      cire.git("merge", "-q", "--no-edit", "flow_family_note");
      cire.git("merge", "-q", "--no-edit", "flow_wedding_note");
      expect(earlier < later).toBe(true);
      expect(checkOrders(migrations(), [earlier])).toEqual({ ok: true });

      const before = readdirSync(migrations());
      const settled = cire.generate("settled");
      expect(settled.exitCode).toBe(1);
      expect(settled.output).toContain("no schema change");
      expect(readdirSync(migrations())).toEqual(before);
      flow.parallel = { files: [earlier, later].map(stable), ok: true };
    },
    SLOW,
  );

  test(
    "two branches whose indexes share a name fail the check, though each table is its own",
    () => {
      sleepPastTheSecond();
      const guests = branch("flow_idx_guests", () =>
        addIndexTo(schema(), "guests", 'index("flow_shared_idx").on(t.familyId)'),
      );
      sleepPastTheSecond();
      const families = branch("flow_idx_families", () =>
        addIndexTo(schema(), "families", 'index("flow_shared_idx").on(t.weddingId)'),
      );
      cire.git("merge", "-q", "--no-edit", "flow_idx_guests");
      cire.git("merge", "-q", "--no-edit", "flow_idx_families");
      const verdict = checkOrders(migrations(), [families]);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toContain("flow_shared_idx");
      flow.indexNameClash = {
        files: [guests, families].map(stable),
        reason: !verdict.ok && stable(verdict.reason),
      };
      cire.git("reset", "-q", "--hard", "HEAD~2");
    },
    SLOW,
  );

  test(
    "two branches that add the same column fail the check, naming the file that cannot apply",
    () => {
      sleepPastTheSecond();
      const asText = branch("flow_dup_text", () =>
        addToTable(schema(), "weddings", 'flowDup: text("flow_dup"),'),
      );
      sleepPastTheSecond();
      const asNumber = branch("flow_dup_number", () =>
        addToTable(schema(), "weddings", 'flowDup: integer("flow_dup"),'),
      );
      // Their schema edits collide in git; the queue would meet the migrations
      // only if the schema were resolved, so take the two files alone.
      cire.git("checkout", "-q", "flow_dup_text", "--", `cire/db/migrations/${asText}`);
      cire.git("checkout", "-q", "flow_dup_number", "--", `cire/db/migrations/${asNumber}`);
      const verdict = checkOrders(migrations(), [asNumber]);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toContain("duplicate column name: flow_dup");
      flow.sameColumnClash = { reason: !verdict.ok && stable(verdict.reason) };
      cire.git("reset", "-q", "--hard", "HEAD");
    },
    SLOW,
  );

  test(
    "a possible rename is never guessed: without a terminal it exits 2, and --hints settles it",
    () => {
      const current = readFileSync(schema(), "utf8");
      writeFileSync(
        schema(),
        current.replace('flowNote: text("flow_note"),', 'flowRemark: text("flow_remark"),'),
      );
      const before = readdirSync(migrations());
      const asked = cire.generate("flow_rename");
      expect(asked.exitCode).toBe(2);
      expect(asked.output).toContain("--hints");
      expect(readdirSync(migrations())).toEqual(before);

      const hints = JSON.stringify([
        {
          type: "rename",
          kind: "column",
          from: ["public", "weddings", "flow_note"],
          to: ["public", "weddings", "flow_remark"],
        },
      ]);
      const settled = cire.generate("flow_rename", ["--hints", hints]);
      expect(settled.exitCode).toBe(0);
      const file = settled.output.trim().split("\n").at(-1)!;
      expect(readFileSync(join(cire.repo, file), "utf8")).toContain(
        "RENAME COLUMN `flow_note` TO `flow_remark`",
      );
      flow.rename = { withoutHints: asked.exitCode, withHints: settled.exitCode };
      cire.git("checkout", "-q", "--", ".");
      cire.git("clean", "-qfd");
    },
    SLOW,
  );

  test(
    "a second migration on one branch starts from the commit holding the first",
    () => {
      cire.git("checkout", "-q", "-b", "flow_two_steps", "main");
      sleepPastTheSecond();
      addToTable(schema(), "weddings", 'flowStepOne: text("flow_step_one"),');
      expect(cire.generate("flow_step_one").exitCode).toBe(0);
      cire.commit("step one");
      sleepPastTheSecond();
      addToTable(schema(), "weddings", 'flowStepTwo: text("flow_step_two"),');
      const two = cire.generate("flow_step_two");
      expect(two.exitCode).toBe(0);
      const file = two.output.trim().split("\n").at(-1)!;
      expect(readFileSync(join(cire.repo, file), "utf8")).toBe(
        "ALTER TABLE `weddings` ADD `flow_step_two` text;",
      );
      flow.twoSteps = { second: stable(file) };
      cire.commit("step two");
    },
    SLOW,
  );

  test(
    "a schema change committed before generating is found with --from, and refused without it",
    () => {
      sleepPastTheSecond();
      addToTable(schema(), "families", 'flowCommitted: text("flow_committed"),');
      cire.commit("schema first, migration forgotten");
      const plain = cire.generate("flow_committed");
      expect(plain.exitCode).toBe(1);
      expect(plain.output).toContain("--from");
      const fromBefore = cire.generate("flow_committed", ["--from", "HEAD~1"]);
      expect(fromBefore.exitCode).toBe(0);
      const file = fromBefore.output.trim().split("\n").at(-1)!;
      expect(readFileSync(join(cire.repo, file), "utf8")).toBe(
        "ALTER TABLE `families` ADD `flow_committed` text;",
      );
      flow.from = { withoutFrom: plain.exitCode, withFrom: fromBefore.exitCode };
    },
    SLOW,
  );

  test(
    "an uncommitted migration in the directory stops the next one",
    () => {
      sleepPastTheSecond();
      addToTable(schema(), "guests", 'flowStepThree: text("flow_step_three"),');
      const refused = cire.generate("flow_step_three");
      expect(refused.exitCode).toBe(1);
      expect(refused.output).toContain("commit the migration already in");
      flow.uncommitted = { exitCode: refused.exitCode };
      cire.git("checkout", "-q", "-f", "main");
      cire.git("clean", "-qfd");
    },
    SLOW,
  );
});

describe("db:generate on osn's layout: drizzle/ and a schema split across files", () => {
  test(
    "writes one ALTER into drizzle/ for a new column, and refuses when nothing changed",
    () => {
      const osnDb = join(REPO_ROOT, "osn", "db");
      const osn = workspace(
        osnDb,
        ["src", "drizzle"],
        'export default { dialect: "sqlite", schema: "./src/schema/index.ts", out: "./drizzle" };\n',
      );
      try {
        const unchanged = osn.generate("nothing");
        expect(unchanged.exitCode).toBe(1);
        expect(unchanged.output).toContain("no schema change");

        addToTable(
          join(osn.pkg, "src", "schema", "index.ts"),
          "accounts",
          'flowProbe: text("flow_probe"),',
        );
        const made = osn.generate("flow_probe");
        expect(made.exitCode).toBe(0);
        const file = made.output.trim().split("\n").at(-1)!;
        expect(file).toMatch(/^osn\/db\/drizzle\/\d{14}_flow_probe\.sql$/);
        expect(readFileSync(join(osn.repo, file), "utf8")).toBe(
          "ALTER TABLE `accounts` ADD `flow_probe` text;",
        );
        flow.osnLayout = { file: stable(file) };
      } finally {
        rmSync(osn.repo, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
