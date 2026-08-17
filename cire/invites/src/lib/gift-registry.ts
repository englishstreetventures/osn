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
 * The public list read.
 *
 * `hidden` is the API's single 404 `registry_not_found`, which covers unknown
 * slug, unentitled wedding, and a registry that exists but is not published —
 * one code on purpose, so the public surface cannot be used to probe which. The
 * section renders NOTHING on `hidden`; that is a different thing from a
 * published registry with no items, which renders its heading and an empty note.
 */
export type GiftRegistryFetch =
  | { kind: "ok"; registry: GiftRegistry }
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
 * The public registry for a slug. No credentials — this route is public, and
 * sending the household cookie would buy nothing while widening what a cached
 * intermediary could key on. `no-store` matches the route's own header: the
 * counts here are live, and a stale list shows a claimed gift as available.
 */
export async function fetchGiftRegistry(apiUrl: string, slug: string): Promise<GiftRegistryFetch> {
  try {
    const res = await fetch(registryBase(apiUrl, slug), { cache: "no-store" });
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
