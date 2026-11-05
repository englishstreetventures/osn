/**
 * An eyebrow over a heading, read from the page: the small-caps line drawn
 * straight above a title. Cire draws one only where it says something the
 * screen does not already — a count, a state, the tier, the portal's name —
 * and never one that repeats the module, the tab or the heading itself
 * (`cire/host/DESIGN.md` §3, "A line earns its place").
 *
 * The reader takes the heading's previous element sibling, the place every
 * eyebrow cire has drawn sits, and calls it an eyebrow when its computed text
 * is upper case and its letter-spacing is at least 0.09 of its size: the
 * portal's `tracking-ui-wider` is 0.1 and `widest`, `Eyebrow`'s, is 0.16. A
 * button, a paragraph or nothing at all reads as "".
 */

import type { Locator } from "@playwright/test";

/** The text of the eyebrow straight above `heading`, or "" when there is none. */
export function eyebrowOver(heading: Locator): Promise<string> {
  return heading.evaluate((el) => {
    const above = el.previousElementSibling;
    if (!above) return "";
    const style = getComputedStyle(above);
    // `normal` parses to NaN, which is not small caps.
    const ratio = Number.parseFloat(style.letterSpacing) / Number.parseFloat(style.fontSize);
    const smallCaps = style.textTransform === "uppercase" && ratio >= 0.09;
    return smallCaps ? (above.textContent ?? "").trim() : "";
  });
}
