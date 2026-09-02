import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "..", "check-jest-dom-markers.sh");

let root = "";

async function config(pkg: string, body: string) {
  await mkdir(join(root, pkg), { recursive: true });
  await writeFile(join(root, pkg, "vitest.config.ts"), body);
}

function run() {
  return Bun.spawnSync(["bash", GUARD, root], { stdout: "pipe", stderr: "pipe" });
}

const SOLID_SUPPRESSED = `import solid from "vite-plugin-solid";
export default { plugins: [solid()], test: { setupFiles: ["../../shared/test-config/no-jest-dom.ts"] } };
`;

const SOLID_BARE = `import solid from "vite-plugin-solid";
export default { plugins: [solid()], test: { environment: "node" } };
`;

const NO_SOLID = `export default { test: { environment: "node" } };
`;

// `tools/lab/vitest.config.ts` in the real tree: a config that deliberately
// leaves the plugin out and spends a paragraph saying so.
const SOLID_IN_A_COMMENT = `// Deliberately without \`vite-plugin-solid\`, which would inject a jest-dom
// setup file this package has no dependency for.
export default { test: { environment: "node" } };
`;

describe("check-jest-dom-markers", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jest-dom-guard-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes when every Solid config names jest-dom", async () => {
    await config("a", SOLID_SUPPRESSED);
    await config("b", SOLID_SUPPRESSED);
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("2 Solid vitest configs checked");
  });

  it("fails when a Solid config drops the marker", async () => {
    await config("a", SOLID_SUPPRESSED);
    await config("b", SOLID_BARE);
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("b/vitest.config.ts");
  });

  // The guard is about the plugin's injection, and a config without the plugin
  // has none to suppress. Flagging those would make the marker mandatory
  // everywhere, including the API and DB packages that never render a component.
  it("ignores configs that do not load vite-plugin-solid", async () => {
    await config("a", NO_SOLID);
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("0 Solid vitest configs checked");
  });

  // An installed tree carries hundreds of these under node_modules, none of
  // them ours. A guard that walked them would fail on somebody else's config.
  // A config that names the plugin only to explain why it does not use it takes
  // no injection, so demanding a marker of it would be demanding the opposite of
  // what its comment says. Matching the import statement is what separates them.
  it("ignores a config that mentions the plugin only in a comment", async () => {
    await config("a", SOLID_IN_A_COMMENT);
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("0 Solid vitest configs checked");
  });

  it("skips node_modules", async () => {
    await config("node_modules/some-dep", SOLID_BARE);
    const result = run();
    expect(result.exitCode).toBe(0);
  });
});
