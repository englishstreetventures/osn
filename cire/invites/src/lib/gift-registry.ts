/**
 * Guest-side client for the gift registry.
 *
 * NAMING: everything this feature adds to the guest site carries the
 * `gift-registry` / `GiftRegistry*` prefix. `src/designs/registry.ts` is the
 * invite DESIGN-PACK map and predates this module — an unrelated use of the
 * word. Nothing here may be called `Registry*`, and no gift code belongs under
 * `src/designs/`.
 *
 * The list read itself, and the shape of the list, are in `gift-registry-read.ts`;
 * what the list looks like is in `gift-registry-display.ts`. The invitation
 * needs only those two, so it never downloads this module: the claim, release
 * and money calls here belong to the gift list's own page.
 *
 * Two properties this module exists to keep:
 *
 *  1. **Every credentialed call passes `credentials: "include"`.** `cire_session`
 *     is HttpOnly and host-scoped to the API ORIGIN, which is a different origin
 *     from the guest site. A cross-origin `fetch` on the default `same-origin`
 *     mode drops the cookie silently — no error, just no session, and the call
 *     reads as "signed out" forever.
 *  2. **Failures are values, not throws, and they are told apart.** The 409
 *     "someone else took the last one" race is the ORDINARY case here, not an
 *     edge: two guests tapping the last item at the same moment is what a shared
 *     invite link produces. It must reach the caller as its own result so the UI
 *     can refetch the counts and say what happened, rather than being swallowed
 *     into a generic "something went wrong" — or worse, optimistically reported
 *     as a success.
 */

import { giftRegistryBase, type GiftRegistryItem } from "./gift-registry-read";

/** Mirrors `HouseholdClaimDto`'s `status` (a released claim is never returned). */
export type GiftRegistryClaimStatus = "reserved" | "purchased";

/** Mirrors `HouseholdClaimDto` — THIS household's own claim on one item. */
export interface GiftRegistryHouseholdClaim {
  itemId: string;
  quantity: number;
  status: GiftRegistryClaimStatus;
  note: string | null;
  displayName: string | null;
}

/**
 * Mirrors `HouseholdRegistryDto`. `shippingAddress` is OPTIONAL on the wire and
 * carries no reason field: absent means "you may not see it yet" and "the couple
 * never set one" at once, deliberately. The UI renders it only when present and
 * says nothing at all otherwise — inventing a reason here would be inventing
 * data the API declined to give.
 *
 * `preview` is present only for the wedding's host preview household — the
 * organiser's "Preview invite" session — which reads the list and never writes
 * to it. The page then shows the controls a guest sees, without offering them.
 */
export interface GiftRegistryHousehold {
  claims: GiftRegistryHouseholdClaim[];
  shippingAddress?: string;
  preview?: true;
}

/**
 * The code a write answers the host preview household with (403). Read by its
 * code, never its status: the origin guard answers 403 too.
 */
const PREVIEW_READ_ONLY = "preview_read_only";

/** The household read. `signed-out` is the 401 that a guest with no claim gets. */
export type GiftRegistryHouseholdFetch =
  | { kind: "ok"; household: GiftRegistryHousehold }
  | { kind: "signed-out" }
  | { kind: "hidden" }
  | { kind: "error" };

/**
 * A claim or a release. Every branch the guest UI has to say something different
 * about is its own member:
 *
 *  - `fully-claimed` — 409 `item_fully_claimed`. The race. Refetch and tell them.
 *  - `item-gone`     — 404 `registry_item_not_found`. The couple removed it (or
 *                      this cookie belongs to another wedding, which the API
 *                      answers identically on purpose).
 *  - `hidden`        — 404 `registry_not_found`. The registry was unpublished
 *                      while this page was open.
 *  - `signed-out`    — 401. The 30-day household session lapsed mid-visit.
 *  - `rate-limited`  — 429, with the server's `retry-after` in seconds when it
 *                      sent a usable one.
 *  - `preview`       — 403 `preview_read_only`. The organiser's preview session,
 *                      from a page that did not know it was one.
 */
