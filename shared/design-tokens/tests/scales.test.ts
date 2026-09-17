/**
 * The scales, and the migration table that carries the tree onto them.
 *
 * The table is the decision — a codemod is only the thing that applies it — so
 * what has to be guarded is that the table is *complete* and *consistent*, not
 * that some script ran. A mapping missing a value the tree actually uses leaves
 * an arbitrary value behind, which `no-arbitrary-values` then fails on in a
 * phase where nobody is expecting to touch that file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTRACT_SCALES, SCALE_MIGRATION } from "../src/index";

const CSS = readFileSync(
  fileURLToPath(new URL("../src/tokens.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** A Tailwind v4 theme namespace, and the `CONTRACT_SCALES` key it mirrors. */
const NAMESPACES = [
  ["--text-ui-", "text"],
  ["--tracking-ui-", "tracking"],
  ["--leading-ui-", "leading"],
  ["--container-ui-", "measure"],
] as const;

describe("tokens.css declares exactly the scales the module exports", () => {
  for (const [prefix, key] of NAMESPACES) {
    it(`${key}: every step is aliased, with its value as the fallback`, () => {
      for (const [step, value] of Object.entries(CONTRACT_SCALES[key])) {
        // `--text-ui-sm: var(--ui-text-sm, 0.8rem);`
        const token = key === "measure" ? `--ui-measure-${step}` : `--ui-${key}-${step}`;
        const declaration = new RegExp(
          `${prefix}${step.replace(/[^\w-]/g, "\\$&")}:\\s*var\\(\\s*${token}\\s*,\\s*${value.replace(
            /[.\\+*?[^\]$(){}=!<>|:#-]/g,
            "\\$&",
          )}\\s*\\)`,
        );
        expect(CSS).toMatch(declaration);
      }
    });

    it(`${key}: declares no step the module does not export`, () => {
      const declared = [...CSS.matchAll(new RegExp(`${prefix}([\\w-]+):`, "g"))].map((m) => m[1]);
      const known = new Set(Object.keys(CONTRACT_SCALES[key]));
      expect(declared.filter((s) => !known.has(s))).toEqual([]);
    });
  }
});

