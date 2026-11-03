import { cardClass } from "./card";

/**
 * The sign-in card: the opaque card at the largest padding, its top edge lit
 * by the app's `--inner-lip`, the portals' `lip`. A module of its
 * own, so `SignInPanel`, the island inside the card, ships no card code to the
 * browser: only `sign-in-card.astro`, at build time, reads it.
 */
export const signInCardClass = `${cardClass({ padding: "xl", fill: "opaque" })} base:shadow-(--inner-lip)`;
