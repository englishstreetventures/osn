import { type ConsentRecord, decodeConsentRecord, encodeConsentRecord } from "./record";

/**
 * Cookie transport for the consent record.
 *
 * WHY A COOKIE AND NOT `localStorage` (which is what the old Pinterest-only
 * gate used): a cookie is the only store the *server* can read. Today's two
 * gated embeds both mount inside the click-opened details sheet, so they never
 * appear in server-rendered HTML and localStorage would technically do — but
 * that is a property of where those two components happen to live, not a
 * property of the framework. The moment a third party needs to load from the
 * document `<head>` or from SSR'd markup (an analytics tag, a chat widget, the
 * font `<link>` we'd like to stop shipping to Google), a client-side store is
 * structurally too late: the request has already gone by the time any script
 * reads it. Choosing the cookie now means that case is a code change in one
 * component, not a migration of the whole consent substrate.
 *
 * The consent cookie is itself strictly necessary and needs no consent to set:
 * it exists solely to record and honour the guest's choice, including a refusal.
 * It carries no identifier — just the category booleans and a timestamp.
 *
 * `SameSite=Lax` (not `Strict`): a guest arriving from the couple's emailed
 * link is a cross-site top-level navigation, and `Strict` would withhold the
 * cookie on exactly that first hop, re-prompting someone who already decided.
 * The value is not a credential, so `Lax` costs nothing here. It is deliberately
 * NOT `HttpOnly` — client code has to read and rewrite it.
 */

export const CONSENT_COOKIE_NAME = "cire_consent";

/**
 * Six months. Long enough that a guest checking the invite across a year-long
 * engagement isn't nagged every visit, short enough to match the ~6-month
 * re-ask interval European regulators treat as the reasonable ceiling for
 * "consent stays fresh". A vendor-list change re-prompts sooner regardless, via
 * the policy-version check in `decodeConsentRecord`.
 */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 182;

/**
 * Pull the raw consent value out of a cookie string.
 *
 * Accepts either side's format — they are identical: a request's `Cookie`
 * header and the browser's `document.cookie` are both `a=1; b=2`. One parser
 * therefore serves both the (future) server-side read and the client store.
 */
export function readConsentCookieValue(cookieString: string | null | undefined): string | null {
  if (!cookieString) return null;

  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== CONSENT_COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/** Parse a cookie string straight into a record (or `null` if absent/untrusted). */
export function readConsentRecord(cookieString: string | null | undefined): ConsentRecord | null {
  return decodeConsentRecord(readConsentCookieValue(cookieString));
}

/**
 * Build the `document.cookie` / `Set-Cookie` string for a record.
 *
 * `secure` is a parameter rather than an ambient check because this module is
 * shared by client and (potentially) server callers, and because a `Secure`
 * cookie is silently DROPPED on `http://localhost` — which would make consent
 * appear not to persist in local dev while working fine in production, the most
 * annoying class of bug to chase.
 */
export function serialiseConsentCookie(record: ConsentRecord, secure: boolean): string {
  const attributes = [
    `${CONSENT_COOKIE_NAME}=${encodeConsentRecord(record)}`,
    "Path=/",
    `Max-Age=${CONSENT_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Is the current document on a secure origin? Drives the `Secure` attribute. */
function isSecureContext(): boolean {
  return typeof location !== "undefined" && location.protocol === "https:";
}

/** Read the record from `document.cookie`. Returns `null` outside a browser. */
export function readConsentFromDocument(): ConsentRecord | null {
  if (typeof document === "undefined") return null;
  return readConsentRecord(document.cookie);
}

/**
 * Persist a record to `document.cookie`. Best-effort: a browser configured to
 * block cookies outright throws or silently no-ops, and that must not break the
 * page — the in-memory signal still governs the current visit, the guest just
 * gets asked again next time. Failing closed (not remembering an acceptance) is
 * the safe direction.
 */
export function writeConsentToDocument(record: ConsentRecord): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = serialiseConsentCookie(record, isSecureContext());
  } catch {
    // Storage disabled — consent applies for this visit only.
  }
}
