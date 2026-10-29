import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { contrastOklch, cssRamp, type Oklch } from "@cire/theme";
import { CONTRACT_SCALAR_TOKENS } from "@shared/design-tokens";
import { checkContractConformance } from "@shared/design-tokens/conformance";
import { describe, expect, it } from "vitest";

/**
 * The contrast contract for the two ramps in `global.css`.
 *
 * A drift guard, not a design tool: it exists so that nudging one lightness to
 * make a card look right cannot silently push muted text under 4.5:1 six months
 * later. It reads the stylesheet rather than a table of colours copied into a
 * test, because a copied table is the thing that drifts.
 *
 * **Most of it is now `@shared/design-tokens`.** The hand-written pair table and
 * the alpha-compositing machinery under it moved into the contract's own
 * conformance harness when this portal joined the contract. The harness knows
 * which role owes 4.5:1 and which owes 3:1, and it checks every ink against
 * every ground rather than the subset somebody thought to list — which is how
 * it found three defects the old table could not:
 *
 * - the primary button's label, `text-bg` on a gold fill, at **2.42:1** in light;
 * - the same button's hover, `bg-gold-dim` composited over the page, at
 *   **1.80:1** in dark;
 * - `success` and `warn` on `bg-deep` and `surface-sunk`, at 4.20–4.39:1.
 *
 * `--on-gold` and `--gold-hi` are the tokens that fixed the first two.
 *
 * What stays here is what the contract has no name for. cire carries two accent
 * families, `--ui-accent` is the gold one, and the brand green survives for
 * this product's own use — so this file still owns the green's pairs, and the
 * ramp's *shape* (which is not a contrast question at all).
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/styles/global.css", import.meta.url)),
  "utf8",
);

/**
 * Light and dark, as the harness sees them.
 *
 * Dark is the default and lives on bare `:root`, so light is `:root` THEN the
 * explicit override — the attribute block supplies only what it changes, and
 * the rest still comes from `:root`.
 */
const SCOPES = [
  { name: "dark", selectors: [":root"] },
  { name: "light", selectors: [":root", ':root[data-theme="light"]'] },
] as const;

