// Coming back from connecting a Stripe account the couple already have.
//
// cire-api's callback (`/api/organiser/stripe/oauth/callback`) exchanged the
// code with Stripe and stored the account, or refused, and sent the browser to
// `/?stripe_connect=<outcome>#/w/<wedding>/registry/settings`. The code and the
// state never reach the portal. This reads the one word, says what it means,
// and strips it.
//
// NOTHING HERE GRANTS ANYTHING. The registry settings the panel shows come from
// the API as stored; a hand-typed `?stripe_connect=connected` only shows a
// message.

const PARAM = "stripe_connect";

/** The outcome in a URL's query, or `null` when there is none. */
export function readStripeConnectReturn(search: string): string | null {
  const value = new URLSearchParams(search).get(PARAM);
  return value ? value : null;
}

/**
 * Strip the word, keeping everything else. Required, not tidiness:
 * `OrganiserApp` rebuilds the URL as `pathname + search + hash` on every hash
 * write and the login bounce carries `search` through, so a word left here is
 * said again on every later navigation.
 */
export function clearStripeConnectParam(url: URL): string {
  const next = new URL(url.href);
  next.searchParams.delete(PARAM);
  return `${next.pathname}${next.search}${next.hash}`;
}

/** What the toast says, and whether it is good news. */
export interface StripeConnectWords {
  ok: boolean;
  text: string;
}

export function stripeConnectWords(outcome: string): StripeConnectWords {
  switch (outcome) {
    case "connected":
      return {
        ok: true,
        text: "Your Stripe account is connected. Gifts go straight to it, and you run it in your own Stripe Dashboard.",
      };
    case "denied":
      return {
        ok: false,
        text: "You didn’t connect a Stripe account. Connect one whenever you like.",
      };
    case "expired":
      return {
        ok: false,
        text: "That Stripe sign-in had run out or was already used. Connect again to try once more.",
      };
    case "signed_out":
      return {
        ok: false,
        text: "You were signed out while on Stripe. Connect again now you’re back.",
      };
    case "forbidden":
      return {
        ok: false,
        text: "Only the wedding’s owner can connect the account gifts are paid into.",
      };
    case "already_connected":
      return {
        ok: false,
        text: "This wedding already has a Stripe account — someone connected one while you were on Stripe.",
      };
    case "rejected":
      return {
        ok: false,
        text: "Stripe didn’t accept that connection. Connect again to try once more.",
      };
    case "currency_mismatch":
      return {
        ok: false,
        text: "That Stripe account pays out in a different currency from this wedding, so it can’t take its gifts.",
      };
    case "owners_differ":
      return {
        ok: false,
        text: "That Stripe account already takes gifts for a wedding with different owners, so it can’t be used here.",
      };
    case "unavailable":
      return {
        ok: false,
        text: "Couldn’t finish connecting with Stripe just now. Try again in a moment.",
      };
    default:
      return { ok: false, text: "Your Stripe account wasn’t connected. Try again in a moment." };
  }
}
