import { cardClass } from "@cire/ui/card";

/**
 * The sign-in card, alone on its page: the card's largest padding step on the
 * wash, with the inner lip that lights its top edge. Shared by `login.astro`
 * and the browser test that draws it.
 */
export const LOGIN_CARD_CLASS = `${cardClass({ padding: "xl" })} lip`;
