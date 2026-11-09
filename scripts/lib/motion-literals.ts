/**
 * What counts as a literal motion value, decided in one place for both halves
 * of the check: `house/no-literal-motion` reads TypeScript and JavaScript,
 * which oxlint parses, and `scripts/check-motion-literals.ts` reads `.css` and
 * `.astro` files, which oxlint never parses. Both import this file, so the two
 * cannot disagree about a value.
 *
 * A motion's duration, delay and curve come from a token chosen by its job
 * (wiki/shared/design-tokens.md §Motion; cire's `--dur-*` and `--ease-*`), so
 * a change of pace is one edit and every motion that shares a job moves with
 * it. A number written where it is used follows nothing.
 *
 * A **motion declaration** is one whose property is in `MOTION_PROPERTIES`.
 * Custom properties never are: `--dur-fast: 120ms` is a token's definition,
 * which is where a literal belongs. In a motion declaration's value, after
 * every `calc(…)` holding `var(--motion-scale` and then every `var(…)` are
 * removed (so a fallback never counts), a literal is:
 *
 * - a non-zero time (`200ms`, `.2s`); zero chooses no timing and passes;
 * - an easing written out: `cubic-bezier(…)`, `steps(…)`, `linear(…)`, or a
 *   keyword (`ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear`,
 *   `step-start`, `step-end`);
 * - `all` in `transition` or `transition-property`: it animates whatever
 *   changes next, layout included, and names nothing a reader can check.
 *
 * A property is matched without regard to case or a vendor prefix:
 * `-webkit-transition` is `transition`.
 *
 * Nothing inside `@media (prefers-reduced-motion: reduce)` is a literal: the
 * near-zero durations there switch motion off rather than time it. A query
 * that negates or lists (`not (…: reduce)`, `(…: reduce), (min-width: 0)`)
 * also matches where motion is on, so it exempts nothing. A declaration also
 * passes when it carries a `/* motion-literal: <reason> *\/` comment with a
 * reason, inside it, on the line above it, or after its `;` on the same line:
 * the house form for a literal no token of its job can replace.
 *
 * A Tailwind class is judged by what it compiles to (Tailwind 4.3):
 * `duration-200` and `delay-150` write the number, `ease-linear` writes
 * `linear`, and arbitrary values (`duration-[…]`, `ease-[…]`, `animate-[…]`,
 * `[transition:…]`) write what is in the brackets. `ease-in`, `ease-out` and
 * `ease-in-out` read the app's `--ease-*` theme variable: a token where the
 * app sets one (`themeEasingsFor`), Tailwind's stock curve where it does not.
 * Every named `animate-*` passes. `transition-all` is
 * `transition-property: all`.
 *
 * This file imports nothing and uses only erasable TypeScript: CI's
 * `script-tests` job runs it with no install, and `bun run lint` loads it
 * under Node's type stripping.
 */

/** One literal found: where, what was written, and the literals in it. */
export type MotionFinding = {
  /** 1-based line in the text given. */
  readonly line: number;
  /** 1-based column in the text given. */
  readonly column: number;
  /** The declaration or class token as written, whitespace collapsed. */
  readonly text: string;
  /** Each literal in it, in the order written. */
  readonly literals: readonly string[];
};

/** A finding before it is positioned: its offset in the whole text. */
type Found = {
  readonly offset: number;
  readonly text: string;
  readonly literals: readonly string[];
};

/** The properties whose values time or shape a motion. */
const MOTION_PROPERTIES = new Set([
  "transition",
  "transition-property",
  "transition-duration",
  "transition-delay",
  "transition-timing-function",
  "animation",
  "animation-duration",
  "animation-delay",
  "animation-timing-function",
]);

const VENDOR_PREFIX = /^-?(?:webkit|moz|ms|o)-/;

/**
 * The motion property `name` spells, in unprefixed kebab case, or undefined:
 * `transitionDuration`, `-webkit-transition`, `WebkitTransition` and
 * `TRANSITION` each name one.
 */
export function motionProperty(name: string): string | undefined {
  const camel = !name.includes("-") && /[a-z]/.test(name);
  const kebab = camel
    ? name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    : name.toLowerCase();
  const bare = kebab.replace(VENDOR_PREFIX, "").replace(/^-(?!-)/, "");
  return MOTION_PROPERTIES.has(bare) ? bare : undefined;
}

