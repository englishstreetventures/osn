import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginEntry = join(packageDirectory, "index.ts");

type Diagnostic = { message: string; code: string; filename: string };

const fixtures = {
  "serial.ts": `
export const run = Effect.forEach(items, work, { concurrency: 1 });
`,
  "quoted-key.ts": `
export const run = Effect.all(tasks, { "concurrency": 1 });
`,
  "unbounded.ts": `
export const run = Effect.forEach(items, work, { concurrency: "unbounded" });
`,
  "bounded.ts": `
export const run = Effect.forEach(items, work, { concurrency: 4 });
`,
  "other-key.ts": `
export const options = { retries: 1 };
`,
} as const;

let fixtureDirectory: string;

function lint(configPath: string, cwd: string): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: ["bunx", "--bun", "oxlint", "-c", configPath, "--format=json", "."],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
  return parsed.diagnostics ?? [];
}

describe("house/no-serial-effect-concurrency", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-serial-concurrency-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-serial-effect-concurrency": "error" },
        jsPlugins: [{ name: "house", specifier: pluginEntry }],
      }),
    );
    for (const [name, source] of Object.entries(fixtures)) {
      writeFileSync(join(fixtureDirectory, name), source);
    }
    diagnostics = lint(join(fixtureDirectory, "oxlintrc.json"), fixtureDirectory);
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("reports only concurrency: 1", () => {
    const files = [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))];
    expect(files.toSorted()).toEqual(["quoted-key.ts", "serial.ts"]);
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-serial-effect-concurrency)")).toBe(true);
  });
});
