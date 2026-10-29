/**
 * The text a screen reader reads as a control's description: the text of each
 * element its `aria-describedby` names, in order, joined by a space. jsdom
 * computes no accessible description, and this package has no jest-dom, so
 * the unit tier reads it the way the browser builds it from `aria-describedby`.
 * An id that names nothing adds nothing, as in the browser.
 */
export function description(el: Element): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
    .filter(Boolean)
    .join(" ");
}
