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

/**
 * What the toast says, and its tone: `success` for a connection, `info` for an
 * owner who chose not to connect on Stripe's page, `error` for a refusal.
 */
export interface StripeConnectWords {
  tone: "success" | "info" | "error";
  text: string;
}

export function stripeConnectWords(outcome: string): StripeConnectWords {
  switch (outcome) {
    case "connected":
      return {
        tone: "success",
        text: "Your Stripe account is connected. Gifts go straight to it, and you run it in your own Stripe Dashboard.",
      };
    case "denied":
      return {
        tone: "info",
        text: "You didn’t connect a Stripe account. Connect one whenever you like.",
      };
    case "expired":
      return {
        tone: "error",
        text: "That Stripe sign-in had run out or was already used. Connect again to try once more.",
      };
    case "signed_out":
      return {
        tone: "error",
        text: "You were signed out while on Stripe. Connect again now you’re back.",
      };
    case "forbidden":
      return {
        tone: "error",
        text: "Only the wedding’s owner can connect the account gifts are paid into.",
      };
    case "already_connected":
      return {
        tone: "error",
        text: "This wedding already has a Stripe account — someone connected one while you were on Stripe.",
      };
    case "rejected":
      return {
        tone: "error",
        text: "Stripe didn’t accept that connection. Connect again to try once more.",
      };
    case "currency_mismatch":
      return {
        tone: "error",
        text: "That Stripe account pays out in a different currency from this wedding, so it can’t take its gifts.",
      };
    case "owners_differ":
      return {
        tone: "error",
        text: "That Stripe account already takes gifts for a wedding with different owners, so it can’t be used here.",
      };
    case "account_on_deleted_wedding":
      return {
        tone: "error",
        text: "That Stripe account is still on a wedding that is being deleted. It can take this one’s gifts once that wedding is gone for good, or restore that wedding.",
      };
    case "unavailable":
      return {
        tone: "error",
        text: "Couldn’t finish connecting with Stripe just now. Try again in a moment.",
      };
    default:
      return {
        tone: "error",
        text: "Your Stripe account wasn’t connected. Try again in a moment.",
      };
  }
}