/** The Tailwind named easings (`ease-out`) an app's theme sets to its own token. */
export type ThemeEasings = ReadonlySet<string>;

const NO_THEME_EASINGS: ThemeEasings = new Set();

/**
 * Every cire app's stylesheet (`cire/*\/src/styles/global.css`) sets
 * `--ease-out` and `--ease-in-out` in `@theme static`, so there `ease-out` and
 * `ease-in-out` read cire's ladder. No other app sets any `--ease-*`, and none
 * sets `--ease-in`.
 */
const CIRE_THEME_EASINGS: ThemeEasings = new Set(["ease-out", "ease-in-out"]);

/** The named easings whose theme variable the app holding `path` sets. */
export function themeEasingsFor(path: string): ThemeEasings {
  return /(?:^|\/)cire\/[^/]+\/src\//.test(path.replaceAll("\\", "/"))
    ? CIRE_THEME_EASINGS
    : NO_THEME_EASINGS;
}

/** What to do about a finding; both halves end their message with it. */
export const MOTION_ADVICE =
  "Use the motion token for this motion's job, even where its value differs (wiki/shared/design-tokens.md §Motion, or the app's own `--dur-*` and `--ease-*`); outside cire, Tailwind's `ease-out` is its stock curve, so write `ease-(--ui-ease-out)`. A literal no token's job fits stays only with its reason: `/* motion-literal: <reason> */` in a CSS declaration, `{/* motion-literal: <reason> */}` before an Astro tag, `// motion-literal: <reason>` on the line above a class in Astro frontmatter or `<script>`, or `// oxlint-disable-next-line house/no-literal-motion -- <reason>` above a line of TypeScript.";

/** The literals, quoted and joined, for a message. */
export function formatLiterals(literals: readonly string[]): string {
  return literals.map((literal) => `\`${literal}\``).join(", ");
}

// ---------------------------------------------------------------------------
// Values

/** Index of the `)` closing the `(` at `open`, or the end of `text`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/** `text` with every call of `name(…)` that `blankIf` accepts replaced by spaces. */
function blankCalls(text: string, name: string, blankIf: (call: string) => boolean): string {
  const pattern = new RegExp(`(?<![\\w-])${name}\\(`, "g");
  let out = text;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = closingParen(text, start + name.length);
    const call = text.slice(start, end + 1);
    if (blankIf(call)) out = out.slice(0, start) + " ".repeat(call.length) + out.slice(end + 1);
  }
  return out;
}

