/**
 * The codemod's contract, as claims rather than as a sample of its output.
 *
 * Two of these guard the cases where a wrong answer is worse than no codemod
 * at all — a computed value snapped to a step deletes a feature organisers pay
 * for, and a `data-[…]` variant treated as a value corrupts behaviour rather
 * than appearance. Both are cheap to get wrong with a looser pattern, and
 * neither would be obvious in a 1,000-site diff.
 */

import { describe, expect, test } from "bun:test";

import { rewriteScales } from "../codemod-scale";

describe("rewriteScales", () => {
  test("maps a bracketed size onto its contract step", () => {
    const { source, rewrites } = rewriteScales('<p class="text-[0.72rem] font-body">x</p>');
    expect(source).toBe('<p class="text-ui-xs font-body">x</p>');
    expect(rewrites).toEqual([{ from: "text-[0.72rem]", to: "text-ui-xs" }]);
  });

  test("maps all three scales the contract publishes", () => {
    const { source } = rewriteScales('class="text-[0.9rem] tracking-[0.1em] leading-[1.4]"');
    expect(source).toBe('class="text-ui-base tracking-ui-wider leading-ui-snug"');
  });

  test("leaves a computed value alone, and says so", () => {
    // The case that would delete a feature: the bracket body reads a custom
    // property an organiser sets, so there is no single size to snap to.
    const input = 'class="text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]"';
    const { source, rewrites, skipped } = rewriteScales(input);
    expect(source).toBe(input);
    expect(rewrites).toEqual([]);
    expect(skipped).toEqual([
      { value: "text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]", why: "computed" },
    ]);
  });

  test("leaves a bare clamp alone too — a range is not a step", () => {
    const input = 'class="text-[clamp(2rem,5vw,3rem)]"';
    expect(rewriteScales(input).source).toBe(input);
  });

  test("never rewrites a variant's own bracket, which only shares the syntax", () => {
    // `data-[state=open]:` and friends are selectors. Rewriting one changes
    // WHEN a rule applies, not how something looks — far harder to spot. What
    // protects them is that no variant is named `text`, `tracking` or
    // `leading`, so the utility list is the guard rather than a boundary.
    const input = 'class="aria-[invalid=true]:border-error supports-[display:grid]:grid"';
    expect(rewriteScales(input).source).toBe(input);
  });

  test("rewrites the value a variant is applied to, leaving the variant intact", () => {
    // Both brackets on one class, and only one of them is a size.
    const { source } = rewriteScales('class="data-[state=open]:text-[0.9rem]"');
    expect(source).toBe('class="data-[state=open]:text-ui-base"');
  });

  test("still rewrites a value that a variant is applied to", () => {
    // The variant is the prefix; the VALUE after the colon is fair game.
    const { source } = rewriteScales('class="md:text-[0.9rem] hover:tracking-[0.1em]"');
    expect(source).toBe('class="md:text-ui-base hover:tracking-ui-wider"');
  });

  test("leaves a value the table has no entry for, and counts it", () => {
    // `em` is relative to the parent's size, so it is a different thing from
    // the `rem` steps the scale is written in. An unmapped value is a gap in
    // the table — a decision for whoever owns the scale, not a rounding.
    const input = 'class="text-[1em]"';
    const { source, skipped } = rewriteScales(input);
    expect(source).toBe(input);
    expect(skipped).toEqual([{ value: "text-[1em]", why: "unmapped" }]);
  });

  test("does not match a bracket inside a longer identifier", () => {
    const input = 'class="context-[0.9rem] subtext-[0.9rem]"';
    expect(rewriteScales(input).source).toBe(input);
  });

  test("is idempotent — a second run over its own output changes nothing", () => {
    const once = rewriteScales('class="text-[0.72rem] tracking-[0.1em] leading-[1.4]"');
    const twice = rewriteScales(once.source);
    expect(twice.source).toBe(once.source);
    expect(twice.rewrites).toEqual([]);
  });

  test("rewrites every occurrence, not just the first", () => {
    const { rewrites } = rewriteScales(
      'a class="text-[0.72rem]" b class="text-[0.72rem]" c class="text-[0.9rem]"',
    );
    expect(rewrites).toHaveLength(3);
  });

  test("maps the table's own entries without exception", async () => {
    // The table is the decision and this file only carries it out, so the one
    // thing worth asserting across all of it is that nothing in it is
    // unreachable — a typo'd key would otherwise sit there looking applied.
    const { SCALE_MIGRATION } = await import("../../shared/design-tokens/src/index");
    const unreachable: string[] = [];
    for (const [scale, table] of Object.entries(SCALE_MIGRATION)) {
      for (const [from, to] of Object.entries(table)) {
        const { source } = rewriteScales(`class="${scale}-[${from}]"`);
        if (source !== `class="${scale}-ui-${to}"`) unreachable.push(`${scale}-[${from}]`);
      }
    }
    expect(unreachable).toEqual([]);
  });
});
