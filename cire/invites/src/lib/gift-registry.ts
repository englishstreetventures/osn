/**
 * Guest-side client for the gift registry.
 *
 * NAMING: everything this feature adds to the guest site carries the
 * `gift-registry` / `GiftRegistry*` prefix. `src/designs/registry.ts` is the
 * invite DESIGN-PACK map and predates this module — an unrelated use of the
 * word. Nothing here may be called `Registry*`, and no gift code belongs under
 * `src/designs/`.
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

/** Mirrors `RegistryItemKind` in `cire/api/src/services/registry.ts`. */
export type GiftRegistryItemKind = "product" | "cash_fund";

/** Mirrors `PublicRegistryItemDto`. Carries counts only — never a claimant. */
export interface GiftRegistryItem {
  id: string;
  kind: GiftRegistryItemKind;
  title: string;
  description: string | null;
  /** LAST SEGMENT of the R2 key (`registry-<uuid>`), not a URL. */
  imageName: string | null;
  /** Serialized crop as stored; not parsed here. */
  imageCrop: string | null;
  externalUrl: string | null;
  priceMinor: number | null;
  quantityWanted: number;
  quantityClaimed: number;
  category: string | null;
  sortOrder: number;
}

/** Mirrors `PublicRegistryDto`. One primary currency for the whole list. */
export interface GiftRegistry {
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  currency: string;
  items: GiftRegistryItem[];
}

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
 */
export interface GiftRegistryHousehold {
  claims: GiftRegistryHouseholdClaim[];
  shippingAddress?: string;
}

/**
 * The list read. CREDENTIALED — the list is for the couple's guests.
 *
 * `signed-out` is the 401 a visitor with no `cire_session` gets: a gift list
 * names what a couple want and what it costs, and they only ever showed it to
 * the people they invited, so it sits behind the same claim the rest of the
 * invitation does.
 *
 * `hidden` is the API's single 404 `registry_not_found`, which covers unknown
 * slug, unentitled wedding, a registry that exists but is not published, and a
 * household of ANOTHER wedding — one code on purpose, so no caller can probe
 * which. The band on the invite renders NOTHING on either `hidden` or
 * `signed-out`; that is a different thing from a published registry with no
 * items, which renders its heading and an empty note.
 */
export type GiftRegistryFetch =
  | { kind: "ok"; registry: GiftRegistry }
  | { kind: "signed-out" }
  | { kind: "hidden" }
  | { kind: "error" };

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
 */
export type GiftRegistryWrite =
  | { kind: "ok" }
  | { kind: "fully-claimed" }
  | { kind: "item-gone" }
  | { kind: "hidden" }
  | { kind: "signed-out" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "invalid" }
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

function registryBase(apiUrl: string, slug: string): string {
  return `${apiUrl}/api/invite/${encodeURIComponent(slug)}/registry`;
}

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
  return { kind: "error" };
}

/**
 * This wedding's gift list. Credentialed — see the module header for why the
 * cookie mode is load-bearing, and `GiftRegistryFetch` for why the list needs
 * one at all. `no-store` matches the route's own header: the counts here are
 * live, and a stale list shows a claimed gift as available.
 */
