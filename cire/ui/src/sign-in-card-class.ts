import { cardClass } from "./card";

/**
 * The sign-in card: the opaque card at the largest padding, its top edge lit
 * by the app's `--inner-lip`, the portals' `lip`. A module of its
 * own, so `SignInPanel`, the island inside the card, ships no card code to the
 * browser: only `sign-in-card.astro`, at build time, reads it.
 */
export const signInCardClass = `${cardClass({ padding: "xl", fill: "opaque" })} base:shadow-(--inner-lip)`;

/**
 * The sign-in page's frame, header and heading, beside its card, so a page in
 * the same shape (the host portal's page after a person removes their Cire
 * data) takes them from here and does not copy them. The frame sits at the
 * top of the page at a 30rem measure; the heading's size reads the page's
 * container, so the page's `<body>` carries `@container/frame`.
 *
 * The heading's class sets the face, ink, size and weight, and no line
 * height: a heading on one line takes `leading-ui-none`, as "Sign in" does,
 * and one that can wrap takes `leading-ui-tight` (`cire/host/DESIGN.md` §3).
 */
export const signInFrameClass = "page-frame py-24 [--page-max:30rem]";
export const signInHeaderClass = "mb-8 flex flex-col gap-1.5 text-center";
export const signInTitleClass =
  "font-ui-display text-ui-ink text-[clamp(1.9rem,5cqi,2.6rem)] font-light";
