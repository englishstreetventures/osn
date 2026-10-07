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
 * The `__Host-` form: the only consent cookie on a secure origin, written and
 * read there to the exclusion of the bare name.
 *
 * `__Host-` is a browser-enforced promise, not just a naming convention: a
 * cookie carrying it is rejected outright unless it also has `Secure`,
 * `Path=/`, and no `Domain` attribute — which stops a script on a sibling
 * `*.cireweddings.com` origin from setting a same-named `Domain=.cireweddings.com`
 * cookie that could shadow or outrace this one. Without the prefix, a planted
 * domain cookie and our host-only cookie are both valid matches for the plain
 * name, and which one a browser returns first for `document.cookie` is
 * unspecified — so a guest's stored REFUSAL could be silently overridden back
 * to "allowed" by a cookie this site never set. That is why a secure origin
 * never reads the bare name at all: a bare `cire_consent` there may have been
 * planted, and nothing on the page can tell.
 */
export const PREFIXED_CONSENT_COOKIE_NAME = `__Host-${CONSENT_COOKIE_NAME}`;

/**
 * Six months. Long enough that a guest checking the invite across a year-long
 * engagement isn't nagged every visit, short enough to match the ~6-month
 * re-ask interval European regulators treat as the reasonable ceiling for
 * "consent stays fresh". A vendor-list change re-prompts sooner regardless, via
 * the policy-version check in `decodeConsentRecord`.
 */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 182;

/**
 * The name the consent cookie has on an origin: the `__Host-` form on https,
 * the bare form on http, where `__Host-` cookies are rejected outright (local
 * dev). One name per origin, for writing and reading alike.
 */
function consentCookieName(secure: boolean): string {
  return secure ? PREFIXED_CONSENT_COOKIE_NAME : CONSENT_COOKIE_NAME;
}

/** The value of the cookie called exactly `name`, or `null`. */
function readNamedCookie(cookieString: string | null | undefined, name: string): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * Pull the raw consent value out of a cookie string.
 *
 * Accepts either side's format — they are identical: a request's `Cookie`
 * header and the browser's `document.cookie` are both `a=1; b=2`. One parser
 * therefore serves both the (future) server-side read and the client store.
 *
 * Reads only the name the origin writes ({@link consentCookieName}). On https
 * a bare `cire_consent` is ignored even when it is the only consent cookie
 * present: a sibling origin can plant one, and honouring it — or carrying it
 * over onto the `__Host-` name — would let that origin decide for the guest.
 * A guest whose choice exists only under the bare name is asked again.
 */
export function readConsentCookieValue(
  cookieString: string | null | undefined,
  secure: boolean,
): string | null {
  return readNamedCookie(cookieString, consentCookieName(secure));
}

/** Parse a cookie string straight into a record (or `null` if absent/untrusted). */
export function readConsentRecord(
  cookieString: string | null | undefined,
  secure: boolean,
): ConsentRecord | null {
  return decodeConsentRecord(readConsentCookieValue(cookieString, secure));
}

/**
 * Build the `document.cookie` / `Set-Cookie` string for a record.
 *
 * `secure` is a parameter rather than an ambient check because this module is
 * shared by client and (potentially) server callers, and because a `Secure`
 * cookie is silently DROPPED on `http://localhost` — which would make consent
 * appear not to persist in local dev while working fine in production, the most
 * annoying class of bug to chase.
 *
 * Writes under {@link consentCookieName}: the `__Host-` name when `secure`,
 * the bare name otherwise. `__Host-` cookies are rejected by the browser
 * without `Secure`, so on http dev the prefixed name would simply fail to set
 * — the bare name there is what keeps consent persisting in local dev at all,
 * matching the `Secure`-dropping trade above.
 */
export function serialiseConsentCookie(record: ConsentRecord, secure: boolean): string {
  const name = consentCookieName(secure);
  const attributes = [
    `${name}=${encodeConsentRecord(record)}`,
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
  return readConsentRecord(document.cookie, isSecureContext());
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

/**
 * Write a record and confirm it actually landed, by reading `document.cookie`
 * straight back.
 *
 * `writeConsentToDocument` returns `void` and swallows a blocked write by
 * design (see its doc), so a caller that needs to know whether the write
 * really took — the reload-on-revoke path in `store.ts`, which reloads the
 * page after a revoke of a category under which an embed that runs code in
 * this page rendered, so that code's globals, listeners and timers stop —
 * cannot use "the call returned" as its success signal. A browser
 * that blocks cookies outright, or a Set-Cookie the browser itself rejects
 * (an oversized value, say), leaves `document.cookie` unchanged, and the
 * read-back is the only way to see that from here.
 *
 * Compares the round-tripped record against `record` by RE-encoding both
 * rather than string-matching the raw cookie value.
 */
export function writeConsentToDocumentAndVerify(record: ConsentRecord): boolean {
  writeConsentToDocument(record);
  const readBack = readConsentFromDocument();
  return readBack !== null && encodeConsentRecord(readBack) === encodeConsentRecord(record);
}