export async function fetchGiftRegistry(apiUrl: string, slug: string): Promise<GiftRegistryFetch> {
  try {
    const res = await fetch(registryBase(apiUrl, slug), {
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 401) return { kind: "signed-out" };
    if (res.status === 404) return { kind: "hidden" };
    if (!res.ok) return { kind: "error" };
    return { kind: "ok", registry: (await res.json()) as GiftRegistry };
  } catch {
    return { kind: "error" };
  }
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
    const res = await fetch(`${registryBase(apiUrl, slug)}/mine`, {
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
      `${registryBase(apiUrl, slug)}/items/${encodeURIComponent(itemId)}/claim`,
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
      `${registryBase(apiUrl, slug)}/items/${encodeURIComponent(itemId)}/claim`,
      { method: "DELETE", credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return writeFailure(res);
    return { kind: "ok" };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Base URL for an item's image, with NO `?variant=` yet — feed it to the shared
 * `variantSrc` / `buildSrcSet` helpers, which own the bounded variant names and
 * their widths for every image on the guest site.
 *
 * `imageName` is the LAST SEGMENT of the R2 key; the route rebuilds the rest
 * server-side from the slug, so the guest never names a bucket path.
 */
export function giftRegistryImageBase(apiUrl: string, slug: string, imageName: string): string {
  return `${registryBase(apiUrl, slug)}/image/${encodeURIComponent(imageName)}`;
}

/**
 * Re-check an item's `external_url` before it can reach an `<a href>`.
 *
 * The API already parses and normalises this on write. This is the second half
 * of the same gate, at the render site, because a row can also arrive from a
 * migration, a fixture or a restored backup — the CON-S-L2 precedent, where
 * `vendor.privacyUrl` reached an `href` with no scheme check and `javascript:`
 * was therefore a same-origin script sink.
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
 * The counts line a guest sees. COUNTS ONLY — this is the whole of what the
 * guest surface may say about who has taken what. No names, no totals.
 */
export function giftRegistryRemainingCopy(item: GiftRegistryItem): string {
  const remaining = giftRegistryRemaining(item);
  if (remaining === 0) return "All reserved";
  if (item.quantityWanted <= 1) return "Available";
  return `${remaining} of ${item.quantityWanted} left`;
}

/**
 * Sort as the API's own index does: `sort_order`, then `id` as the tie-break.
 * Re-sorted client-side rather than trusted, so a merged/refetched list is
 * stable no matter what order the rows arrived in. Copies — never sorts the
 * caller's array in place.
 */
export function sortGiftRegistryItems(items: readonly GiftRegistryItem[]): GiftRegistryItem[] {
  return [...items].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.id.localeCompare(b.id) : a.sortOrder - b.sortOrder,
  );
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
 * The registry used to be the last section of the invite. It is now its own
 * route, `/<slug>/registry`, because it is the one part of an invitation a
 * guest comes BACK to — to see what is still free, to change what they
 * reserved, to open it in a shop on a phone. As a section at the bottom of a
 * long invite every one of those is a scroll past the whole story; as a page it
 * is a link, and a link is something a couple can send on its own.
 *
 * The helpers below are the parts of that page that must hold without a DOM:
 * where it lives, what it is called, and how the list is read out.
 * ------------------------------------------------------------------------- */

/** The wedding's gift-list page. Encoded like every other slug in a URL here. */
export function giftRegistryPath(slug: string): string {
  return `/${encodeURIComponent(slug)}/registry`;
}

/** Built-in copy when the organiser set none. */
export const DEFAULT_GIFT_REGISTRY_EYEBROW = "With Love";
export const DEFAULT_GIFT_REGISTRY_HEADING = "Gift Registry";

/**
 * First usable line of copy, or `null`.
 *
 * Blank counts as unset, not as an answer. The old inline `??` chain took the
 * first NON-NULL value, so a heading saved as `""` won over both the registry
 * module's own headline and the built-in default — an empty `<h1>` on the
 * invite, and on this page an empty `<title>` in the browser tab and in every
 * link preview of it.
 */
function firstCopy(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

/** Section eyebrow — the invite's copy, else the built-in. */
export function giftRegistryEyebrow(inviteCopy: string | null | undefined): string {
  return firstCopy(inviteCopy) ?? DEFAULT_GIFT_REGISTRY_EYEBROW;
}

/**
 * Section heading. The invite's own copy wins when the organiser wrote it (it is
 * section furniture, themed with every other section header); the registry
 * module's `headline` fills in when they only wrote copy there.
 */
export function giftRegistryHeading(
  inviteCopy: string | null | undefined,
  headline: string | null | undefined,
): string {
  return firstCopy(inviteCopy, headline) ?? DEFAULT_GIFT_REGISTRY_HEADING;
}

/** Intro body, same precedence as the heading. `null` ⇒ render no paragraph. */
export function giftRegistryBody(
  inviteCopy: string | null | undefined,
  message: string | null | undefined,
): string | null {
  return firstCopy(inviteCopy, message);
}

/**
 * The gift page's `<title>`, shaped like the invite's own (`inviteTitle`):
 * the couple first, then where on their invitation you are.
 */
export function giftPageTitle(heading: string, heroTitle: string | null | undefined): string {
  return heroTitle ? `${heroTitle} — ${heading}` : heading;
}

/** How many gifts are free, out of how many the couple asked for. */
export interface GiftRegistryAvailability {
  available: number;
  total: number;
}

/**
 * The list read as counts. Quantities, not rows: a couple who asked for six wine
 * glasses wrote one row, and "5 of 6 still available" is what a guest can act on.
 */
export function giftRegistryAvailability(
  items: readonly GiftRegistryItem[],
): GiftRegistryAvailability {
  let available = 0;
  let total = 0;
  for (const item of items) {
    available += giftRegistryRemaining(item);
    // Guard the row itself: a negative or non-finite `quantityWanted` would
    // otherwise put a nonsense number in the one line that summarises the page.
    total += Math.max(0, Number.isFinite(item.quantityWanted) ? item.quantityWanted : 0);
  }
  return { available, total };
}

/**
 * The page's ledger line. COUNTS ONLY — the same rule the cards keep: how many
 * are left, never who took what.
 *
 * `null` for an empty list, which has its own copy ("no gifts yet") and must not
 * be summarised as "0 of 0".
 */
export function giftRegistryAvailabilityCopy(items: readonly GiftRegistryItem[]): string | null {
  const { available, total } = giftRegistryAvailability(items);
  if (total === 0) return null;
  if (available === 0) return "Every gift has been reserved";
  return `${available} of ${total} still available`;
}

/** This household's own reservations, counted for the ledger line. */
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
