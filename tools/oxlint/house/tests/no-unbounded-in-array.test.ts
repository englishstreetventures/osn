import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(dirname(packageDirectory)));
const pluginEntry = join(packageDirectory, "index.ts");

/** One oxlint diagnostic, cut down to the fields these tests assert on. */
type Diagnostic = {
  message: string;
  code: string;
  severity: string;
  filename: string;
  labels: { span: { line: number } }[];
};

/** Declarations every fixture shares, so each one only has to parse. */
const preamble = `
declare const db: any;
declare const users: any;
declare const guests: any;
declare const rsvps: any;
declare const events: any;
declare const ids: string[];
declare const flag: boolean;
`;

/**
 * Fixtures, keyed by file name. The rule is syntactic plus same-file scope
 * lookup, so a fixture only has to parse — nothing here is type-checked or
 * executed.
 */
const fixtures = {
  // The four shapes the rule exists for.
  "variable.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = (familyIds: string[]) => inArray(guests.familyId, familyIds);
`,
  "json-each.ts": `import { inArray } from "drizzle-orm";
import { jsonEachIn } from "@shared/db-utils";${preamble}
export const q = (familyIds: string[]) => inArray(guests.familyId, jsonEachIn(familyIds));
`,
  "subquery.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(rsvps.guestId, db.select({ id: guests.id }).from(guests));
`,
  "literal.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(events.status, ["a", "b"]);
`,

  // Reported: a list whose length the source does not fix.
  "member.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = (body: { profileIds: string[] }) => inArray(users.id, body.profileIds);
`,
  "call-result.ts": `import { inArray } from "drizzle-orm";${preamble}
declare function getIds(): string[];
export const q = inArray(users.id, getIds());
`,
  "spread-variable.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(users.id, [...ids]);
`,
  "spread-map-keys.ts": `import { inArray } from "drizzle-orm";${preamble}
declare const matches: Map<string, number>;
export const q = inArray(users.id, [...matches.keys()]);
`,
  "not-in-array.ts": `import { notInArray } from "drizzle-orm";${preamble}
export const q = notInArray(users.id, ids);
`,
  "aliased.ts": `import { inArray as within } from "drizzle-orm";${preamble}
export const q = within(users.id, ids);
`,
  "subpath.ts": `import { inArray } from "drizzle-orm/sql";${preamble}
export const q = inArray(users.id, ids);
`,
  "pushed-const.ts": `import { inArray } from "drizzle-orm";${preamble}
const found: string[] = [];
found.push("a");
export const q = inArray(users.id, found);
`,
  "let-literal.ts": `import { inArray } from "drizzle-orm";${preamble}
let chosen = ["a"];
chosen = ids;
export const q = inArray(users.id, chosen);
`,
  "spread-plain-const.ts": `import { inArray } from "drizzle-orm";${preamble}
const BASE = ["a", "b"];
export const q = inArray(users.id, [...BASE]);
`,
  "sql-join.ts": `import { inArray, sql } from "drizzle-orm";${preamble}
export const q = inArray(users.id, sql\`(\${sql.join(ids.map((id) => sql\`\${id}\`), sql\`, \`)})\`);
`,
  "conditional-mixed.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(users.id, flag ? ids : ["a"]);
`,
  "helper-returns-parameter.ts": `import { inArray } from "drizzle-orm";${preamble}
const pick = (list: string[]) => list;
export const q = inArray(users.id, pick(ids));
`,
  "multi-line.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(
  users.id,
  ids,
);
`,

  // Not reported: the bind count is fixed by the source, or is one parameter.
  "literal-as-const.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(events.status, ["upcoming", "ongoing"] as const);
`,
  "const-tuple.ts": `import { inArray } from "drizzle-orm";${preamble}
const STATUSES = ["a", "b"] as const;
export const q = inArray(events.status, STATUSES);
`,
  "const-tuple-spread.ts": `import { notInArray } from "drizzle-orm";${preamble}
const PAID = ["gold", "crimson"] as const satisfies readonly string[];
export const q = notInArray(events.tier, [...PAID]);
`,
  "const-json-each.ts": `import { inArray } from "drizzle-orm";
import { jsonEachIn } from "@shared/db-utils";${preamble}
const idsJson = jsonEachIn(ids);
export const q = inArray(users.id, idsJson);
`,
  "const-subquery.ts": `import { inArray } from "drizzle-orm";${preamble}
const seed = db.select({ id: users.id }).from(users).limit(5);
export const q = inArray(users.id, seed);
`,
  "select-distinct.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(users.id, db.selectDistinct({ id: users.id }).from(users));
`,
  "conditional-literals.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = inArray(events.status, flag ? ["a"] : ["b", "c"]);
`,
  "sql-template.ts": `import { inArray, sql } from "drizzle-orm";${preamble}
declare const owner: string;
export const q = inArray(users.id, sql\`(SELECT id FROM t WHERE owner = \${owner})\`);
`,
  "local-helper.ts": `import { eq, inArray } from "drizzle-orm";${preamble}
const spentId = (id: string) => db.select({ id: rsvps.id }).from(rsvps).where(eq(rsvps.id, id));
export const q = (id: string) => inArray(rsvps.id, spentId(id));
`,
  "not-drizzle.ts": `${preamble}
function inArray(column: unknown, list: unknown): unknown[] {
	return [column, list];
}
export const q = inArray(users.id, ids);
`,
  "other-module.ts": `import { inArray } from "./helpers";${preamble}
export const q = inArray(users.id, ids);
`,
  "shadowed.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = (inArray: (a: unknown, b: unknown) => void) => inArray(users.id, ids);
`,
  "suppressed.ts": `import { inArray } from "drizzle-orm";${preamble}
export const q = (from: string[]) =>
  // oxlint-disable-next-line house/no-unbounded-in-array -- at most two tiers
  inArray(users.tier, from);
`,
} as const;

let fixtureDirectory: string;

/** Run oxlint over `target` with the given config, from `cwd`. */
function lint(configPath: string, cwd: string, target: string): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: ["bunx", "--bun", "oxlint", "-c", configPath, "--format=json", target],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
  return parsed.diagnostics ?? [];
}

/** The diagnostic for the fixture file called exactly `name`. */
function forFile(diagnostics: Diagnostic[], name: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.filename.split("/").at(-1) === name);
}

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

describe("house/no-unbounded-in-array", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-unbounded-in-array-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-unbounded-in-array": "error" },
        jsPlugins: [{ name: "house", specifier: pluginEntry }],
      }),
    );
    for (const [name, source] of Object.entries(fixtures)) {
      writeFileSync(join(fixtureDirectory, name), source);
    }
    diagnostics = lint(join(fixtureDirectory, "oxlintrc.json"), fixtureDirectory, ".");
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("reports every list whose length the source does not fix, and nothing else", () => {
    expect(reportedFiles(diagnostics)).toEqual([
      "aliased.ts",
      "call-result.ts",
      "conditional-mixed.ts",
      "helper-returns-parameter.ts",
      "let-literal.ts",
      "member.ts",
      "multi-line.ts",
      "not-in-array.ts",
      "pushed-const.ts",
      "spread-map-keys.ts",
      "spread-plain-const.ts",
      "spread-variable.ts",
      "sql-join.ts",
      "subpath.ts",
      "variable.ts",
    ]);
  });

  it("reports once per call", () => {
    expect(diagnostics).toHaveLength(15);
  });

  it("names the function and the list, and points at jsonEachIn", () => {
    const message = forFile(diagnostics, "variable.ts")?.message;
    expect(message).toContain("`inArray`");
    expect(message).toContain("`familyIds`");
    expect(message).toContain("jsonEachIn(familyIds)");
    const notIn = forFile(diagnostics, "not-in-array.ts")?.message;
    expect(notIn).toContain("`notInArray`");
  });

  it("reports on the list argument, so a directive goes on the line above the list", () => {
    const hit = forFile(diagnostics, "multi-line.ts");
    const listLine = fixtures["multi-line.ts"].split("\n").findIndex((l) => l.trim() === "ids,");
    expect(hit?.labels[0]?.span.line).toBe(listLine + 1);
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-unbounded-in-array)")).toBe(true);
  });
});

// The rule is only worth anything where the root config turns it on. These run
// oxlint with the repository's own oxlintrc.json, the way `bun run lint` does.
// Each starts oxlint with the full root config and its JS plugins, so they carry
// a 30 s budget and a slow CI runner cannot read as a failing rule.
describe("house/no-unbounded-in-array, as the repository configures it", () => {
  const rootConfig = join(repoRoot, "oxlintrc.json");
  const probe = join(packageDirectory, "tests", "__unbounded-in-array-probe.ts");

  beforeAll(() => {
    writeFileSync(
      probe,
      `import { inArray } from "drizzle-orm";\ndeclare const users: { id: unknown };\nexport const probe = (ids: string[]) => inArray(users.id, ids);\n`,
    );
  });

  afterAll(() => {
    rmSync(probe, { force: true });
  });

  const ruleHits = (diagnostics: Diagnostic[]) =>
    diagnostics.filter((d) => d.code === "house(no-unbounded-in-array)");

  it("reports a variable list as an error", () => {
    const hits = ruleHits(
      lint(rootConfig, repoRoot, "tools/oxlint/house/tests/__unbounded-in-array-probe.ts"),
    );
    expect(hits.map((d) => d.severity)).toEqual(["error"]);
  }, 30_000);

  it("finds nothing in the committed API sources", () => {
    const hits = ["osn/api/src", "pulse/api/src", "zap/api/src", "cire/api/src"].flatMap((dir) =>
      ruleHits(lint(rootConfig, repoRoot, dir)),
    );
    expect(hits.map((d) => d.filename)).toEqual([]);
  }, 60_000);
});
