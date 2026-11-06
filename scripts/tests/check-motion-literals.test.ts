// A motion's timing and curve come from a token chosen by its job, never a
// number written where it is used. The matcher in scripts/lib/motion-literals.ts
// decides what counts as a literal; house/no-literal-motion runs it over
// TypeScript, and scripts/check-motion-literals.ts over the `.css` and `.astro`
// files oxlint never parses. These test the matcher's decisions one by one, then
// the CLI against fixture roots and, last, against this checkout.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkAstro,
  checkClassTokens,
  checkCss,
  motionProperty,
  themeEasingsFor,
} from "../lib/motion-literals";

/** The literals each finding names, in order. */
function literals(findings: ReturnType<typeof checkCss>): string[][] {
  return findings.map((f) => f.literals.slice());
}

describe("CSS declarations", () => {
  test("reports a literal time in a transition or animation shorthand", () => {
    const found = checkCss(`
      .a { transition: opacity 200ms; }
      .b { transition: opacity .2s; }
      .c { transition: transform 0.7s var(--ease-out); }
      .d { animation: pulse-ring 2.4s var(--ease-out) infinite; }
    `);
    expect(literals(found)).toEqual([["200ms"], [".2s"], ["0.7s"], ["2.4s"]]);
  });

  test("reports a literal delay longhand", () => {
    const found = checkCss(`
      .a { transition-delay: 150ms; }
      .b { animation-delay: 0.45s; }
      .c { transition-duration: 1s; animation-duration: 300ms; }
    `);
    expect(literals(found)).toEqual([["150ms"], ["0.45s"], ["1s"], ["300ms"]]);
  });

  test("reports an easing written out, as a keyword or a function", () => {
    const found = checkCss(`
      .a { transition: transform var(--d) ease; }
      .b { transition: transform var(--d) ease-out; }
      .c { animation: spin var(--d) linear infinite; }
      .d { transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1); }
      .e { animation-timing-function: steps(4, end); }
      .f { transition-timing-function: linear(0, 0.5, 1); }
      .g { transition-timing-function: ease-in-out; }
      .h { animation: x var(--d) step-end; }
    `);
    expect(literals(found)).toEqual([
      ["ease"],
      ["ease-out"],
      ["linear"],
      ["cubic-bezier(0.22, 1, 0.36, 1)"],
      ["steps(4, end)"],
      ["linear(0, 0.5, 1)"],
      ["ease-in-out"],
      ["step-end"],
    ]);
  });

  test("reports `transition: all` and `transition-property: all`", () => {
    const found = checkCss(`
      .a { transition: all var(--d); }
      .b { transition-property: all; }
      .c { transition: all 200ms ease; }
    `);
    expect(literals(found)).toEqual([["all"], ["all"], ["all", "200ms", "ease"]]);
  });

  test("reads a multi-line declaration whole, and reports it on its property's line", () => {
    const found = checkCss(
      [
        ".a {", // 1
        "  color: red;", // 2
        "  transition:", // 3
        "    opacity var(--x),", // 4
        "    transform 0.7s var(--y);", // 5
        "}", // 6
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.literals).toEqual(["0.7s"]);
  });

  test("never reports a value inside var(), a token's fallback included", () => {
    const found = checkCss(`
      .a { animation-duration: var(--ui-dur-fast, 120ms); }
      .b { transition: opacity var(--a, var(--b, 120ms)) var(--ui-ease-out, cubic-bezier(0.22, 1, 0.36, 1)); }
      .c { transition-timing-function: var(--tw-ease, var(--default-transition-timing-function)); }
    `);
    expect(found).toEqual([]);
  });

  test("passes cire's scaled form and nothing else in calc()", () => {
    const found = checkCss(`
      .a { animation: attention-glow calc(2.6s * var(--motion-scale)) var(--ease-in-out) 3; }
      .b { transition-duration: calc(100ms + var(--x)); }
    `);
    expect(literals(found)).toEqual([["100ms"]]);
    expect(found[0]?.text).toBe("transition-duration: calc(100ms + var(--x))");
  });

  test("passes a reduced-motion override at any depth, and only inside the block", () => {
    const found = checkCss(`
      @layer base {
        @media (prefers-reduced-motion: reduce) {
          *, *::before { animation-duration: 0.01ms !important; animation-delay: -1ms !important; }
          .spin { animation-duration: 1.5s !important; }
        }
        .after { animation-duration: 0.01ms !important; }
      }
      @media (prefers-reduced-motion) { .b { transition-duration: 1ms; } }
    `);
    expect(literals(found)).toEqual([["0.01ms"]]);
    // The `.after` rule, outside the media block.
    expect(found[0]?.line).toBe(7);
  });

  test("reports a literal in a block where motion is on", () => {
    const found = checkCss(`
      @media (prefers-reduced-motion: no-preference) { .a { transition: opacity 200ms; } }
      @media not (prefers-reduced-motion: reduce) { .b { transition: opacity 200ms; } }
      @media (prefers-reduced-motion: reduce), (min-width: 0) { .c { transition: opacity 200ms; } }
    `);
    expect(literals(found)).toEqual([["200ms"], ["200ms"], ["200ms"]]);
  });

  test("passes a zero time", () => {
    expect(
      checkCss(`.a { transition-delay: 0s; animation-delay: 0ms; transition: opacity 0s; }`),
    ).toEqual([]);
  });

  test("passes a token definition, which is where a literal belongs", () => {
    const found = checkCss(`
      :root {
        --dur-fast: calc(90ms * var(--motion-scale));
        --ui-dur-exit: 80ms;
        --animate-tick-draw: tick-draw 340ms ease-out 180ms both;
        --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
      }
    `);
    expect(found).toEqual([]);
  });

  test("reads an @supports prelude as a prelude, not a declaration", () => {
    const found = checkCss(`
      @supports (animation-timing-function: linear(0, 1)) {
        :root { --ease-spring: linear(0, 0.5, 1); }
      }
    `);
    expect(found).toEqual([]);
  });

  test("a marker with a reason keeps its own declaration and no other", () => {
    const found = checkCss(`
      .a {
        /* motion-literal: a scroll reveal is choreography, slower than any rung */
        transition: opacity 0.7s var(--ease-out);
        animation-delay: 0.3s;
      }
      .b { transition: opacity 0.7s /* motion-literal: */ var(--ease-out); }
    `);
    expect(literals(found)).toEqual([["0.3s"], ["0.7s"]]);
  });

  test("a marker after a `;` on that line keeps the declaration it trails, not the next", () => {
    const found = checkCss(
      [
        ".a {",
        "  transition: opacity 200ms; /* motion-literal: a reason */",
        "  animation: x 1s;",
        "}",
        ".b { animation-delay: 0.3s; /* motion-literal: a reason */ }",
      ].join("\n"),
    );
    expect(literals(found)).toEqual([["1s"]]);
    expect(found[0]?.line).toBe(3);
  });

  test("reads a vendor-prefixed or upper-case property as the property", () => {
    const found = checkCss(`
      .a { -webkit-transition: opacity 200ms; }
      .b { -webkit-animation-duration: 1s; }
      .c { TRANSITION: opacity 300ms EASE-OUT; }
    `);
    expect(literals(found)).toEqual([["200ms"], ["1s"], ["300ms", "EASE-OUT"]]);
    expect(motionProperty("WebkitTransition")).toBe("transition");
    expect(motionProperty("msTransitionDuration")).toBe("transition-duration");
    expect(motionProperty("Transition")).toBe("transition");
    expect(motionProperty("--transition")).toBeUndefined();
  });

  test("a `;` or brace inside a comment or a string does not move the split", () => {
    const text = [
      ".a {", // 1
      '  content: "a;b{c}";', // 2
      "  /* a; b { c } */", // 3
      "  transition: opacity 200ms;", // 4
      "}", // 5
    ].join("\n");
    const found = checkCss(text);
    expect(literals(found)).toEqual([["200ms"]]);
    expect(found[0]?.line).toBe(4);
  });

  test("an animation name that looks like a literal is a name", () => {
    expect(
      checkCss(`
        .a { animation: fade-2s var(--d); }
        .b { animation: ease-in-bounce var(--d) both; }
        .c { animation: linear-wipe var(--d); }
      `),
    ).toEqual([]);
  });

  test("checks the classes an @apply writes", () => {
    const text = `.a { @apply transition-colors duration-200 ease-out; }`;
    expect(checkCss(text).map((f) => f.text)).toEqual(["duration-200", "ease-out"]);
    expect(checkCss(text, themeEasingsFor("cire/host/src/a.css")).map((f) => f.text)).toEqual([
      "duration-200",
    ]);
  });
});

describe("class tokens", () => {
  /** The class tokens reported in a class string. */
  const reported = (classes: string): string[] => checkClassTokens(classes).map((f) => f.text);

  test("reports Tailwind's built-in duration and delay steps", () => {
    expect(reported("transition-opacity duration-200 delay-150 duration-0")).toEqual([
      "duration-200",
      "delay-150",
    ]);
  });

  test("reports an arbitrary value with a literal, and passes a token reference", () => {
    expect(
      reported(
        "duration-[300ms] delay-[.2s] ease-[cubic-bezier(0.4,0,0.2,1)] " +
          "duration-[var(--x)] duration-(--x) duration-(--dur-fast,100ms) " +
          "ease-[var(--ease-out,var(--ui-ease-out))] ease-(--ease-in-out)",
      ),
    ).toEqual(["duration-[300ms]", "delay-[.2s]", "ease-[cubic-bezier(0.4,0,0.2,1)]"]);
  });

  test("passes the named easings a cire theme defines, and reports Tailwind's stock ones", () => {
    const named = "ease-in ease-out ease-in-out ease-linear";
    // Only cire's apps set `--ease-out` and `--ease-in-out` in their theme;
    // no app sets `--ease-in`, so it is Tailwind's own curve everywhere.
    const inCire = themeEasingsFor("/repo/cire/invites/src/components/Card.tsx");
    expect(checkClassTokens(named, inCire).map((f) => f.text)).toEqual(["ease-in", "ease-linear"]);
    expect(reported(named)).toEqual(["ease-in", "ease-out", "ease-in-out", "ease-linear"]);
    expect(themeEasingsFor("pulse/web/src/components/Header.tsx").size).toBe(0);
    expect(themeEasingsFor("tools/cire/src/x.ts").size).toBe(0);
  });

  test("reads an animate-[…] value as an animation shorthand", () => {
    expect(
      reported(
        "animate-[spin_1s_linear_infinite] animate-spin " +
          "base:animate-[pulse_calc(2s*var(--motion-scale,1))_var(--ease-in-out,var(--ui-ease-in-out))_infinite]",
      ),
    ).toEqual(["animate-[spin_1s_linear_infinite]"]);
  });

  test("reads an arbitrary motion property as a declaration", () => {
    expect(
      reported(
        "[transition:opacity_200ms] data-[expanded]:[animation:ui-enter_200ms_ease-out_both] " +
          "base:motion-safe:data-[expanded]:[animation:ui-enter_var(--dur-fast,var(--ui-dur-fast))_var(--ease-out,var(--ui-ease-out))_both]",
      ),
    ).toEqual([
      "[transition:opacity_200ms]",
      "data-[expanded]:[animation:ui-enter_200ms_ease-out_both]",
    ]);
  });

  test("reports every spelling of transition-all and passes named properties", () => {
    expect(
      reported(
        "transition-all hover:transition-all transition-[all] [transition:all] [transition-property:all] " +
          "transition-[border-color,translate,box-shadow] transition-colors",
      ),
    ).toEqual([
      "transition-all",
      "hover:transition-all",
      "transition-[all]",
      "[transition:all]",
      "[transition-property:all]",
    ]);
  });

  test("sees through variants and `!`, and passes a motion-reduce override", () => {
    expect(
      reported(
        "base:data-[expanded]:duration-200 !duration-300 duration-500! [&>svg]:delay-75 motion-reduce:duration-[0.01ms] motion-safe:duration-200",
      ),
    ).toEqual([
      "base:data-[expanded]:duration-200",
      "!duration-300",
      "duration-500!",
      "[&>svg]:delay-75",
      "motion-safe:duration-200",
    ]);
  });

  test("leaves a look-alike alone", () => {
    expect(
      reported("transition-allowed my-duration-200 ease-out-quart is-delay-150 duration"),
    ).toEqual([]);
  });

  test("gives each token's line and column", () => {
    const found = checkClassTokens("flex\n  gap-2 duration-200");
    expect(found.map((f) => [f.line, f.column])).toEqual([[2, 9]]);
  });
});

describe("Astro files", () => {
  test("reports a literal in a <style> block, on the file's line", () => {
    const text = [
      "---", // 1
      'const x = "a";', // 2
      "---", // 3
      "<details>", // 4
      "</details>", // 5
      "<style>", // 6
      "  .a {", // 7
      "    transition: transform 0.2s ease;", // 8
      "  }", // 9
      "</style>", // 10
    ].join("\n");
    const found = checkAstro(text);
    expect(found.map((f) => [f.line, f.literals])).toEqual([[8, ["0.2s", "ease"]]]);
  });

  test("reports a class literal in the markup, on its line", () => {
    const text = [
      "<section>",
      '  <a class="px-4 transition-colors duration-200">x</a>',
      "</section>",
    ].join("\n");
    expect(checkAstro(text).map((f) => [f.line, f.text])).toEqual([[2, "duration-200"]]);
  });

  test("reports a literal in a style attribute", () => {
    const found = checkAstro(`<div style="transition: opacity 200ms">x</div>`);
    expect(found.map((f) => f.literals)).toEqual([["200ms"]]);
  });

  test("a marker directly before a tag keeps that tag's literals and no other", () => {
    const text = [
      "{/* motion-literal: a hover fade this site has no token for */}",
      '<a class="transition-colors duration-200">kept</a>',
      '<a class="transition-colors duration-300">reported</a>',
      "<!-- motion-literal: the same, as an HTML comment -->",
      "<div",
      '  class="duration-500"',
      ">kept</div>",
      "{/* motion-literal: */}",
      '<a class="duration-700">no reason, so reported</a>',
    ].join("\n");
    expect(checkAstro(text).map((f) => f.text)).toEqual(["duration-300", "duration-700"]);
  });

  test("reads frontmatter and <script> for class tokens only, and prose not at all", () => {
    const text = [
      "---", // 1
      'const style = "transition: opacity 200ms";', // 2
      'const cls = "transition-all";', // 3
      "---", // 4
      "<script>", // 5
      'el.dataset.state = "transition: opacity 200ms";', // 6
      "</script>", // 7
      "<p>Takes 200ms to load, with ease</p>", // 8
    ].join("\n");
    expect(checkAstro(text).map((f) => [f.line, f.text])).toEqual([[3, "transition-all"]]);
  });

  test("a marker on the line above keeps that line's class in frontmatter and <script>, and no other", () => {
    const text = [
      "---", // 1
      "// motion-literal: a reason", // 2
      'const kept = "duration-200";', // 3
      'const reported = "duration-300";', // 4
      "---", // 5
      "<script>", // 6
      "/* motion-literal: a reason */", // 7
      'el.className = "delay-150";', // 8
      'el.className = "delay-75";', // 9
      "</script>", // 10
    ].join("\n");
    expect(checkAstro(text).map((f) => [f.line, f.text])).toEqual([
      [4, "duration-300"],
      [9, "delay-75"],
    ]);
  });

  test("judges a Tailwind named easing by the app the file belongs to", () => {
    const text = '<a class="transition-colors ease-out">x</a>';
    expect(checkAstro(text).map((f) => f.text)).toEqual(["ease-out"]);
    expect(checkAstro(text, themeEasingsFor("cire/landing/src/pages/index.astro"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The CLI, against fixture roots, then against this checkout.

const SCRIPT = new URL("../check-motion-literals.ts", import.meta.url).pathname;
const SUCCESS_LINE = "check-motion-literals: no literal motion in";

async function runCli(
  root: string | undefined,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const env = { ...Bun.env };
  delete env.MOTION_LITERALS_ROOT;
  if (root !== undefined) env.MOTION_LITERALS_ROOT = root;
  const proc = Bun.spawn([process.execPath, "run", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** A fixture root holding `files` (path → contents), each written with its parent dirs. */
async function withFixtureRoot(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "motion-literals-cli-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const CLEAN = {
  // `ease-out` reads cire's own theme token here, and Tailwind's stock curve
  // anywhere else: the CLI judges each file by its path.
  "cire/host/src/styles/global.css":
    ".a { transition: opacity var(--dur-fast) var(--ease-out); @apply ease-out; }\n",
  "pulse/landing/src/components/Faq.astro": '<a class="transition-colors">x</a>\n',
};

describe("check-motion-literals CLI", () => {
  test("exits non-zero naming the file and line of each literal", async () => {
    await withFixtureRoot(
      {
        ...CLEAN,
        "musubi/landing/src/styles/global.css":
          ".a {\n  color: red;\n  transition: transform 0.2s ease;\n}\n",
        "shared/toast/src/x.astro": '<p>\n<a class="duration-200">x</a></p>\n',
        "pulse/web/src/b.css": ".b { @apply ease-out; }\n",
      },
      async (root) => {
        const { exitCode, stdout, stderr } = await runCli(root);
        expect(stderr).toContain("::error file=musubi/landing/src/styles/global.css,line=3::");
        expect(stderr).toContain("::error file=shared/toast/src/x.astro,line=2::");
        expect(stderr).toContain("::error file=pulse/web/src/b.css,line=1::`ease-out`");
        expect(stderr).not.toContain("cire/host");
        expect(stdout).not.toContain(SUCCESS_LINE);
        expect(exitCode).not.toBe(0);
      },
    );
  });

  test("exits 0 on a clean tree and says how many files it read", async () => {
    await withFixtureRoot(CLEAN, async (root) => {
      const { exitCode, stdout, stderr } = await runCli(root);
      expect(stderr).toBe("");
      expect(stdout).toContain(`${SUCCESS_LINE} 2 `);
      expect(exitCode).toBe(0);
    });
  });

  test("reads product src/ only", async () => {
    await withFixtureRoot(
      {
        ...CLEAN,
        "cire/host/tests/fixture.css": ".a { transition: opacity 200ms; }",
        "tools/lab/src/lab.css": ".a { transition: opacity 200ms; }",
        "cire/host/src/node_modules/x/a.css": ".a { transition: opacity 200ms; }",
        "cire/host/dist/a.css": ".a { transition: opacity 200ms; }",
      },
      async (root) => {
        const { exitCode, stdout } = await runCli(root);
        expect(stdout).toContain(`${SUCCESS_LINE} 2 `);
        expect(exitCode).toBe(0);
      },
    );
    await withFixtureRoot(
      { ...CLEAN, "zap/web/src/deep/a.css": ".a { transition: opacity 200ms; }" },
      async (root) => {
        const { exitCode, stderr } = await runCli(root);
        expect(stderr).toContain("zap/web/src/deep/a.css");
        expect(exitCode).not.toBe(0);
      },
    );
  });

  test("fails when it finds no file to read", async () => {
    await withFixtureRoot({ "README.md": "" }, async (root) => {
      const { exitCode, stdout } = await runCli(root);
      expect(stdout).not.toContain(SUCCESS_LINE);
      expect(exitCode).not.toBe(0);
    });
  });

  // Every other test sets the override. This one reads this checkout from the
  // script's own location: the tree the guard exists to hold.
  test("exits 0 on this repository with no override set", async () => {
    const { exitCode, stdout, stderr } = await runCli(undefined);
    expect(stderr).toBe("");
    expect(stdout).toContain(SUCCESS_LINE);
    expect(exitCode).toBe(0);
  });
});
