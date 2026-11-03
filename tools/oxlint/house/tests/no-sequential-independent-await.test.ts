import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginEntry = join(packageDirectory, "index.ts");

type Diagnostic = { message: string; code: string; filename: string };

/** Fixtures only have to parse; nothing here is type-checked or executed. */
const fixtures = {
  "two-reads.ts": `
export async function load(id: string) {
	const user = await getUser(id);
	const prefs = await listPrefs(id);
	return { user, prefs };
}
`,
  "bare-reads.ts": `
export async function warm(id: string) {
	await loadA(id);
	await loadB(id);
}
`,
  "effect-reads.ts": `
export const load = Effect.gen(function* () {
	const a = yield* getA();
	const b = yield* getB();
	return [a, b];
});
`,
  "dependent.ts": `
export async function load(id: string) {
	const user = await getUser(id);
	const prefs = await listPrefs(user.id);
	return { user, prefs };
}
`,
  "dependent-in-closure.ts": `
export async function load(id: string) {
	const user = await getUser(id);
	const prefs = await listPrefs(id, () => user.id);
	return { user, prefs };
}
`,
  "write-second.ts": `
export async function save(id: string) {
	const user = await getUser(id);
	await updateUser(id);
	return user;
}
`,
  "gate-first.ts": `
export async function save(id: string) {
	await verifyToken(id);
	const user = await getUser(id);
	return user;
}
`,
  "separated.ts": `
export async function load(id: string) {
	const a = await getA(id);
	log(a);
	const b = await getB(id);
	return b;
}
`,
  "already-parallel.ts": `
export async function load(id: string) {
	const [a, b] = await Promise.all([getA(id), getB(id)]);
	return [a, b];
}
`,
  "suppressed.ts": `
export async function load(id: string) {
	const user = await getUser(id);
	// oxlint-disable-next-line house/no-sequential-independent-await -- the session read must settle first: a miss there ends the request
	const prefs = await listPrefs(id);
	return { user, prefs };
}
`,
} as const;

let fixtureDirectory: string;

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

describe("house/no-sequential-independent-await", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-sequential-await-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-sequential-independent-await": "error" },
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

  it("reports adjacent reads that share no data", () => {
    const files = [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))];
    expect(files.toSorted()).toEqual(["bare-reads.ts", "effect-reads.ts", "two-reads.ts"]);
  });

  it("names the parallel forms", () => {
    expect(diagnostics[0]?.message).toContain("Promise.all");
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-sequential-independent-await)")).toBe(
      true,
    );
  });
});
