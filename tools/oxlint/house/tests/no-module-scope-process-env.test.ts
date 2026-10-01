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
  filename: string;
};

/**
 * Fixtures, keyed by file name. The rule is purely syntactic, so a fixture only
 * has to parse — nothing here is type-checked or executed.
 */
const fixtures = {
  "top-level-const.ts": `
export const ttl = Number(process.env.TTL ?? "24");
`,
  "computed-key.ts": `
export const ttl = process["env"].TTL;
`,
  "object-literal.ts": `
export const config = { issuer: process.env.ISSUER ?? "http://localhost:4000" };
`,
  "destructured.ts": `
const { env } = process;
export const ttl = env.TTL;
`,
  "static-field.ts": `
export class Config {
	static issuer = process.env.ISSUER;
}
`,
  "static-block.ts": `
export class Config {
	static issuer: string | undefined;
	static {
		Config.issuer = process.env.ISSUER;
	}
}
`,
  "in-function.ts": `
export function ttl(): number {
	return Number(process.env.TTL ?? "24");
}
`,
  "in-arrow.ts": `
export const ttl = () => Number(process.env.TTL ?? "24");
`,
  "default-parameter.ts": `
export function ttl(hours = process.env.TTL): string | undefined {
	return hours;
}
`,
  "instance-field.ts": `
export class Config {
	issuer = process.env.ISSUER;
}
`,
  "method.ts": `
export class Config {
	issuer(): string | undefined {
		return process.env.ISSUER;
	}
}
`,
  "global-this.ts": `
export const ttl = globalThis.process.env.TTL;
`,
  "optional-chain.ts": `
export const ttl = process?.env?.TTL;
`,
  "renamed-destructure.ts": `
const { env: e } = process;
export const ttl = e.TTL;
`,
  "static-arrow.ts": `
export class Config {
	static issuer = () => process.env.ISSUER;
}
`,
  "iife.ts": `
export const ttl = (() => process.env.TTL)();
`,
  "other-object.ts": `
const settings = { env: { TTL: "1" } };
export const ttl = settings.env.TTL;
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

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

describe("house/no-module-scope-process-env", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-process-env-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-module-scope-process-env": "error" },
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

  it("reports every read that runs while the module loads", () => {
    // `iife.ts` is absent on purpose: an immediately invoked function runs at
    // load, but the rule stops at the first function it meets.
    expect(reportedFiles(diagnostics)).toEqual([
      "computed-key.ts",
      "destructured.ts",
      "global-this.ts",
      "object-literal.ts",
      "optional-chain.ts",
      "renamed-destructure.ts",
      "static-block.ts",
      "static-field.ts",
      "top-level-const.ts",
    ]);
  });

  it("points at the handler's env binding", () => {
    const message = diagnostics.find((d) => d.filename.endsWith("top-level-const.ts"))?.message;
    expect(message).toContain("`env` binding");
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-module-scope-process-env)")).toBe(true);
  });
});

// The rule is only worth anything where the root config turns it on. These
// run oxlint with the repository's own oxlintrc.json, the way `bun run lint`
// does, against files inside the scoped tree.
describe("house/no-module-scope-process-env, as the repository configures it", () => {
  const rootConfig = join(repoRoot, "oxlintrc.json");
  const workerDirectory = join(repoRoot, "cire/api/src/lib");
  let planted: string;

  beforeAll(() => {
    planted = join(workerDirectory, "__house-process-env-probe.ts");
    writeFileSync(planted, `export const probe = process.env.PROBE;\n`);
  });

  afterAll(() => {
    rmSync(planted, { force: true });
  });

  const ruleHits = (diagnostics: Diagnostic[]) =>
    diagnostics.filter((d) => d.code === "house(no-module-scope-process-env)");

  it("reports a module-scope read in the cire Worker source", () => {
    expect(
      ruleHits(lint(rootConfig, repoRoot, "cire/api/src/lib/__house-process-env-probe.ts")),
    ).toHaveLength(1);
  });

  it("leaves the Bun-only local entry alone", () => {
    expect(ruleHits(lint(rootConfig, repoRoot, "cire/api/src/local.ts"))).toHaveLength(0);
  });

  it("finds nothing in the committed cire Worker source", () => {
    const hits = ruleHits(lint(rootConfig, repoRoot, "cire/api/src")).filter(
      (d) => !d.filename.endsWith("__house-process-env-probe.ts"),
    );
    expect(hits).toEqual([]);
  });
});