describe("the type scale is a scale", () => {
  it("rises monotonically", () => {
    const values = Object.values(CONTRACT_SCALES.text).map((v) => Number.parseFloat(v));
    expect(values).toEqual(values.toSorted((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses one unit throughout — `em` would compound when nested", () => {
    for (const v of Object.values(CONTRACT_SCALES.text)) expect(v).toMatch(/rem$/);
    for (const v of Object.values(CONTRACT_SCALES.measure)) expect(v).toMatch(/rem$/);
  });

  it("keeps consecutive steps visibly apart", () => {
    // The whole argument for seven steps over eleven is that a reader can tell
    // one from the next. Below about 8% they cannot, and the scale quietly
    // becomes the drift it replaced.
    const values = Object.values(CONTRACT_SCALES.text).map((v) => Number.parseFloat(v));
    for (let i = 1; i < values.length; i++) {
      expect(values[i] / values[i - 1]).toBeGreaterThan(1.08);
    }
  });

  it("has no measure step narrower than the widest body measure is tall", () => {
    // A sanity floor rather than a typographic law: a "measure" under 20rem is
    // a layout constant wearing the wrong name, and those stay arbitrary.
    for (const v of Object.values(CONTRACT_SCALES.measure)) {
      expect(Number.parseFloat(v)).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("SCALE_MIGRATION", () => {
  for (const key of ["text", "tracking", "leading"] as const) {
    it(`${key}: every target names a real step`, () => {
      const steps = new Set(Object.keys(CONTRACT_SCALES[key]));
      const bad = Object.entries(SCALE_MIGRATION[key]).filter(([, to]) => !steps.has(to));
      expect(bad).toEqual([]);
    });

    it(`${key}: maps each source value exactly once`, () => {
      const sources = Object.keys(SCALE_MIGRATION[key]);
      expect(new Set(sources).size).toBe(sources.length);
    });
  }

  it("text: sends each value to its nearest step, so the mapping is checkable rather than arbitrary", () => {
    const steps = Object.entries(CONTRACT_SCALES.text).map(
      ([name, v]) => [name, Number.parseFloat(v)] as const,
    );
    const asRem = (v: string) =>
      v.endsWith("px") ? Number.parseFloat(v) / 16 : Number.parseFloat(v);

    for (const [from, to] of Object.entries(SCALE_MIGRATION.text)) {
      const target = asRem(from);
      // `<=` rather than `<`, so an exact tie resolves UP. `0.75rem` is
      // equidistant from `xs` (0.7) and `sm` (0.8); rounding up is the rule,
      // because the failure mode of a too-small label is illegibility and the
      // failure mode of a too-large one is a slightly looser line.
      const nearest = steps.reduce((a, b) =>
        Math.abs(b[1] - target) <= Math.abs(a[1] - target) ? b : a,
      );
      expect(`${from} → ${to}`).toBe(`${from} → ${nearest[0]}`);
    }
  });

  it("text: covers every plain size the tree actually uses", () => {
    // Guards the thing that would otherwise be discovered in phase 5: a value
    // in the tree with no entry here survives the codemod and then trips
    // `no-arbitrary-values` in a file nobody meant to touch. The list is the
    // measured distribution at b5f9c8f; a new one appearing is a real signal
    // that someone added an arbitrary size after the freeze.
    const observed = [
      "0.55rem",
      "0.58rem",
      "0.6rem",
      "0.62rem",
      "0.64rem",
      "0.65rem",
      "0.66rem",
      "0.68rem",
      "0.7rem",
      "0.72rem",
      "0.74rem",
      "0.75rem",
      "0.76rem",
      "0.78rem",
      "0.8rem",
      "0.82rem",
      "0.84rem",
      "0.85rem",
      "0.86rem",
      "0.875rem",
      "0.88rem",
      "0.9rem",
      "0.92rem",
      "0.95rem",
      "0.98rem",
      "1rem",
      "1.02rem",
      "1.05rem",
      "1.1rem",
      "1.15rem",
      "1.2rem",
      "1.25rem",
      "1.3rem",
      "1.4rem",
      "1.5rem",
      "1.6rem",
      "1.7rem",
      "2rem",
      "2.5rem",
      "2.75rem",
      "3rem",
      "3.25rem",
      "8px",
      "9px",
      "9.5px",
      "10px",
      "10.5px",
      "11px",
      "11.5px",
      "12px",
      "12.5px",
      "13px",
      "13.5px",
      "15.5px",
      "16.5px",
      "22px",
      "26px",
      "28px",
      "34px",
      "42px",
    ];
    const mapped = new Set(Object.keys(SCALE_MIGRATION.text));
    expect(observed.filter((v) => !mapped.has(v))).toEqual([]);
  });

  it("tracking and leading cover their observed values too", () => {
    const tracking = [
      "-0.02em",
      "-0.01em",
      "0.02em",
      "0.04em",
      "0.05em",
      "0.06em",
      "0.08em",
      "0.1em",
      "0.12em",
      "0.14em",
      "0.16em",
      "0.18em",
      "0.2em",
      "0.22em",
      "0.24em",
      "0.25em",
      "0.26em",
      "0.28em",
    ];
    const leading = [
      "1.05",
      "1.08",
      "1.1",
      "1.15",
      "1.2",
      "1.4",
      "1.55",
      "1.6",
      "1.65",
      "1.7",
      "1.75",
      "1.8",
    ];
    expect(tracking.filter((v) => !(v in SCALE_MIGRATION.tracking))).toEqual([]);
    expect(leading.filter((v) => !(v in SCALE_MIGRATION.leading))).toEqual([]);
  });

  it("moves 0.72rem and 0.82rem — the two biggest clusters — by a third of a pixel", () => {
    // 128 and 108 sites respectively. Naming the number here is what stops a
    // later reader assuming the migration was cosmetic-only, and what makes a
    // change to `xs` or `sm` obviously a decision rather than a tidy-up.
    expect(SCALE_MIGRATION.text["0.72rem"]).toBe("xs");
    expect(SCALE_MIGRATION.text["0.82rem"]).toBe("sm");
    expect(Number.parseFloat(CONTRACT_SCALES.text.xs) * 16).toBeCloseTo(11.2, 5);
    expect(Number.parseFloat(CONTRACT_SCALES.text.sm) * 16).toBeCloseTo(12.8, 5);
  });
});