export type GiftRegistryWrite =
  | { kind: "ok" }
  | { kind: "fully-claimed" }
  | { kind: "item-gone" }
  | { kind: "hidden" }
  | { kind: "signed-out" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "invalid" }
  | { kind: "preview" }
  | { kind: "error" };

/** Body of a claim POST. Every field is optional server-side; quantity defaults to 1. */
export interface GiftRegistryClaimBody {
  quantity?: number;
  status?: GiftRegistryClaimStatus;
  note?: string | null;
  displayName?: string | null;
}

/** The server's own bound (`ClaimItemBody`: 1..99). Mirrored for the input's `max`. */
export const GIFT_REGISTRY_MAX_QUANTITY = 99;

/**
 * Read the `error` code out of a response body without letting a non-JSON body
 * (an HTML error page from a proxy, an empty 404) become a throw. Returns `null`
 * when there is no readable code — callers then fall back on the status alone.
 */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** Map a non-OK write response onto the union above. */
async function writeFailure(res: Response): Promise<GiftRegistryWrite> {
  if (res.status === 401) return { kind: "signed-out" };
  if (res.status === 429) {
    // `retry-after` is seconds here (the shared limiter sends `"60"`). A missing
    // or unparseable header is `null` rather than a guessed number — the UI says
    // "try again in a moment" instead of naming a duration nobody promised.
    const raw = res.headers.get("retry-after");
    const seconds = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return {
      kind: "rate-limited",
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    };
  }
  if (res.status === 409) {
    // Only one 409 exists on these routes, but read the code anyway so a future
    // conflict cannot silently inherit the "someone took the last one" copy.
    return (await errorCode(res)) === "item_fully_claimed"
      ? { kind: "fully-claimed" }
      : { kind: "error" };
  }
  if (res.status === 404) {
    return (await errorCode(res)) === "registry_item_not_found"
      ? { kind: "item-gone" }
      : { kind: "hidden" };
  }
  if (res.status === 400) return { kind: "invalid" };
  if (res.status === 403 && (await errorCode(res)) === PREVIEW_READ_ONLY) {
    return { kind: "preview" };
  }
  return { kind: "error" };
}

/**
 * This household's own claims (and the shipping address, when the couple has
 * released it). Credentialed — see the module header.
 */