const TIME = /(?<![\w.-])-?(?:\d+\.?\d*|\.\d+)(?:ms|s)(?![\w-])/gi;
const EASING_FUNCTION = /(?<![\w-])(?:cubic-bezier|steps|linear)\(/gi;
const EASING_KEYWORD =
  /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)(?![\w(-])/gi;
const ALL = /(?<![\w-])all(?![\w-])/gi;

/**
 * The literals in one motion declaration's value, in the order written; empty
 * when `property` is not a motion property or the value reads only tokens.
 */
export function declarationLiterals(property: string, value: string): string[] {
  const name = motionProperty(property.trim());
  if (name === undefined) return [];
  const scaled = blankCalls(value, "calc", (call) => /var\(\s*--motion-scale\b/.test(call));
  const bare = blankCalls(scaled, "var", () => true);

  const found: { readonly at: number; readonly text: string }[] = [];
  for (const match of bare.matchAll(TIME)) {
    if (Number.parseFloat(match[0]) !== 0) found.push({ at: match.index, text: match[0] });
  }
  for (const match of bare.matchAll(EASING_FUNCTION)) {
    const end = closingParen(bare, match.index + match[0].length - 1);
    found.push({ at: match.index, text: bare.slice(match.index, end + 1).replace(/\s+/g, " ") });
  }
  for (const match of bare.matchAll(EASING_KEYWORD)) {
    found.push({ at: match.index, text: match[0] });
  }
  if (name === "transition" || name === "transition-property") {
    for (const match of bare.matchAll(ALL)) found.push({ at: match.index, text: match[0] });
  }
  return found.toSorted((a, b) => a.at - b.at).map((f) => f.text);
}

// ---------------------------------------------------------------------------
// Positions

/** Turns an offset into a 1-based line and column. */
function locator(text: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
  };
}

/** A `motion-literal:` comment body with a reason after the colon. */
function isMarker(body: string): boolean {
  return /^\s*motion-literal:\s*\S/.test(body);
}

/**
 * `text` with each of `ranges` (`[from, to)`, in order, not overlapping)
 * replaced by spaces, newlines kept, built in one pass.
 */
function blankRanges(text: string, ranges: readonly (readonly [number, number])[]): string {
  if (ranges.length === 0) return text;
  const parts: string[] = [];
  let copied = 0;
  for (const [from, to] of ranges) {
    parts.push(text.slice(copied, from), text.slice(from, to).replace(/[^\n]/g, " "));
    copied = to;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

// ---------------------------------------------------------------------------
// CSS

/** CSS text made safe to split, and where its markers are. */
type MaskedCss = {
  /** The text with comments and string contents blanked, offsets kept. */
  readonly masked: string;
  /** Where each marker comment starts. */
  readonly markers: readonly number[];
};

/**
 * CSS text with every comment and the inside of every quoted string blanked,
 * offsets kept, and the start offset of each marker comment.
 */
function maskCss(text: string): MaskedCss {
  const ranges: [number, number][] = [];
  const markers: number[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      if (isMarker(text.slice(i + 2, close === -1 ? text.length : close))) markers.push(i);
      ranges.push([i, end]);
      i = end;
    } else if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== char && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      ranges.push([i + 1, Math.min(j, text.length)]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return { masked: blankRanges(text, ranges), markers };
}

const REDUCED_MOTION = /@media\b[^{]*\bprefers-reduced-motion\s*(?::\s*reduce\b|\))/i;
/** A query that negates or lists: it can match where motion is on. */
const NOT_ONLY_REDUCED = /\bnot\b|,/i;
const DECLARATION = /^\s*(-?[A-Za-z][\w-]*)\s*:/;
const APPLY = /^\s*@apply\b/;

/** Whether an at-rule prelude applies only where the reader asked for reduced motion. */
function onlyReducedMotion(prelude: string): boolean {
  return REDUCED_MOTION.test(prelude) && !NOT_ONLY_REDUCED.test(prelude);
}

/**
 * The offset of the `;` a marker trails on the same line, or undefined when
 * the marker sits inside or above a declaration instead.
 */
function trailedSemicolon(masked: string, marker: number): number | undefined {
  let i = marker - 1;
  while (i >= 0 && (masked[i] === " " || masked[i] === "\t")) i--;
  return masked[i] === ";" ? i : undefined;
}

/** Findings in `text[from, to)`, with offsets into the whole of `text`. */
function cssFindings(text: string, from: number, to: number, themeEasings: ThemeEasings): Found[] {
  const { masked, markers } = maskCss(text.slice(from, to));
  const trailing = markers.map((at) => trailedSemicolon(masked, at));
  const findings: Found[] = [];
  const reduced: boolean[] = [];
  let start = 0;

  /** Whether a marker keeps the declaration in `[start, end)`. */
  const kept = (end: number): boolean =>
    markers.some((at, i) => {
      const trails = trailing[i];
      return trails === undefined ? at >= start && at < end : trails === end;
    });

  const declaration = (end: number): void => {
    if (reduced.at(-1) === true) return;
    const segment = masked.slice(start, end);
    if (APPLY.test(segment)) {
      findings.push(...classFindings(text, from + start, from + end, themeEasings));
      return;
    }
    const match = DECLARATION.exec(segment);
    if (!match?.[1]) return;
    const property = match[1];
    const literals = declarationLiterals(property, segment.slice(match[0].length));
    if (literals.length === 0 || kept(end)) return;
    const at = start + segment.indexOf(property);
    findings.push({
      offset: from + at,
      text: masked.slice(at, end).replace(/\s+/g, " ").trim(),
      literals,
    });
  };

  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if (char === "{") {
      reduced.push(reduced.at(-1) === true || onlyReducedMotion(masked.slice(start, i)));
      start = i + 1;
    } else if (char === ";" || char === "}") {
      declaration(i);
      if (char === "}") reduced.pop();
      start = i + 1;
    }
  }
  declaration(masked.length);
  return findings;
}

/** `found`, positioned by line and column in `text` and in order. */
function positioned(text: string, found: readonly Found[]): MotionFinding[] {
  if (found.length === 0) return [];
  const locate = locator(text);
  return found
    .toSorted((a, b) => a.offset - b.offset)
    .map(({ offset, text: written, literals }) => {
      const { line, column } = locate(offset);
      return { line, column, text: written, literals };
    });
}

/**
 * Every literal motion declaration in a stylesheet. `themeEasings` is
 * `themeEasingsFor` the file's path; it decides the classes an `@apply` writes.
 */
export function checkCss(
  text: string,
  themeEasings: ThemeEasings = NO_THEME_EASINGS,
): MotionFinding[] {
  return positioned(text, cssFindings(text, 0, text.length, themeEasings));
}

// ---------------------------------------------------------------------------
// Tailwind classes

/** `token` split on `:` outside brackets and parentheses. */
function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

/** An arbitrary value as CSS: Tailwind reads `_` as a space. */
function arbitrary(value: string): string {
  return value.replaceAll("_", " ");
}

const NAMED_EASING = /^ease-(?:in|out|in-out)$/;

/**
 * The literals one class token writes; empty for anything else. A named
 * easing (`ease-out`) passes only where `themeEasings` holds it.
 */
export function classLiterals(
  token: string,
  themeEasings: ThemeEasings = NO_THEME_EASINGS,
): string[] {
  const parts = splitVariants(token);
  if (parts.slice(0, -1).includes("motion-reduce")) return [];
  const utility = (parts.at(-1) ?? "").replace(/^!|!$/g, "");

  if (utility === "transition-all") return ["all"];
  let match = /^transition-\[(.+)\]$/.exec(utility);
  if (match?.[1]) return match[1].split(",").includes("all") ? ["all"] : [];
  match = /^(?:duration|delay)-(\d+)$/.exec(utility);
  if (match?.[1]) return Number(match[1]) === 0 ? [] : [`${match[1]}ms`];
  match = /^(duration|delay)-\[(.+)\]$/.exec(utility);
  if (match?.[1] && match[2])
    return declarationLiterals(`transition-${match[1]}`, arbitrary(match[2]));
  if (utility === "ease-linear") return ["linear"];
  if (NAMED_EASING.test(utility)) return themeEasings.has(utility) ? [] : [utility];
  match = /^ease-\[(.+)\]$/.exec(utility);
  if (match?.[1]) return declarationLiterals("transition-timing-function", arbitrary(match[1]));
  match = /^animate-\[(.+)\]$/.exec(utility);
  if (match?.[1]) return declarationLiterals("animation", arbitrary(match[1]));
  match = /^\[([a-z-]+):(.+)\]$/.exec(utility);
  if (match?.[1] && match[2]) return declarationLiterals(match[1], arbitrary(match[2]));
  return [];
}

const CLASS_TOKEN = /[^\s"'`]+/g;

/** Findings among the class tokens of `text[from, to)`, with offsets into all of `text`. */
function classFindings(
  text: string,
  from: number,
  to: number,
  themeEasings: ThemeEasings,
): Found[] {
  const findings: Found[] = [];
  for (const match of text.slice(from, to).matchAll(CLASS_TOKEN)) {
    const literals = classLiterals(match[0], themeEasings);
    if (literals.length > 0)
      findings.push({ offset: from + match.index, text: match[0], literals });
  }
  return findings;
}

/** Every literal motion class in a class string. */
export function checkClassTokens(
  text: string,
  themeEasings: ThemeEasings = NO_THEME_EASINGS,
): MotionFinding[] {
  return positioned(text, classFindings(text, 0, text.length, themeEasings));
}

// ---------------------------------------------------------------------------
// Strings in TypeScript

const CSS_DECLARATION =
  /(?<![[\w-])(?:-(?:webkit|moz|ms|o)-)?(?:transition|animation)(?:-(?:property|duration|delay|timing-function))?\s*:/i;

/**
 * Every literal in a string from source code: read as CSS when it holds a
 * brace or a motion declaration, as a class string otherwise.
 */
export function checkString(
  text: string,
  themeEasings: ThemeEasings = NO_THEME_EASINGS,
): MotionFinding[] {
  return text.includes("{") || CSS_DECLARATION.test(text)
    ? checkCss(text, themeEasings)
    : checkClassTokens(text, themeEasings);
}

/**
 * The literals in one declaration written in code (`style.transition = …`, a
 * style object's value); empty when `property` is not a motion property, or the
 * value carries a marker.
 */
export function checkDeclaration(property: string, value: string): string[] {
  const { masked, markers } = maskCss(value);
  return markers.length > 0 ? [] : declarationLiterals(property, masked);
}

// ---------------------------------------------------------------------------
// Astro

/** A comment in Astro markup: an HTML comment, or a JS comment in braces. */
const MARKUP_COMMENT = /<!--([\s\S]*?)-->|\{\s*\/\*([\s\S]*?)\*\/\s*\}/g;
const BLOCK = /<(style|script)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const STYLE_ATTRIBUTE = /(?<![\w-])style\s*=\s*(["'])([\s\S]*?)\1/g;
/** A line of script that is only a `motion-literal:` comment with a reason. */
const SCRIPT_MARKER = /^\s*(?:\/\/|\/\*)\s*motion-literal:\s*\S/;

/**
 * Every literal in an Astro file: CSS rules in `<style>` blocks; class tokens
 * and `style` attributes in the markup; class tokens in the frontmatter and in
 * `<script>` blocks. In the markup, a `motion-literal:` comment with a reason
 * that ends with only whitespace before a tag keeps that tag's literals; in
 * the frontmatter and `<script>`, a `// motion-literal: <reason>` line keeps
 * the classes on the line below it. `themeEasings` is `themeEasingsFor` the
 * file's path.
 */
export function checkAstro(
  text: string,
  themeEasings: ThemeEasings = NO_THEME_EASINGS,
): MotionFinding[] {
  const found: Found[] = [];
  const lines = text.split("\n");
  const locate = locator(text);

  /** Whether the line above the one holding `offset` is a script marker. */
  const scriptMarked = (offset: number): boolean =>
    SCRIPT_MARKER.test(lines[locate(offset).line - 2] ?? "");

  const script: Found[] = [];
  const blanked: [number, number][] = [];
  const frontmatter = /^﻿?\s*---\r?\n[\s\S]*?\n---[^\n]*/.exec(text);
  if (frontmatter) {
    script.push(...classFindings(text, 0, frontmatter[0].length, themeEasings));
    blanked.push([0, frontmatter[0].length]);
  }

  for (const match of text.matchAll(BLOCK)) {
    const bodyStart = match.index + match[0].indexOf(">") + 1;
    const bodyEnd = bodyStart + (match[2]?.length ?? 0);
    if (match[1]?.toLowerCase() === "style")
      found.push(...cssFindings(text, bodyStart, bodyEnd, themeEasings));
    else script.push(...classFindings(text, bodyStart, bodyEnd, themeEasings));
    blanked.push([match.index, match.index + match[0].length]);
  }
  found.push(...script.filter((finding) => !scriptMarked(finding.offset)));
  let markup = blankRanges(text, blanked);

  /** End offsets of marker comments; every comment is blanked from the markup. */
  const markerEnds = new Set<number>();
  const comments: [number, number][] = [];
  for (const match of markup.matchAll(MARKUP_COMMENT)) {
    if (isMarker(match[1] ?? match[2] ?? "")) markerEnds.add(match.index + match[0].length);
    comments.push([match.index, match.index + match[0].length]);
  }
  markup = blankRanges(markup, comments);

  /** Whether the tag holding `offset` has a marker straight before it. */
  const marked = (offset: number): boolean => {
    let i = markup.lastIndexOf("<", offset);
    if (i === -1) return false;
    while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
    return markerEnds.has(i);
  };

  const inMarkup = classFindings(markup, 0, markup.length, themeEasings);
  for (const match of markup.matchAll(STYLE_ATTRIBUTE)) {
    const valueStart = match.index + match[0].indexOf(match[1] ?? '"') + 1;
    inMarkup.push(
      ...cssFindings(text, valueStart, valueStart + (match[2]?.length ?? 0), themeEasings),
    );
  }
  found.push(...inMarkup.filter((finding) => !marked(finding.offset)));

  return positioned(text, found);
}
