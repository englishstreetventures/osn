import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  labels?: { span: { line: number } }[];
};

/**
 * Fixtures, keyed by file name. What counts as a literal is the shared
 * matcher's decision and scripts/tests/check-motion-literals.test.ts tests it
 * case by case; these test what the rule feeds the matcher — which nodes it
 * reads, and in which mode.
 */
const fixtures = {
  // Two literals in one JSX class string: two findings.
  "jsx-class.tsx": `
export const a = <a class="flex transition-all duration-200">x</a>;
`,
  // A class reached through each shape a class string takes in this repo.
  "clsx-argument.tsx": `
export const b = <a class={clsx("px-2", on && "delay-150")}>x</a>;
`,
  "conditional.tsx": `
export const c = <a class={on ? "duration-300" : "opacity-0"}>x</a>;
`,
  "class-list-key.tsx": `
export const d = <a classList={{ "ease-linear": on }}>x</a>;
`,
  "template-quasi.tsx": `
export const e = <a class={\`flex \${extra} duration-500\`}>x</a>;
`,
  // An injected stylesheet. The literal is reported, the reduced-motion block
  // passes, and a marked declaration passes while its unmarked neighbour does
  // not: the marker reaches one declaration.
  "template-css.ts": `
export const STYLE = \`
.panel {
  transition: opacity 200ms ease-in;
}
.panel[data-closing] {
  /* motion-literal: the closing curve the owner chose, which has no token */
  transition: opacity var(--exit, 150ms) ease-in;
  animation-delay: 0.3s;
}
@media (prefers-reduced-motion: reduce) {
  .panel { transition-duration: 1ms; }
}
\`;
`,
  // An interpolated value is never judged; a written one beside it is.
  "interpolated.ts": `
export const f = (d: number) => \`.a{transition:opacity \${d}ms}\`;
export const g = (n: number) => \`[x]{z-index:\${n};transition:opacity .2s ease-out}\`;
`,
  // Solid style objects, in both key spellings.
  "style-object.tsx": `
export const h = <a style={{ transition: "opacity 200ms" }}>x</a>;
export const i = <a style={{ "transition-duration": "0.2s" }}>x</a>;
export const j = { animationDuration: "1s" };
export const j2 = { WebkitTransition: "opacity 200ms" };
`,
  // The same objects with nothing to report.
  "style-object-clean.tsx": `
export const k = <a style={{ transition: "none" }}>x</a>;
export const l = <a style={{ transition: "height var(--dur-base) var(--ease-out)" }}>x</a>;
`,
  // Writing a style from code.
  "style-assignment.ts": `
export function m(el: HTMLElement) {
  el.style.transition = "height 200ms ease";
  el.style.setProperty("transition", "opacity 200ms");
}
`,
  "style-assignment-clean.ts": `
export function n(el: HTMLElement) {
  el.style.transition = "none";
  el.style.transition = "";
  el.style.setProperty("transition-duration", "var(--dur-fast)");
}
`,
  // The house form of a suppression, with its reason.
  "suppressed.tsx": `
// oxlint-disable-next-line house/no-literal-motion -- a choreography longer than the ladder's longest rung
export const o = <a class="duration-700">x</a>;
`,
  // Tailwind's named easing outside cire: its stock curve, so reported.
  "named-easing.tsx": `
export const v = <a class="transition-opacity ease-out">x</a>;
`,
  // NOT a violation. The same class in a cire app reads cire's own token.
  "cire/app/src/cire-easing.tsx": `
export const w = <a class="transition-opacity ease-out ease-in-out">x</a>;
`,
  // NOT a violation. Prose and lone keywords are not class tokens.
  "prose.ts": `
export const p = "Takes 200ms to load";
export const q = ["ease", "linear", "all"];
`,
  // NOT a violation. cire's token forms, as written in @cire/ui.
  "cire/ui/src/cire-forms.ts": `
export const r = "base:duration-(--dur-fast,100ms) base:ease-out";
export const s = { out: "var(--dur-base,var(--ui-dur-base,200ms)) var(--ease-out,var(--ui-ease-out,cubic-bezier(0.22,1,0.36,1)))" };
export const t = "base:animate-[pulse_calc(2s*var(--motion-scale,1))_var(--ease-in-out,var(--ui-ease-in-out))_infinite]";
export const u = "base:motion-safe:data-[expanded]:[animation:ui-enter_var(--dur-fast,var(--ui-dur-fast))_var(--ease-out,var(--ui-ease-out))_both]";
`,
} as const;

let fixtureDirectory: string;

/** Run oxlint over the fixture directory with only this rule enabled. */
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
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
  return parsed.diagnostics ?? [];
}

/** The diagnostics in one fixture file. */
function inFile(diagnostics: Diagnostic[], name: string): Diagnostic[] {
  const base = name.split("/").at(-1);
  return diagnostics.filter((d) => d.filename.split("/").at(-1) === base);
}

/** Run oxlint with `configPath` from `cwd` over `targets`. */
function lint(configPath: string, cwd: string, targets: readonly string[]): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: ["bunx", "--bun", "oxlint", "-c", configPath, "--format=json", ...targets],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
  return parsed.diagnostics ?? [];
}