describe("design-token contract", () => {
  it("maps every role without breaking contrast, in both themes", () => {
    // `check` rather than `assert` so a failure arrives as a diff of readable
    // lines against `[]`, listing every bad pair at once rather than stopping
    // at the first.
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("imports the contract stylesheet, or none of the above is loaded at all", () => {
    // Without the import the mapping is a block of custom properties no utility
    // reads, and this file would assert happily about a contract the app does
    // not actually use.
    expect(CSS).toMatch(/@import\s+["']@shared\/design-tokens\/tokens\.css["']/);
  });

  it("sends the accent to gold, not to the brand green", () => {
    // The decision the mapping turns on, and the one a reader coming from the
    // shadcn block it replaced would get backwards — `--color-primary` used to
    // be `--brand`. Counted across both portals' components, gold appears in 422
    // colour utilities and the green in 8.
    expect(CSS).toMatch(/--ui-accent:\s*var\(--gold\)/);
    expect(CSS).not.toMatch(/--ui-accent:\s*var\(--brand\)/);
  });

  it("maps the contract through aliases, so `data-theme` carries it", () => {
    // A literal would pin the dark value into light, and the failure would
    // surface much later as "light mode ignores the theme".
    const mapping = CSS.slice(CSS.indexOf("--ui-ground:"), CSS.indexOf("--ui-radius-hair:"));
    expect([...mapping.matchAll(/(--ui-[\w-]+):\s*(oklch|#)/gi)].map((m) => m[1])).toEqual([]);
  });

  it("maps all seven type steps rather than leaving gaps for the fallback", () => {
    // A shared component using a step this app has not mapped renders the
    // package's neutral default — a different type system showing through in
    // the middle of this one.
    for (const step of ["xs", "sm", "base", "md", "lg", "xl", "2xl"]) {
      expect(CSS).toMatch(new RegExp(`--ui-text-${step}:`));
    }
  });
});

/** This package's own stylesheet, at one theme's selector. */
function ramp(selector: string): Map<string, Oklch> {
  return cssRamp(CSS, selector);
}

// The dark ramp is the only `:root` block carrying `color-scheme: dark` — the
// other bare `:root` blocks hold motion, toast and the contract mapping.
const DARK = ramp(":root {\n  color-scheme: dark;");
const LIGHT = ramp(':root[data-theme="light"]');
const LIGHT_SYSTEM = ramp(":root:not([data-theme])");

/**
 * The brand green, which the contract does not name.
 *
 * `--ui-accent` is gold, so nothing in the harness above measures this family.
 * It is still in the ramp and still in use, so its pairs are asserted here.
 * Every one is opaque, which is why there is no compositing step: the harness
 * owns that now, and the translucent tokens are all on its side of the line.
 */
function ratio(tokens: Map<string, Oklch>, fg: string, bg: string): number {
  const f = tokens.get(fg);
  const b = tokens.get(bg);
  if (!f) throw new Error(`missing token --${fg}`);
  if (!b) throw new Error(`missing token --${bg}`);
  if (f.a < 1) throw new Error(`--${fg} is translucent; measure it through the contract harness`);
  return contrastOklch(f, b);
}

describe.each([
  ["dark", DARK],
  ["light", LIGHT],
] as const)("%s ramp — the brand green", (_name, tokens) => {
  it.each([
    ["brand-ink", "bg"],
    ["brand-ink", "surface"],
    ["on-brand", "brand"],
  ] as const)("--%s on --%s clears 4.5:1", (fg, bg) => {
    expect(ratio(tokens, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("--on-brand on the hover fill --brand-hi clears 3:1", () => {
    // The gold equivalent of this pair was 1.80:1 before the contract found it.
    expect(ratio(tokens, "on-brand", "brand-hi")).toBeGreaterThanOrEqual(3);
  });
});

describe("ramp shape", () => {
  it("declares the same tokens in both ramps", () => {
    // A token defined in dark and forgotten in light does not fail loudly — it
    // silently keeps the dark value, which is how a light mode ends up with one
    // black card in it.
    expect(new Set(LIGHT.keys())).toEqual(new Set(DARK.keys()));
  });

  it("keeps the system-preference light block identical to the explicit one", () => {
    // The `@media (prefers-color-scheme: light)` copy exists so a document with
    // no JavaScript still gets light. The two are hand-duplicated, so assert
    // they have not drifted apart.
    expect([...LIGHT_SYSTEM].map(([k, v]) => [k, v])).toEqual([...LIGHT].map(([k, v]) => [k, v]));
  });

  it("emits the aliases whether or not a utility uses them", () => {
    // Tailwind only emits the theme variables it sees a utility using, and it
    // reads source as text — so a token spelled only inside a `style={{ … }}`
    // object is invisible to it. `static` emits the block regardless, which is
    // what keeps a `--color-*` read from JavaScript, or written into an inline
    // style, from resolving to nothing the moment the last matching class
    // leaves the package — with every test still green.
    expect(CSS).toContain("@theme static {");
  });

  it("keeps the ramps value-for-value identical to the host portal's", () => {
    // The two portals are two doors into one product, and a vendor who also
    // hosts a wedding moves between them in a session. The tokens are
    // duplicated rather than imported (a cross-package CSS import would make
    // Tailwind scan the other package's source for classes), so this is what
    // holds the copy to the original. A deliberate divergence goes here as an
    // exception with a reason, not as a silently different green.
    const HOST = readFileSync(
      fileURLToPath(new URL("../../../host/src/styles/global.css", import.meta.url)),
      "utf8",
    );
    for (const [selector, mine] of [
      [":root {\n  color-scheme: dark;", DARK],
      [':root[data-theme="light"]', LIGHT],
    ] as const) {
      const theirs = cssRamp(HOST, selector);
      expect(new Set(theirs.keys()), `${selector} token set`).toEqual(new Set(mine.keys()));
      for (const [name, value] of mine) {
        expect(value, `--${name} in ${selector}`).toEqual(theirs.get(name));
      }
    }
  });

  it("gives every ramp a whole set of grounds and ink", () => {
    for (const key of [
      "bg",
      "bg-deep",
      "surface",
      "surface-raised",
      "surface-sunk",
      "text",
      "brand",
      "focus",
    ]) {
      expect(DARK.has(key)).toBe(true);
    }
  });
});

/**
 * One shape and one pace across the four cire apps.
 *
 * Each app declares its own copy of the corner scale and the motion ladder in
 * its own stylesheet, because a cross-package CSS import would make Tailwind
 * scan the other package's source for classes. Copies drift, so this reads all
 * four from disk and holds them to one set of numbers.
 */
describe("one shape and one pace across cire", () => {
  const SURFACES = {
    host: readSheet("host"),
    vendor: CSS,
    invites: readSheet("invites"),
    landing: readSheet("landing"),
  } as const;

  /**
   * The corner each contract role paints in cire, in px. `--ui-radius-sheet`
   * is left out by name: host and vendor never present a bottom sheet, and the
   * guest site and landing hold theirs at 1.75rem.
   */
  const ROLE_PX: Record<string, number> = {
    "--ui-radius-hair": 2,
    "--ui-radius-sm": 6,
    "--ui-radius-md": 10,
    "--ui-radius-lg": 16,
    "--ui-radius-pill": 999,
    "--ui-radius-control": 999,
    "--ui-radius-field": 14,
  };

  const ROLES = CONTRACT_SCALAR_TOKENS.radius.filter((name) => name !== "--ui-radius-sheet");

  /** The steps an app's own `rounded-*` utilities read, in px. */
  const SCALE_PX = {
    "--radius-hair": 2,
    "--radius-sm": 6,
    "--radius-md": 10,
    "--radius-pill": 999,
  };

  /** What a surface's stylesheet gives each corner, in px. */
  function shape(css: string) {
    const decls = declarations(css);
    const scope = cascade(decls);
    return {
      // The contract's roles, which `rounded-ui-*` and the shared parts paint.
      roles: Object.fromEntries(ROLES.map((role) => [role, cornerPx(scope, role)])),
      // The steps behind the app's own `rounded-sm` and friends, so a
      // hand-written corner means the same thing in whichever app it is written.
      scale: Object.fromEntries(
        decls
          .filter((d) => isTopLevel(d, "@theme") && d.name.startsWith("--radius-"))
          .map((d) => [d.name, cornerPx(scope, d.name)]),
      ),
      // The toast reads its own name, not the contract's.
      toast: /@import\s+["']@shared\/toast\/toast\.css["']/.test(css)
        ? cornerPx(scope, "--toast-radius")
        : "no toast",
    };
  }

  it("every cire surface carries one radius scale", () => {
    const one = {
      roles: Object.fromEntries(ROLES.map((role) => [role, ROLE_PX[role]])),
      scale: SCALE_PX,
      toast: 10,
    };
    expect(mapSurfaces(shape)).toEqual({
      host: one,
      vendor: one,
      invites: one,
      landing: { ...one, toast: "no toast" },
    });
  });

  it("every cire surface carries one motion ladder", () => {
    const ladders = mapSurfaces((css) => ladder(declarations(css)));
    // A parse that found nothing would make every copy agree with it.
    expect(Object.values(ladders.host).map((lines) => lines.length)).toEqual([4, 3, 2, 3, 1]);
    expect(ladders).toEqual({
      host: ladders.host,
      // The one app that renders no `Modal`, so it sets no `Modal` timing.
      vendor: { ...ladders.host, modal: [] },
      invites: ladders.host,
      landing: ladders.host,
    });
  });

  /**
   * The rules that draw an unchecked native checkbox or radio (host DESIGN.md
   * §4, "Checkboxes and radios"), comments dropped and whitespace collapsed, so
   * a copy that drifts in one app is caught here rather than on a screen.
   */
  function uncheckedBox(css: string): string[] {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector!.includes(":not(:checked"))
      .map(([, selector, body]) => `${selector!.trim()} { ${body!.trim()} }`.replace(/\s+/g, " "));
  }

  it("every cire surface draws an unchecked checkbox and radio alike", () => {
    const rules = mapSurfaces(uncheckedBox);
    // A parse that found nothing would make every copy agree with it.
    expect(rules.host).toHaveLength(4);
    expect(rules).toEqual({
      host: rules.host,
      vendor: rules.host,
      invites: rules.host,
      landing: rules.host,
    });
  });

  function mapSurfaces<R>(read: (css: string) => R): Record<keyof typeof SURFACES, R> {
    return {
      host: read(SURFACES.host),
      vendor: read(SURFACES.vendor),
      invites: read(SURFACES.invites),
      landing: read(SURFACES.landing),
    };
  }
});

/** Another cire app's stylesheet, read from disk. */
function readSheet(app: "host" | "invites" | "landing"): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${app}/src/styles/global.css`, import.meta.url)),
    "utf8",
  );
}

/** One custom-property declaration, with the block preludes it sits inside. */
interface Declaration {
  /** Outermost first: `[":root"]`, `["@theme static"]`, `["@media (pointer: fine)", ":root"]`. */
  path: string[];
  name: string;
  value: string;
}

/**
 * Every custom-property declaration in a stylesheet. Brace counting rather than
 * a regex, because `@media` and `@supports` nest a `:root` inside them and the
 * ladder is told apart by exactly that nesting.
 */
function declarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Declaration[] = [];
  const path: string[] = [];
  let start = 0;
  const record = (chunk: string) => {
    const m = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(chunk);
    if (m) out.push({ path: [...path], name: m[1], value: m[2].trim() });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      path.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (ch === "}") {
      record(text.slice(start, i));
      path.pop();
      start = i + 1;
    } else if (ch === ";") {
      record(text.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

/** A declaration in a top-level block: `:root` exactly, or any `@theme` block. */
function isTopLevel(d: Declaration, block: ":root" | "@theme"): boolean {
  if (d.path.length !== 1) return false;
  return block === ":root" ? d.path[0] === ":root" : d.path[0].startsWith("@theme");
}

/**
 * What each name holds at the document root once the cascade settles. Tailwind
 * puts `@theme` into its theme layer, so an unlayered `:root` beats it whatever
 * the source order; within each, the later declaration wins.
 */
function cascade(decls: Declaration[]): Map<string, string> {
  return new Map(
    [
      ...decls.filter((d) => isTopLevel(d, "@theme")),
      ...decls.filter((d) => isTopLevel(d, ":root")),
    ].map((d) => [d.name, d.value]),
  );
}

/** `value` with every `var()` replaced by what it names, or by its fallback. */
function resolveVars(value: string, scope: Map<string, string>, seen: string[] = []): string {
  const at = value.indexOf("var(");
  if (at === -1) return value;
  let depth = 0;
  let end = -1;
  for (let i = at + 3; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`unbalanced var() in \`${value}\``);
  const inner = value.slice(at + 4, end);
  const comma = inner.indexOf(",");
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  if (seen.includes(name)) throw new Error(`var() cycle through ${name}`);
  const own = scope.get(name);
  const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
  let replacement: string;
  if (own !== undefined) replacement = resolveVars(own, scope, [...seen, name]);
  else if (fallback !== undefined) replacement = resolveVars(fallback, scope, seen);
  else throw new Error(`${name} is not declared`);
  return resolveVars(value.slice(0, at) + replacement + value.slice(end + 1), scope, seen);
}

/**
 * The corner a name holds, in px, or why it has none — a string rather than a
 * throw, so one failing assertion lists every bad role at once.
 */
function cornerPx(scope: Map<string, string>, name: string): number | string {
  const value = scope.get(name);
  if (value === undefined) return "not declared";
  const length = resolveVars(value, scope, [name]);
  const m = /^(\d*\.?\d+)(px|rem)$/.exec(length);
  if (!m) return `not a length: ${length}`;
  return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
}

/**
 * An app's motion tokens, as `name: value` lines with the whitespace removed:
 * the touch ladder at `:root`, the desk ladder under `(pointer: fine)` and the
 * `Modal` durations set there, the easings in `@theme`, and the spring the
 * `linear()` check swaps in. A `Modal` duration set at `:root` lands in
 * `touch`, where host has none.
 */
function ladder(decls: Declaration[]) {
  // Sorted, not keyed by name, so a token declared twice shows up as two lines.
  const lines = (where: (d: Declaration) => boolean, name: RegExp) => {
    const out = decls
      .filter((d) => where(d) && name.test(d.name))
      .map((d) => `${d.name}: ${d.value.replace(/\s+/g, "")}`);
    out.sort();
    return out;
  };
  const nested = (d: Declaration, outer: string) =>
    d.path.length === 2 && d.path[0] === outer && d.path[1] === ":root";
  return {
    touch: lines((d) => isTopLevel(d, ":root"), /^--(motion-scale|dur-|ui-modal-)/),
    desk: lines((d) => nested(d, "@media (pointer: fine)"), /^--dur-/),
    modal: lines((d) => nested(d, "@media (pointer: fine)"), /^--ui-modal-/),
    easing: lines((d) => isTopLevel(d, "@theme"), /^--ease-/),
    spring: lines(
      (d) => nested(d, "@supports (animation-timing-function: linear(0, 1))"),
      /^--ease-/,
    ),
  };
}
