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
 * The `__Host-` form, written whenever the document is on a secure origin.
 *
 * `__Host-` is a browser-enforced promise, not just a naming convention: a
 * cookie carrying it is rejected outright unless it also has `Secure`,
 * `Path=/`, and no `Domain` attribute — which stops a script on a sibling
 * `*.cireweddings.com` origin from setting a same-named `Domain=.cireweddings.com`
 * cookie that could shadow or outrace this one. Without the prefix, a planted
 * domain cookie and our host-only cookie are both valid matches for the plain
 * name, and which one a browser returns first for `document.cookie` is
 * unspecified — so a guest's stored REFUSAL could be silently overridden back
 * to "allowed" by a cookie this site never set. This is osn-tracker#163.
 *
 * `serialiseConsentCookie` already writes `Path=/`, no `Domain`, and `Secure`
 * whenever `secure` is true, so the prefixed form is compatible with the
 * cookie as written today — no attribute needs to change to add it.
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
 * Pull the raw consent value out of a cookie string.
 *
 * Accepts either side's format — they are identical: a request's `Cookie`
 * header and the browser's `document.cookie` are both `a=1; b=2`. One parser
 * therefore serves both the (future) server-side read and the client store.
 *
 * Reads BOTH the prefixed and bare names and prefers the prefixed one when
 * both are present. Two things this buys:
 *
 *  - An existing guest's choice, stored under the bare name before this
 *    change shipped, still reads back correctly on http and survives the
 *    upgrade to `__Host-` on https — there is no migration step, just a
 *    fallback.
 *  - A cookie planted under the bare name by a sibling origin (the attack
 *    `PREFIXED_CONSENT_COOKIE_NAME` exists to stop) can never win once this
 *    site has itself written the prefixed one: the prefixed value always
 *    takes precedence, so the planted cookie is inert as soon as this origin
 *    has made its own secure write.
 */
export function readNamedCookie(
  cookieString: string | null | undefined,
  name: string,
): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function readConsentCookieValue(cookieString: string | null | undefined): string | null {
  if (!cookieString) return null;

  let bareValue: string | null = null;
  let prefixedValue: string | null = null;

  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name === PREFIXED_CONSENT_COOKIE_NAME) {
      prefixedValue = part.slice(separator + 1).trim();
    } else if (name === CONSENT_COOKIE_NAME) {
      bareValue = part.slice(separator + 1).trim();
    }
  }
  return prefixedValue ?? bareValue;
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
 *
 * Writes {@link PREFIXED_CONSENT_COOKIE_NAME} when `secure` is true and the
 * bare {@link CONSENT_COOKIE_NAME} otherwise. `__Host-` cookies are rejected by
 * the browser without `Secure`, so on http dev the prefixed name would simply
 * fail to set — falling back to the bare name there is what keeps consent
 * persisting in local dev at all, matching the `Secure`-dropping trade above.
 */
export function serialiseConsentCookie(record: ConsentRecord, secure: boolean): string {
  const name = secure ? PREFIXED_CONSENT_COOKIE_NAME : CONSENT_COOKIE_NAME;
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
  const secure = isSecureContext();
  try {
    document.cookie = serialiseConsentCookie(record, secure);
    if (secure) expireBareConsentCookie();
  } catch {
    // Storage disabled — consent applies for this visit only.
  }
}

/**
 * Expire the bare-named cookie, leaving the `__Host-` one as the only match.
 *
 * Writing the prefixed name does NOT remove a bare `cire_consent` sitting
 * beside it, and while both exist the ambiguity S-L1 (osn-tracker#163) is
 * about is still there — `readConsentCookieValue` prefers the prefixed one, so
 * this origin is safe, but the shadowing cookie is still in the jar and any
 * reader that does not know the precedence rule can still pick the wrong one.
 * Removing the name outright is the only thing that ends the condition rather
 * than out-running it.
 *
 * Host-only, `Path=/`, no `Domain` — deliberately the same scope this origin
 * writes with, so it clears OUR old cookie and not a sibling's. A page cannot
 * delete a `Domain=.cireweddings.com` cookie set by another origin, and should
 * not try: the read precedence is what defends against that one.
 */
function expireBareConsentCookie(): void {
  document.cookie = `${CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Move an already-decided guest onto the prefixed cookie without asking them
 * anything.
 *
 * The fix for osn-tracker#163 only bites once this origin has written the
 * prefixed name — and for the guests who most need it, that write was never
 * going to happen. `saveConsent` runs only when someone touches the consent UI,
 * and a guest who already decided is precisely the one the banner never shows
 * again: their choice reads back fine through the bare-name fallback, so
 * `needsConsentDecision()` stays false and nothing writes for up to the
 * cookie's full 182 days. Their stored refusal would sit shadowable for six
 * months, which is most of the exposure the finding was filed about.
 *
 * So the migration runs on READ instead. On a secure origin, when the bare name
 * is present and the prefixed one is not, re-write the record under the
 * prefixed name and expire the bare one. The guest is migrated on their next
 * visit and sees nothing. On http dev there is nothing to do — `__Host-` needs
 * `Secure`, so the bare name is the correct and only form there.
 *
 * Best-effort, like every write in this module: a browser that blocks the write
 * leaves the guest exactly where they were, which is the status quo, not a
 * regression.
 */
export function migrateBareConsentCookie(): void {
  if (typeof document === "undefined" || !isSecureContext()) return;
  const cookies = document.cookie;
  if (!cookies.includes(`${CONSENT_COOKIE_NAME}=`)) return;
  // Already on the prefixed name — nothing to move. Checked by parsing rather
  // than substring, because `cire_consent=` is itself a substring of
  // `__Host-cire_consent=`.
  if (readNamedCookie(cookies, PREFIXED_CONSENT_COOKIE_NAME) !== null) return;
  const record = readConsentRecord(cookies);
  if (!record) return;
  try {
    document.cookie = serialiseConsentCookie(record, true);
    expireBareConsentCookie();
  } catch {
    // Blocked — the guest stays on the bare cookie, same as before.
  }
}

/**
 * Write a record and confirm it actually landed, by reading `document.cookie`
 * straight back.
 *
 * `writeConsentToDocument` returns `void` and swallows a blocked write by
 * design (see its doc), so a caller that needs to know whether the write
 * really took — the reload-on-revoke path in `store.ts` (osn-tracker#162) —
 * cannot use "the call returned" as its success signal. A browser that blocks
 * cookies outright, or a Set-Cookie the browser itself rejects (an oversized
 * value, say), leaves `document.cookie` unchanged, and the read-back is the
 * only way to see that from here.
 *
 * Compares the round-tripped record against `record` by RE-encoding both
 * rather than string-matching the raw cookie value, so it does not care which
 * of the two cookie names was actually written.
 */
export function writeConsentToDocumentAndVerify(record: ConsentRecord): boolean {
  writeConsentToDocument(record);
  const readBack = readConsentFromDocument();
  return readBack !== null && encodeConsentRecord(readBack) === encodeConsentRecord(record);
}