describe("house/no-literal-motion", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-literal-motion-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-literal-motion": "error" },
        jsPlugins: [{ name: "house", specifier: pluginEntry }],
      }),
    );
    for (const [name, source] of Object.entries(fixtures)) {
      mkdirSync(dirname(join(fixtureDirectory, name)), { recursive: true });
      writeFileSync(join(fixtureDirectory, name), source);
    }
    diagnostics = lintFixtures();
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("reports each literal class in a JSX class string", () => {
    const found = inFile(diagnostics, "jsx-class.tsx");
    expect(found).toHaveLength(2);
    expect(found.every((d) => d.severity === "error")).toBe(true);
    expect(found.map((d) => d.message).join("\n")).toContain("`transition-all`");
    expect(found.map((d) => d.message).join("\n")).toContain("`duration-200`");
  });

  it("reads a class in every shape a class string takes", () => {
    for (const name of [
      "clsx-argument.tsx",
      "conditional.tsx",
      "class-list-key.tsx",
      "template-quasi.tsx",
    ]) {
      expect([name, inFile(diagnostics, name).length]).toEqual([name, 1]);
    }
  });

  it("reads a template literal as CSS, one finding per declaration, honouring the marker and reduced motion", () => {
    const found = inFile(diagnostics, "template-css.ts");
    expect(found).toHaveLength(2);
    const text = found.map((d) => d.message).join("\n");
    expect(text).toContain("200ms");
    expect(text).toContain("0.3s");
    expect(text).not.toContain("1ms");
  });

  it("never judges an interpolated value, and reports a written one beside it", () => {
    const found = inFile(diagnostics, "interpolated.ts");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(".2s");
    expect(found[0]?.message).toContain("ease-out");
  });

  it("reads a style object's motion properties in every spelling", () => {
    expect(inFile(diagnostics, "style-object.tsx")).toHaveLength(4);
    expect(inFile(diagnostics, "style-object-clean.tsx")).toHaveLength(0);
  });

  it("reads a style written from code", () => {
    expect(inFile(diagnostics, "style-assignment.ts")).toHaveLength(2);
    expect(inFile(diagnostics, "style-assignment-clean.ts")).toHaveLength(0);
  });

  it("is silenced by the house suppression on the line before", () => {
    expect(inFile(diagnostics, "suppressed.tsx")).toHaveLength(0);
  });

  it("leaves prose and lone keywords alone", () => {
    expect(inFile(diagnostics, "prose.ts")).toHaveLength(0);
  });

  it("passes cire's token forms", () => {
    expect(inFile(diagnostics, "cire/ui/src/cire-forms.ts")).toHaveLength(0);
  });

  it("judges a Tailwind named easing by the app the file is in", () => {
    expect(inFile(diagnostics, "named-easing.tsx")).toHaveLength(1);
    expect(inFile(diagnostics, "cire/app/src/cire-easing.tsx")).toHaveLength(0);
  });

  it("names the way out in its message", () => {
    const message = inFile(diagnostics, "jsx-class.tsx")[0]?.message ?? "";
    expect(message).toContain("motion-literal:");
    expect(message).toContain("design-tokens.md");
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.code === "house(no-literal-motion)")).toBe(true);
  });
});

// The rule is only worth anything where the root config turns it on: a
// mistyped glob, a dropped product or a drop to "warn" would leave every test
// above green, because a rule that runs nowhere reports nothing. These run
// oxlint with the repository's own oxlintrc.json, as `bun run lint` does.
// Each starts oxlint with the full root config and its JS plugins, and the
// last lints three whole source trees, so they carry a 60 s budget.
describe("house/no-literal-motion, as the repository configures it", () => {
  const rootConfig = join(repoRoot, "oxlintrc.json");
  const PROBE = "__literal-motion-probe.ts";
  const inSource = join(repoRoot, "pulse/web/src", PROBE);
  const inTests = join(repoRoot, "pulse/web/tests", PROBE);

  beforeAll(() => {
    for (const path of [inSource, inTests]) {
      writeFileSync(path, `export const probe = "duration-200";\n`);
    }
  });

  afterAll(() => {
    for (const path of [inSource, inTests]) rmSync(path, { force: true });
  });

  const ruleHits = (diagnostics: Diagnostic[]) =>
    diagnostics.filter((d) => d.code === "house(no-literal-motion)");

  it("reports a literal in a product's src/ as an error", () => {
    const hits = ruleHits(lint(rootConfig, repoRoot, [`pulse/web/src/${PROBE}`]));
    expect(hits.map((d) => d.severity)).toEqual(["error"]);
  }, 60_000);

  it("leaves the same literal alone in the product's tests/", () => {
    expect(ruleHits(lint(rootConfig, repoRoot, [`pulse/web/tests/${PROBE}`]))).toEqual([]);
  }, 60_000);

  it("finds nothing in the committed source it covers", () => {
    const hits = ruleHits(
      lint(rootConfig, repoRoot, ["pulse/web/src", "shared/ui/src", "cire/invites/src"]),
    ).filter((d) => !d.filename.endsWith(PROBE));
    expect(hits).toEqual([]);
  }, 60_000);
});
