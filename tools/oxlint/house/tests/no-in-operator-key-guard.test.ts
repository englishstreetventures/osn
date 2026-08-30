import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginEntry = join(packageDirectory, "index.ts");

/** One oxlint diagnostic, cut down to the fields these tests assert on. */
type Diagnostic = {
  message: string;
  code: string;
  filename: string;
};

/**
 * Fixtures, keyed by file name. The rule is purely syntactic, so a fixture only
 * has to parse — nothing here is type-checked or executed.
 */
const fixtures = {
  "literal-keyof.ts": `
const MAP = { a: 1, b: 2 };
export function isKey(value: string): value is keyof typeof MAP {
	return value in MAP;
}
`,
  "aliased-keyof.ts": `
const MAP = { a: 1, b: 2 };
type Key = keyof typeof MAP;
export const isKey = (value: string): value is Key => value in MAP;
`,
  "asserts-key.ts": `
const MAP = { a: 1, b: 2 };
export function assertKey(value: string): asserts value is keyof typeof MAP {
	if (!(value in MAP)) throw new Error("no");
}
`,
  "has-own.ts": `
const MAP = { a: 1, b: 2 };
export function isKey(value: string): value is keyof typeof MAP {
	return Object.hasOwn(MAP, value);
}
`,
  "discriminant.ts": `
type WithFoo = { foo: string };
export function hasFoo(value: object): value is WithFoo {
	return "foo" in value;
}
`,
  "private-brand.ts": `
export class Tagged {
	#brand = true;
	static is(value: object): value is Tagged {
		return #brand in value;
	}
}
`,
  "no-predicate.ts": `
const MAP = { a: 1, b: 2 };
export function lookup(key: string): number | null {
	return key in MAP ? MAP[key as keyof typeof MAP] : null;
}
`,
} as const;

let fixtureDirectory: string;

/** Run oxlint over the fixture directory with only the house rule enabled. */
function lintFixtures(): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: [
      "bunx",
      "--bun",
      "oxlint",
      "-c",
      join(fixtureDirectory, "oxlintrc.json"),
      "--format=json",
      ".",
    ],
    cwd: fixtureDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(stdout);
  return parsed.diagnostics ?? [];
}

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

describe("house/no-in-operator-key-guard", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-key-guard-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-in-operator-key-guard": "error" },
        jsPlugins: [{ name: "house", specifier: pluginEntry }],
      }),
    );
    for (const [name, source] of Object.entries(fixtures)) {
      writeFileSync(join(fixtureDirectory, name), source);
    }
    diagnostics = lintFixtures();
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("reports every guard that decides a type predicate with `in`", () => {
    expect(reportedFiles(diagnostics)).toEqual([
      "aliased-keyof.ts",
      "asserts-key.ts",
      "literal-keyof.ts",
    ]);
  });

  it("names the parameter and points at Object.hasOwn", () => {
    const message = diagnostics.find((d) => d.filename.endsWith("literal-keyof.ts"))?.message;
    expect(message).toContain("`value in …`");
    expect(message).toContain("Object.hasOwn(map, value)");
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-in-operator-key-guard)")).toBe(true);
  });
});
