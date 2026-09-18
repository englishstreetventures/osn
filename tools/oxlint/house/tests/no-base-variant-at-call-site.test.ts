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
 * Fixtures, keyed by file name. Each is the smallest thing that distinguishes
 * one decision the rule makes.
 */
const fixtures = {
  // The defect, in the shape that cost nine call sites: a `base:` utility
  // handed to a component whose own defaults are also `base:`.
  "component-class.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const a = <Modal class="base:max-w-lg base:bg-bg">x</Modal>;
`,
  // The same on a member-expression component.
  "member-component.tsx": `
import { Dialog } from "@shared/ui/ui/dialog";
export const b = <Dialog.Panel class="base:p-0">x</Dialog.Panel>;
`,
  // `className`, for a codebase that has both spellings.
  "class-name.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const c = <Modal className="base:rounded-none">x</Modal>;
`,
  // A responsive variant in front of it is still the same tie, and the message
  // has to quote what was actually written.
  "variant-prefixed.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const d = <Modal class="md:base:max-h-none">x</Modal>;
`,
  // Classes reached through a helper. `clsx` and a conditional are how half the
  // call sites in this repo build a class string.
  "through-clsx.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const e = <Modal class={clsx("base:w-full", on && "base:p-6")}>x</Modal>;
`,
  // `classList` puts the class in the object KEY, not the value.
  "class-list.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const f = <Modal classList={{ "base:hidden": closed }}>x</Modal>;
`,
  // A template's static chunks count; the interpolation is
  // `require-static-classes`' problem, not this rule's.
  "template-literal.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const g = <Modal class={\`base:gap-4 \${extra}\`}>x</Modal>;
`,
  // NOT a violation. A component styling its own markup is the entire point of
  // the variant, and a lower-case tag is an element rather than a call site.
  "own-element.tsx": `
export const h = <div class="base:max-w-lg base:bg-bg">x</div>;
`,
  // NOT a violation. The correct form at a call site.
  "plain-utility.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const i = <Modal class="max-w-lg bg-bg">x</Modal>;
`,
  // NOT a violation. A class that merely contains the letters `base`.
  "base-substring.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const j = <Modal class="bg-base-ground database-row">x</Modal>;
`,
  // NOT a violation. Some other prop carrying a string.
  "other-prop.tsx": `
import { Modal } from "@shared/ui/ui/modal";
export const k = <Modal label="base:max-w-lg">x</Modal>;
`,
  // NOT a violation, and the half of the rule that keeps it usable. A wrapper
  // passing `base:` down to a third-party component is not a tie: Kobalte sets
  // no `base:` defaults, so this IS the zero-specificity default its own
  // consumer will override. Without this exemption the rule reports 199 sites
  // across the shared layers and says nothing true about any of them.
  "third-party-target.tsx": `
import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
export const l = <KobalteDialog.Overlay class="base:fixed base:inset-0">x</KobalteDialog.Overlay>;
`,
  // A relative import is ours by construction — `@shared/ui`'s own \`UsernameInput\`
  // passes \`base:flex-1\` to its sibling \`Input\`, which has \`base:\` defaults.
  "relative-import.tsx": `
import { Input } from "./input";
export const m = <Input class="base:flex-1" />;
`,
  // A component with no import at all cannot be resolved, so it is left alone
  // rather than guessed at.
  "unresolved.tsx": `
export const n = <Whatever class="base:p-4">x</Whatever>;
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
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
  return parsed.diagnostics ?? [];
}

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

describe("house/no-base-variant-at-call-site", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-base-variant-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-base-variant-at-call-site": "error" },
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

  it("reports a `base:` class on a component, in every shape a class is written", () => {
    expect(reportedFiles(diagnostics)).toEqual([
      "class-list.tsx",
      "class-name.tsx",
      "component-class.tsx",
      "member-component.tsx",
      "relative-import.tsx",
      "template-literal.tsx",
      "through-clsx.tsx",
      "variant-prefixed.tsx",
    ]);
  });

  it("leaves a component's own markup alone, which is what `base:` is for", () => {
    // The rule that stops this from being unusable. Every `base:` in
    // `@shared/ui` and `@cire/ui` is on a plain element and must stay silent.
    expect(diagnostics.filter((d) => d.filename.endsWith("own-element.tsx"))).toHaveLength(0);
  });

  it("says nothing about the correct form", () => {
    expect(diagnostics.filter((d) => d.filename.endsWith("plain-utility.tsx"))).toHaveLength(0);
  });

  it("matches the variant, not the letters", () => {
    // `bg-base-ground` and `database-row` both contain `base` and neither is
    // the variant. A substring match here would fire on real class names.
    expect(diagnostics.filter((d) => d.filename.endsWith("base-substring.tsx"))).toHaveLength(0);
  });

  it("only looks at class attributes", () => {
    expect(diagnostics.filter((d) => d.filename.endsWith("other-prop.tsx"))).toHaveLength(0);
  });

  it("leaves a third-party target alone, because there is no tie to have", () => {
    expect(diagnostics.filter((d) => d.filename.endsWith("third-party-target.tsx"))).toHaveLength(
      0,
    );
  });

  it("says nothing about a component it cannot resolve", () => {
    expect(diagnostics.filter((d) => d.filename.endsWith("unresolved.tsx"))).toHaveLength(0);
  });

  it("reports once per offending utility, so a pair is two findings", () => {
    expect(diagnostics.filter((d) => d.filename.endsWith("component-class.tsx"))).toHaveLength(2);
  });

  it("quotes the utility as written, variants and all", () => {
    const message = diagnostics.find((d) => d.filename.endsWith("variant-prefixed.tsx"))?.message;
    expect(message).toContain("`md:base:max-h-none`");
  });

  it("names the component, so the message says where to look", () => {
    expect(diagnostics.find((d) => d.filename.endsWith("member-component.tsx"))?.message).toContain(
      "<Dialog.Panel>",
    );
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-base-variant-at-call-site)")).toBe(true);
  });
});
