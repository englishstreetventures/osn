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
 * Nothing inside `@media (prefers-reduced-motion: reduce)` is a literal: the
 * near-zero durations there switch motion off rather than time it. A
 * declaration also passes when its own text holds a
 * `/* motion-literal: <reason> *\/` comment with a reason: the house form for
 * a literal no token of its job can replace.
 *
 * A Tailwind class is judged by what it compiles to (Tailwind 4.3):
 * `duration-200` and `delay-150` write the number, `ease-linear` writes
 * `linear`, and arbitrary values (`duration-[…]`, `ease-[…]`, `animate-[…]`,
 * `[transition:…]`) write what is in the brackets; `ease-in`, `ease-out` and
 * `ease-in-out` compile to the app's `--ease-*` theme token and pass, as every
 * named `animate-*` does. `transition-all` is `transition-property: all`.
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

/** The kebab-case motion property `name` spells (`transitionDuration` too), or undefined. */
export function motionProperty(name: string): string | undefined {
  const kebab = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return MOTION_PROPERTIES.has(kebab) ? kebab : undefined;
}

/** What to do about a finding; both halves end their message with it. */
export const MOTION_ADVICE =
  "Use the motion token for this motion's job (wiki/shared/design-tokens.md §Motion, or the app's own `--dur-*` and `--ease-*`), never the token nearest the number. A literal no token of its job can replace stays only with its reason: `/* motion-literal: <reason> */` in CSS, `{/* motion-literal: <reason> */}` before an Astro tag, or `// oxlint-disable-next-line house/no-literal-motion -- <reason>` above a class string.";

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
const EASING_FUNCTION = /(?<![\w-])(?:cubic-bezier|steps|linear)\(/g;
const EASING_KEYWORD =
  /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)(?![\w(-])/g;
const ALL = /(?<![\w-])all(?![\w-])/g;

/**
 * The literals in one motion declaration's value, in the order written; empty
 * when `property` is not a motion property or the value reads only tokens.
 */
export function declarationLiterals(property: string, value: string): string[] {
  const name = motionProperty(property.trim());
  if (name === undefined) return [];
  const scaled = blankCalls(value, "calc", (call) => call.includes("var(--motion-scale"));
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

/** `text` with `[from, to)` replaced by spaces, newlines kept. */
function blankRange(text: string, from: number, to: number): string {
  return text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);
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
  let masked = text;
  const markers: number[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      if (isMarker(text.slice(i + 2, close === -1 ? text.length : close))) markers.push(i);
      masked = blankRange(masked, i, end);
      i = end;
    } else if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== char && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      masked = blankRange(masked, i + 1, Math.min(j, text.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return { masked, markers };
}

const REDUCED_MOTION = /@media\b[^{]*\bprefers-reduced-motion\s*(?::\s*reduce\b|\))/i;
const DECLARATION = /^\s*(-?[A-Za-z][\w-]*)\s*:/;
const APPLY = /^\s*@apply\b/;

/** Findings in `text[from, to)`, with offsets into the whole of `text`. */
function cssFindings(text: string, from: number, to: number): Found[] {
  const { masked, markers } = maskCss(text.slice(from, to));
  const findings: Found[] = [];
  const reduced: boolean[] = [];
  let start = 0;

  const declaration = (end: number): void => {
    if (reduced.at(-1) === true) return;
    const segment = masked.slice(start, end);
    if (APPLY.test(segment)) {
      findings.push(...classFindings(text, from + start, from + end));
      return;
    }
    const match = DECLARATION.exec(segment);
    if (!match?.[1]) return;
    const property = match[1];
    const literals = declarationLiterals(property, segment.slice(match[0].length));
    if (literals.length === 0) return;
    if (markers.some((at) => at >= start && at < end)) return;
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
      reduced.push(reduced.at(-1) === true || REDUCED_MOTION.test(masked.slice(start, i)));
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
  const locate = locator(text);
  return found
    .toSorted((a, b) => a.offset - b.offset)
    .map(({ offset, text: written, literals }) => {
      const { line, column } = locate(offset);
      return { line, column, text: written, literals };
    });
}

/** Every literal motion declaration in a stylesheet. */
export function checkCss(text: string): MotionFinding[] {
  return positioned(text, cssFindings(text, 0, text.length));
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

/** The literals one class token writes; empty for anything else. */
export function classLiterals(token: string): string[] {
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
function classFindings(text: string, from: number, to: number): Found[] {
  const findings: Found[] = [];
  for (const match of text.slice(from, to).matchAll(CLASS_TOKEN)) {
    const literals = classLiterals(match[0]);
    if (literals.length > 0)
      findings.push({ offset: from + match.index, text: match[0], literals });
  }
  return findings;
}

/** Every literal motion class in a class string. */
export function checkClassTokens(text: string): MotionFinding[] {
  return positioned(text, classFindings(text, 0, text.length));
}

// ---------------------------------------------------------------------------
// Strings in TypeScript

const CSS_DECLARATION =
  /(?<![[\w-])(?:transition|animation)(?:-(?:property|duration|delay|timing-function))?\s*:/;

/**
 * Every literal in a string from source code: read as CSS when it holds a
 * brace or a motion declaration, as a class string otherwise.
 */
export function checkString(text: string): MotionFinding[] {
  return text.includes("{") || CSS_DECLARATION.test(text) ? checkCss(text) : checkClassTokens(text);
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

/**
 * Every literal in an Astro file: CSS rules in `<style>` blocks; class tokens
 * and `style` attributes in the markup; class tokens in the frontmatter and in
 * `<script>` blocks. In the markup, a `motion-literal:` comment with a reason
 * that ends with only whitespace before a tag keeps that tag's literals.
 */
export function checkAstro(text: string): MotionFinding[] {
  const found: Found[] = [];
  let markup = text;

  const frontmatter = /^\uFEFF?\s*---\r?\n[\s\S]*?\n---[^\n]*/.exec(text);
  if (frontmatter) {
    found.push(...classFindings(text, 0, frontmatter[0].length));
    markup = blankRange(markup, 0, frontmatter[0].length);
  }

  for (const match of text.matchAll(BLOCK)) {
    const bodyStart = match.index + match[0].indexOf(">") + 1;
    const bodyEnd = bodyStart + (match[2]?.length ?? 0);
    if (match[1]?.toLowerCase() === "style") found.push(...cssFindings(text, bodyStart, bodyEnd));
    else found.push(...classFindings(text, bodyStart, bodyEnd));
    markup = blankRange(markup, match.index, match.index + match[0].length);
  }

  /** End offsets of marker comments; every comment is blanked from the markup. */
  const markerEnds = new Set<number>();
  for (const match of markup.matchAll(MARKUP_COMMENT)) {
    if (isMarker(match[1] ?? match[2] ?? "")) markerEnds.add(match.index + match[0].length);
    markup = blankRange(markup, match.index, match.index + match[0].length);
  }

  /** Whether the tag holding `offset` has a marker straight before it. */
  const marked = (offset: number): boolean => {
    let i = markup.lastIndexOf("<", offset);
    if (i === -1) return false;
    while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
    return markerEnds.has(i);
  };

  const inMarkup = classFindings(markup, 0, markup.length);
  for (const match of markup.matchAll(STYLE_ATTRIBUTE)) {
    const valueStart = match.index + match[0].indexOf(match[1] ?? '"') + 1;
    inMarkup.push(...cssFindings(text, valueStart, valueStart + (match[2]?.length ?? 0)));
  }
  found.push(...inMarkup.filter((finding) => !marked(finding.offset)));

  return positioned(text, found);
}
