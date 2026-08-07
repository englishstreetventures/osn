import type { ComponentProps, JSX } from "solid-js";

/**
 * Element props, minus the three that write over `children`.
 *
 * Solid's `HTMLAttributes` includes `innerHTML`, `innerText` and `textContent`,
 * and dom-expressions assigns `innerHTML` as markup, unescaped. Any primitive
 * here that spreads its rest props onto an element therefore accepts, and
 * type-checks, `<Notice innerHTML={vendorName} />` — which reads at the call site
 * like ordinary prop passing and is a script tag.
 *
 * None of these components has a use for raw markup: every one of them renders
 * `children`. Taking the props off the type is what makes the mistake a compile
 * error at the call site rather than a silent success. Anything that genuinely
 * needs to write markup has to reach for a bare element and say why.
 */
export type SafeProps<E extends keyof JSX.IntrinsicElements> = Omit<
  ComponentProps<E>,
  "innerHTML" | "innerText" | "textContent"
>;
