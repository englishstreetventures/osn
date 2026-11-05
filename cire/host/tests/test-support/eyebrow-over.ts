/**
 * An eyebrow over a heading, read from the rendered page: the small-caps line
 * drawn straight above a title. Cire draws one only where it says something
 * the screen does not already — a count, a state, the tier, the portal's name —
 * and never one that repeats the module, the tab or the heading itself
 * (`cire/host/DESIGN.md` §3, "An eyebrow over a heading says what the screen
 * does not").
 *
 * The reader takes the heading's previous element sibling, the place every
 * eyebrow cire has drawn sits, and calls it an eyebrow when its computed text
 * is upper case and its letter-spacing is at least 0.09 of its size: the
 * portal's `tracking-ui-wider` is 0.1 and `widest`, `Eyebrow`'s, is 0.16. A
 * button, a paragraph or nothing at all reads as "".
 *
 * One reader for every tier: the host's and the vendor portal's browser tests
 * call it on an element, and the end-to-end suite hands it to Playwright's
 * `evaluate`, which runs the function's source in the page. So it uses nothing
 * but the page's own globals and imports nothing.
 */
export function eyebrowOver(heading: Element): string {
  const above = heading.previousElementSibling;
  if (!above) return "";
  const style = getComputedStyle(above);
  // `normal` parses to NaN, which is not small caps.
  const ratio = Number.parseFloat(style.letterSpacing) / Number.parseFloat(style.fontSize);
  return style.textTransform === "uppercase" && ratio >= 0.09
    ? (above.textContent ?? "").trim()
    : "";
}
