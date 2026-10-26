/**
 * The gift list's one read, and the shape it answers with.
 *
 * Apart from the rest of the guest-side client (`gift-registry.ts`,
 * `gift-registry-display.ts`) so that the invitation's gift band island can ask
 * whether this wedding has a list for this guest without downloading the band
 * or anything it shows the list with: the API answers this
 * read with one 404 for a wedding below Gold, an unpublished list and an
 * unknown slug, and only an `ok` loads the rest (`GiftRegistryTeaserIsland`).
 * Everything here must stay small enough to ship on every invitation.
 *
 * The read is CREDENTIALED: `cire_session` is HttpOnly and host-scoped to the
 * API ORIGIN, a different origin from the guest site, so a cross-origin `fetch`
 * on the default `same-origin` mode drops the cookie silently and every read
 * answers "signed out".
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

/**
 * Mirrors `PublicRegistryFundDto` — one of the couple's cash funds. Its name,
 * picture and the couple's words about it, and nothing else: a fund's goal,
 * and how much has come in, are the couple's alone.
 */
export interface GiftRegistryFund {
  id: string;
  title: string;
  description: string | null;
  /** LAST SEGMENT of the R2 key (`registry-<uuid>`), not a URL. */
  imageName: string | null;
  imageCrop: string | null;
  sortOrder: number;
}

/** Mirrors `PublicRegistryDto`. One primary currency for the whole list. */
export interface GiftRegistry {
  headline: string | null;
  message: string | null;
  cashGiftsEnabled: boolean;
  currency: string;
  /** The gifts to reserve. Never a cash fund. */
  items: GiftRegistryItem[];
  /**
   * The cash funds a guest may give to, present only while the couple take
   * money. Optional because this site can reach production before the API
   * that sends it; absent reads as none.
   */
  funds?: GiftRegistryFund[];
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

/** The gift list's routes on cire-api, for this wedding. */
export function giftRegistryBase(apiUrl: string, slug: string): string {
  return `${apiUrl}/api/invite/${encodeURIComponent(slug)}/registry`;
}

/**
 * This wedding's gift list. Credentialed — see the module header for why the
 * cookie mode is load-bearing, and `GiftRegistryFetch` for why the list needs
 * one at all. `no-store` matches the route's own header: the counts here are
 * live, and a stale list shows a claimed gift as available.
 */
export async function fetchGiftRegistry(apiUrl: string, slug: string): Promise<GiftRegistryFetch> {
  try {
    const res = await fetch(giftRegistryBase(apiUrl, slug), {
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