export async function fetchGiftRegistryHousehold(
  apiUrl: string,
  slug: string,
): Promise<GiftRegistryHouseholdFetch> {
  try {
    const res = await fetch(`${giftRegistryBase(apiUrl, slug)}/mine`, {
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 401) return { kind: "signed-out" };
    if (res.status === 404) return { kind: "hidden" };
    if (!res.ok) return { kind: "error" };
    return { kind: "ok", household: (await res.json()) as GiftRegistryHousehold };
  } catch {
    return { kind: "error" };
  }
}

/**
 * What a "give money" request can answer.
 *
 * `unavailable` is the 409: the couple are not taking money right now — they
 * never turned it on, Stripe cannot take a charge today, or there is no
 * connected account. One code for all three, because to a guest they are the
 * same fact and none of them is theirs to fix.
 *
 * `preview` is the 403 `preview_read_only`: the organiser's preview session,
 * which never gives.
 *
 * `fund-closed` is the 409 `fund_unavailable`: the fund the guest chose is no
 * longer on the couple's list. The page re-reads the list.
 */
export type GiftContributionResult =
  | { kind: "ok"; url: string }
  | { kind: "unavailable" }
  | { kind: "fund-closed" }
  | { kind: "signed-out" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "invalid" }
  | { kind: "preview" }
  | { kind: "error" };

/** What a guest is giving, and what they want said with it. */
export interface GiftContributionBody {
  /** Minor units of the wedding's currency. */
  amountMinor: number;
  /** Giving to one of the couple's cash funds, rather than in general. */
  itemId?: string | null;
  message?: string | null;
  displayName?: string | null;
}

/**
 * Ask for a hosted payment page.
 *
 * Returns a URL to SEND the guest to; it never navigates. Payment is a hand-off
 * to Stripe, and the moment of leaving the page belongs to the component that
 * knows what else is on it — not to the client that fetched the link.
 *
 * Credentialed, like every other gift call: the couple's list, and who may give
 * to it, are for the people they invited.
 */
export async function contributeGift(
  apiUrl: string,
  slug: string,
  body: GiftContributionBody,
): Promise<GiftContributionResult> {
  try {
    const res = await fetch(`${giftRegistryBase(apiUrl, slug)}/contribute`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (res.status === 401) return { kind: "signed-out" };
    if (res.status === 409) {
      return (await errorCode(res)) === "fund_unavailable"
        ? { kind: "fund-closed" }
        : { kind: "unavailable" };
    }
    if (res.status === 400) return { kind: "invalid" };
    if (res.status === 403 && (await errorCode(res)) === PREVIEW_READ_ONLY) {
      return { kind: "preview" };
    }
    if (res.status === 429) {
      const raw = res.headers.get("retry-after");
      const seconds = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      return {
        kind: "rate-limited",
        retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      };
    }
    if (!res.ok) return { kind: "error" };
    const payload = (await res.json()) as { url?: unknown };
    // A 200 without a USABLE url is not a success — sending a guest nowhere is
    // worse than telling them it did not work, and sending them somewhere else
    // is worse than both. The destination of this hand-off is a fixed, known
    // origin, so it is asserted rather than assumed: one bad response body
    // otherwise turns "Continue to payment" into an open redirect, which is the
    // single worst place for one.
    return typeof payload?.url === "string" && isStripeCheckoutUrl(payload.url)
      ? { kind: "ok", url: payload.url }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Stripe's own hosted checkout, and nowhere else. */
export function isStripeCheckoutUrl(raw: string): boolean {
  try {
    return new URL(raw).origin === "https://checkout.stripe.com";
  } catch {
    return false;
  }
}

/**
 * The amounts a guest is offered before they type one, in MINOR units of the
 * wedding's currency.
 *
 * Deliberately currency-blind: 5 000 minor units is $50 in a two-exponent
 * currency and ¥5 000 in yen, and both are a sensible wedding gift. A
 * per-currency table would be a table nobody keeps current, and the guest can
 * always type their own.
 */
export const GIFT_AMOUNT_PRESETS_MINOR = [5_000, 10_000, 20_000] as const;

/** The server's own bounds (`ContributeBody`). Mirrored for the input's min/max. */
export const MIN_GIFT_AMOUNT_MINOR = 500;
export const MAX_GIFT_AMOUNT_MINOR = 1_000_000;

/**
 * Turn what a guest typed into minor units, or `null` if it is not a number the
 * server would accept.
 *
 * The box holds a MAJOR-unit amount, because that is what people type: "50",
 * not "5000". The exponent comes from the same `Intl` data `formatGiftPrice`
 * uses, so a yen gift of 5000 is 5000 minor units and a dollar gift of 50 is
 * 5000 — the one place that conversion lives.
 */
export function parseGiftAmountMinor(raw: string, currency: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const major = Number(trimmed);
  if (!Number.isFinite(major) || major <= 0) return null;
  const minor = Math.round(major * 10 ** giftCurrencyExponent(currency));
  if (!Number.isInteger(minor)) return null;
  if (minor < MIN_GIFT_AMOUNT_MINOR || minor > MAX_GIFT_AMOUNT_MINOR) return null;
  return minor;
}

/**
 * How many decimal places a currency has. JPY has none and KWD has three; a
 * fixed 2 is wrong by 100× in both directions, which on a payment screen is not
 * a rounding nit.
 */
export function giftCurrencyExponent(currency: string): number {
  const formatter = priceFormatter(currency);
  return formatter?.resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * Reserve (or re-reserve at a new quantity) one item for this household.
 *
 * A claim is NOT a purchase — it reserves, so the couple's list stops offering
 * the same pan to a second household. Contributions are a separate later PR.
 */
export async function claimGiftRegistryItem(
  apiUrl: string,
  slug: string,
  itemId: string,
  body: GiftRegistryClaimBody = {},
): Promise<GiftRegistryWrite> {
  try {
    const res = await fetch(
      `${giftRegistryBase(apiUrl, slug)}/items/${encodeURIComponent(itemId)}/claim`,
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return writeFailure(res);
    return { kind: "ok" };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Release this household's claim. A tombstone server-side, not a delete — which
 * is why re-claiming afterwards works and why the guest can change their mind
 * as often as they like.
 */
export async function releaseGiftRegistryItem(
  apiUrl: string,
  slug: string,
  itemId: string,
): Promise<GiftRegistryWrite> {
  try {
    const res = await fetch(
      `${giftRegistryBase(apiUrl, slug)}/items/${encodeURIComponent(itemId)}/claim`,
      { method: "DELETE", credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return writeFailure(res);
    return { kind: "ok" };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Re-check an item's `external_url` before it can reach an `<a href>`.
 *
 * The API already parses and normalises this on write. This is the second half
 * of the same gate, at the render site, because a row can also arrive from a
 * migration, a fixture or a restored backup, and a `javascript:` value in an
 * `href` is a same-origin script sink.
 *
 * `https:` only. Embedded credentials are rejected for the same reason the write
 * path rejects them: `https://evil.com@retailer.example/` reads as the retailer
 * to a guest and resolves to `evil.com` to the browser.
 *
 * Returns the parsed `href` (so the check and the render cannot see different
 * strings) or `null`, which means "render no link at all".
 */
export function giftRegistryExternalHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** How many of an item are still free. Never negative, whatever the row says. */
export function giftRegistryRemaining(item: GiftRegistryItem): number {
  return Math.max(0, item.quantityWanted - item.quantityClaimed);
}

/**
 * Why the quantity box will not take a larger number — said only where the
 * answer would otherwise be a surprise.
 *
 * A ceiling is worth explaining when it sits BELOW what the couple asked for,
 * which is to say when someone else has already taken some. That is the number
 * a guest cannot work out from the page: the couple wanted three, three is what
 * the card is for, and the box stops at two.
 *
 * Where the ceiling IS the couple's ask, it explains nothing — "You can reserve
 * up to 3" under a gift they asked three of is the page repeating itself, and a
 * hint that appears on every form is one nobody reads. Single-quantity gifts,
 * which are most of them, fall here and stay silent.
 *
 * `null` means render no hint. The input's own `max` bounds the control either
 * way; this is the explanation, never the guard.
 */
export function giftRegistryQuantityHint(max: number, wanted: number): string | null {
  if (!Number.isFinite(max) || max < 1) return null;
  if (!Number.isFinite(wanted) || max >= wanted) return null;
  return max === 1 ? "You can reserve 1." : `You can reserve up to ${max}.`;
}

/**
 * `Intl.NumberFormat` instances, memoised by currency.
 *
 * Constructing one is the expensive part (locale + currency data resolution);
 * formatting with a built one is cheap, and a registry renders one price per
 * card inside a `<For>`. The FAILURE is cached too, as `null`: `Intl` THROWS on
 * an unknown currency code, and a throw per row is worse than the construction
 * it replaced.
 */
const priceFormatters = new Map<string, Intl.NumberFormat | null>();

function priceFormatter(currency: string): Intl.NumberFormat | null {
  const hit = priceFormatters.get(currency);
  // `null` is a remembered failure, `undefined` a miss; nothing stores `undefined`.
  if (hit !== undefined) return hit;
  let built: Intl.NumberFormat | null = null;
  try {
    built = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    built = null;
  }
  priceFormatters.set(currency, built);
  return built;
}

/**
 * Format a minor-unit price in the wedding's primary currency.
 *
 * The exponent is NOT always 2 and a fixed `/ 100` is wrong by 100× in both
 * directions: JPY has no minor unit at all (exponent 0, so 1000 minor units is
 * ¥1000), while KWD/BHD/JOD use 3. It is read back off the formatter this
 * module already builds, so asking for it never constructs a second one.
 *
 * `priceMinor` is `null` for an item with no price — an entirely ordinary state
 * ("anything from this shop"), so it returns `null` and the card renders no
 * price line rather than a zero.
 */
export function formatGiftPrice(priceMinor: number | null, currency: string): string | null {
  if (priceMinor === null || !Number.isFinite(priceMinor)) return null;
  const formatter = priceFormatter(currency);
  if (!formatter) {
    // Unknown/malformed currency code: show the amount rather than nothing, at
    // the 2-decimal default, and let the couple's own copy carry the currency.
    return (priceMinor / 100).toFixed(2);
  }
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(priceMinor / 10 ** exponent);
}

/* ------------------------------------------------------------------------- *
 * The gift list's own page
 *
 * The gift list has its own route, `/cire/registry?slug=…`, because guests
 * return to it to review and change reservations or open gifts in a shop.
 *
 * The helpers below are the parts of that page that must hold without a DOM:
 * what it is called, and how the list is read out. Where it lives, and the
 * copy, order and pictures it shares with the invitation's band, are in
 * `gift-registry-display.ts`.
 * ------------------------------------------------------------------------- */

/**
 * The gift page's `<title>`, shaped like the invite's own (`inviteTitle`):
 * the couple first, then where on their invitation you are.
 */
export function giftPageTitle(heading: string, heroTitle: string | null | undefined): string {
  return heroTitle ? `${heroTitle} — ${heading}` : heading;
}

/**
 * This household's own reservations, counted for the ledger line.
 *
 * The one count the guest surface keeps, and it is theirs: what they have
 * reserved, not how much of the couple's list is left. Quantities rather than
 * rows — one row for six glasses is six gifts to a guest.
 */
export function giftRegistryClaimedCopy(
  claims: readonly GiftRegistryHouseholdClaim[],
): string | null {
  let count = 0;
  for (const claim of claims) count += Math.max(0, claim.quantity);
  if (count === 0) return null;
  return count === 1 ? "You reserved 1 gift" : `You reserved ${count} gifts`;
}

/** One shelf of the list: the couple's own label, and what sits under it. */
export interface GiftRegistryGroup {
  /** The couple's category, trimmed. `null` is the ungrouped tail. */
  category: string | null;
  items: GiftRegistryItem[];
}

/**
 * Group a sorted list by the couple's own categories.
 *
 * Categories are the couple's words, not a taxonomy we impose, so the order they
 * appear in is the order the list already carries (`sortOrder`) — first mention
 * wins, and nothing is alphabetised behind their back. Items with no category go
 * last, in one unlabelled tail: on a page a guest scans, a run of gifts under no
 * heading reads as "and these", which is what it is.
 *
 * A blank category is no category. Pass an already-sorted list
 * (`sortGiftRegistryItems`) — this preserves order, it does not impose one.
 */
export function groupGiftRegistryItems(items: readonly GiftRegistryItem[]): GiftRegistryGroup[] {
  const labelled = new Map<string, GiftRegistryItem[]>();
  const tail: GiftRegistryItem[] = [];
  for (const item of items) {
    const category = typeof item.category === "string" ? item.category.trim() : "";
    if (category === "") {
      tail.push(item);
      continue;
    }
    const bucket = labelled.get(category);
    if (bucket) bucket.push(item);
    else labelled.set(category, [item]);
  }
  const groups: GiftRegistryGroup[] = [...labelled].map(([category, groupItems]) => ({
    category,
    items: groupItems,
  }));
  if (tail.length > 0) groups.push({ category: null, items: tail });
  return groups;
}

/**
 * Whether the shelf labels are worth painting. One unlabelled group is a plain
 * list — heading it "More gifts" would name a distinction the couple never made.
 */
export function hasGiftRegistryCategories(groups: readonly GiftRegistryGroup[]): boolean {
  return groups.some((group) => group.category !== null);
}
