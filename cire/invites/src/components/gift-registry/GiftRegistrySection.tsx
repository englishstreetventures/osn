import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import {
  claimGiftRegistryItem,
  fetchGiftRegistry,
  fetchGiftRegistryHousehold,
  giftRegistryImageBase,
  releaseGiftRegistryItem,
  sortGiftRegistryItems,
  type GiftRegistryClaimBody,
  type GiftRegistryFetch,
  type GiftRegistryHouseholdClaim,
  type GiftRegistryHouseholdFetch,
  type GiftRegistryItem,
  type GiftRegistryWrite,
} from "../../lib/gift-registry";
import { CLAIM_SESSION_EVENT, hasClaimedHint } from "../claim-session";
import { GiftRegistryItemCard } from "./GiftRegistryItemCard";

/**
 * THE GIFT REGISTRY, as a guest sees it — the couple's list, what is still free
 * on it, and this household's own reservations.
 *
 * NAMING: `src/designs/registry.ts` is the invite DESIGN-PACK map and predates
 * this feature. Everything here is `gift-registry` / `GiftRegistry*` so the two
 * can never be confused, and no gift code lives under `src/designs/`.
 *
 * WHAT A GUEST MAY SEE. Counts, never names: "1 of 2 left". Who reserved what,
 * what anyone spent, and any running total belong to the couple. The API keeps
 * that (its public read never selects a claimant identity); this component's job
 * is not to undo it. The one exception is this household's OWN claim, which it
 * reads from the separate credentialed `…/registry/mine` route — their own name,
 * which they typed, echoed back to them.
 *
 * A CLAIM IS NOT A PURCHASE. It reserves, so the same pan is not offered to a
 * second household. Money — contributions to a cash fund — is a separate later
 * change; `kind: "cash_fund"` is a declared seam and renders exactly like any
 * other item here, on purpose. Inventing a contribute flow for a backend that
 * has none would be UI standing in for something that does not exist.
 *
 * THE RACE IS THE ORDINARY CASE. A shared invite link means two guests tapping
 * the last item at the same moment, and the API answers the loser 409
 * `item_fully_claimed`. That is handled honestly here — refetch the counts, say
 * what happened, leave their form open — never swallowed, and never painted as a
 * success that did not happen. There is deliberately NO optimistic update in
 * this component for exactly that reason: the counts a guest reads are always
 * ones the server just sent.
 *
 * WHY IT IS ITS OWN ISLAND rather than a section inside `InvitePage`: the public
 * registry read is unauthenticated, so the list must render for a visitor who
 * has not entered their code — which `InvitePage`, whose whole body is gated on
 * a claim, cannot do. A signed-out guest sees the gifts and a prompt to enter
 * their code, not a dead button.
 */

/** Built-in copy when the organiser set none. `null` in the payload means
 *  "use the built-in default" — the same contract as the details section. */
export const DEFAULT_GIFT_REGISTRY_EYEBROW = "With Love";
export const DEFAULT_GIFT_REGISTRY_HEADING = "Gift Registry";

export type GiftRegistryAction = "claim" | "release";

/**
 * What the guest is told after a write. Pure, and exported, so every branch is
 * testable without a DOM — including the ones a happy-path test never reaches.
 */
export function giftRegistryWriteMessage(
  outcome: GiftRegistryWrite,
  action: GiftRegistryAction,
  title: string,
): string {
  switch (outcome.kind) {
    case "ok":
      return action === "claim"
        ? `Reserved. “${title}” is marked as yours.`
        : `Released. “${title}” is free for another guest again.`;
    case "fully-claimed":
      // The 409. Say plainly that they lost the race and that what they are
      // now looking at is fresh — the counts were refetched before this showed.
      return `Another guest reserved the last “${title}” a moment ago. The list below is up to date.`;
    case "item-gone":
      return `“${title}” is no longer on the couple’s list. The list below is up to date.`;
    case "hidden":
      return "The couple have closed their gift list.";
    case "signed-out":
      return "Your invite session has ended. Enter your invite code again to reserve a gift.";
    case "rate-limited":
      return outcome.retryAfterSeconds === null
        ? "That was a lot of changes at once. Try again in a moment."
        : `That was a lot of changes at once. Try again in ${outcome.retryAfterSeconds} seconds.`;
    case "invalid":
      return "That number is not available any more. Pick a smaller one and try again.";
    case "error":
      return "Could not reach the gift list. Check your connection and try again.";
  }
}

export interface GiftRegistrySectionProps {
  /** cire-api origin. */
  apiUrl: string;
  /** The wedding this page renders. */
  slug: string;
  /** Section copy from the invite payload; `null` ⇒ the built-in default. */
  eyebrow?: string | null;
  heading?: string | null;
  body?: string | null;
  /** Validated CSS-variable map for this section's surface (`sectionVars(theme, "registry")`). */
  themeVars?: Record<string, string>;
}

export function GiftRegistrySection(props: GiftRegistrySectionProps) {
  // `null` means "not answered yet". Until the public read answers `ok`, this
  // component renders NOTHING — which is also the permanent state for a registry
  // that is unpublished or not entitled, since that 404s. An empty published
  // registry is a different thing and does render, with its heading and a note.
  const [list, setList] = createSignal<GiftRegistryFetch | null>(null);
  const [mine, setMine] = createSignal<GiftRegistryHouseholdFetch | null>(null);
  const [status, setStatus] = createSignal("");
  const [busyItem, setBusyItem] = createSignal<string | null>(null);

  async function loadList(): Promise<void> {
    setList(await fetchGiftRegistry(props.apiUrl, props.slug));
  }

  async function loadHousehold(): Promise<void> {
    // No claim hint ⇒ this browser has never claimed here, so `…/registry/mine`
    // could only ever 401. Skipping it matters more here than anywhere else on
    // the site: this section is PUBLIC and every visitor scrolls past it, so the
    // wasted call would scale with page views rather than with guests, against
    // an account-wide Workers Free budget of 100k/day.
    if (!hasClaimedHint()) {
      setMine({ kind: "signed-out" });
      return;
    }
    setMine(await fetchGiftRegistryHousehold(props.apiUrl, props.slug));
  }

  onMount(() => {
    // Both reads on mount, in parallel — neither needs the other, and the
    // household read only ever adds "you reserved this" to a list that stands
    // on its own without it.
    void loadList();
    void loadHousehold();

    // A claim happens in the OTHER island, and it navigates nowhere: `InvitePage`
    // reveals the invite in place. Without this, a guest who enters their code
    // and scrolls down keeps the signed-out prompt for the rest of the visit —
    // advice pointing at a form the reveal has already faded away. Re-reading
    // the server, rather than trusting the event, keeps the rule that the state
    // a guest reads is always one the server just sent.
    const onSessionChange = () => void loadHousehold();
    window.addEventListener(CLAIM_SESSION_EVENT, onSessionChange);
    onCleanup(() => window.removeEventListener(CLAIM_SESSION_EVENT, onSessionChange));
  });

  const registry = createMemo(() => {
    const l = list();
    return l !== null && l.kind === "ok" ? l.registry : null;
  });

  // Sorted client-side by `sortOrder` then `id`, so a refetched list keeps the
  // same order whatever order the rows arrive in.
  const items = createMemo(() => sortGiftRegistryItems(registry()?.items ?? []));

  /**
   * The list is rendered over IDS, not over the item objects.
   *
   * `<For>` reconciles by reference, and every refetch parses fresh objects — so
   * iterating the items themselves would dispose and re-create every row on each
   * re-read, throwing away the open claim form and everything typed into it.
   * That is exactly the wrong moment to do it: the 409 race re-reads precisely so
   * the guest can see the new counts beside the words they just wrote. Ids are
   * strings and compare equal, so the rows survive and only their props change.
   */
  const itemIds = createMemo(() => items().map((item) => item.id));
  const itemsById = createMemo(() => new Map(items().map((item) => [item.id, item])));

  const household = createMemo(() => {
    const m = mine();
    return m !== null && m.kind === "ok" ? m.household : null;
  });

  const signedIn = createMemo(() => household() !== null);

  /** This household's own claims, by item. Empty when signed out. */
  const claims = createMemo(() => {
    const map = new Map<string, GiftRegistryHouseholdClaim>();
    for (const claim of household()?.claims ?? []) map.set(claim.itemId, claim);
    return map;
  });

  /**
   * The couple's shipping address — rendered ONLY when the API actually sent it.
   * The field is optional on the wire and carries no reason: absent covers both
   * "the couple set none" and "you may not see it", deliberately, so there is
   * nothing honest to say in its place. Say nothing.
   */
  const shippingAddress = createMemo(() => household()?.shippingAddress?.trim() || null);

  const eyebrow = createMemo(() => props.eyebrow ?? DEFAULT_GIFT_REGISTRY_EYEBROW);
  // The invite's own section copy wins when the organiser set it (it is section
  // furniture, themed with every other section header); the registry module's
  // own `headline` / `message` fill in when they only wrote copy there.
  const heading = createMemo(
    () => props.heading ?? registry()?.headline ?? DEFAULT_GIFT_REGISTRY_HEADING,
  );
  const body = createMemo(() => props.body ?? registry()?.message ?? null);

  /** The item's image route, or `null` when the couple uploaded no picture. */
  function imageBase(item: GiftRegistryItem): string | null {
    const name = item.imageName;
    return name === null ? null : giftRegistryImageBase(props.apiUrl, props.slug, name);
  }

  /** Apply a write's outcome: say what happened, then re-read what is true. */
  async function applyOutcome(
    outcome: GiftRegistryWrite,
    action: GiftRegistryAction,
    title: string,
  ): Promise<boolean> {
    setStatus(giftRegistryWriteMessage(outcome, action, title));
    switch (outcome.kind) {
      case "ok":
      case "fully-claimed":
      case "item-gone":
        // The counts moved (or proved to have moved under us). Re-read BOTH:
        // the public list for the true counts, the household read for what is
        // now actually reserved by us.
        await Promise.all([loadList(), loadHousehold()]);
        break;
      case "hidden":
        // Unpublished while this page was open — the refetch 404s and the whole
        // section unmounts, which is the honest end state.
        await loadList();
        break;
      case "signed-out":
        // The 30-day session lapsed mid-visit. Drop to the signed-out surface
        // rather than leaving controls that can only fail.
        setMine({ kind: "signed-out" });
        break;
      default:
        // Rate-limited, invalid, transport error: nothing changed server-side,
        // so nothing is re-read. The message stands on its own.
        break;
    }
    return outcome.kind === "ok";
  }

  async function claimItem(itemId: string, title: string, bodyIn: GiftRegistryClaimBody) {
    setBusyItem(itemId);
    setStatus("");
    const outcome = await claimGiftRegistryItem(props.apiUrl, props.slug, itemId, bodyIn);
    setBusyItem(null);
    return applyOutcome(outcome, "claim", title);
  }

  async function releaseItem(itemId: string, title: string) {
    setBusyItem(itemId);
    setStatus("");
    const outcome = await releaseGiftRegistryItem(props.apiUrl, props.slug, itemId);
    setBusyItem(null);
    await applyOutcome(outcome, "release", title);
  }

  return (
    /**
     * AN ALWAYS-PRESENT ELEMENT ROOT, and it must stay one.
     *
     * `client:visible` does not observe the island; it observes the island's
     * element CHILDREN (`for (const child of el.children) io.observe(child)` in
     * astro's `runtime/client/visible.js`), because `<astro-island>` is
     * `display: contents` and has no box of its own to intersect with.
     *
     * Everything below is inside `<Show when={registry()}>`, and the registry is
     * `null` until a fetch that only runs after hydration — so on the server this
     * component renders nothing, the island ships zero element children, the
     * observer is handed nothing to watch and hydration NEVER fires. The whole
     * section is then absent from both design packs, in production only: a unit
     * test renders the component directly and never sees it.
     *
     * This wrapper is that box. It has no class and no style: an empty `<div>`
     * adds no layout, while a bare `<section>` here would paint a visible empty
     * bordered, padded band on every wedding without a registry.
     */
    <div data-gift-registry-island>
      <Show when={registry()}>
        <section
          data-gift-registry
          class="border-border border-t px-6 py-16 md:px-8 md:py-20"
          style={{
            ...props.themeVars,
            "background-color": "var(--invite-section-bg)",
          }}
        >
          <div class="mx-auto max-w-[540px] text-center md:max-w-[64rem]">
            <p class="font-body text-gold-ink mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
              {eyebrow()}
            </p>
            <h2 class="font-display text-text mb-5 text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))] leading-[1.15] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
              {heading()}
            </h2>

            <Show when={body()}>
              {(text) => (
                <p class="font-body text-text-muted mx-auto mb-8 max-w-[34rem] text-[0.92rem] leading-[1.6] break-words whitespace-pre-line">
                  {text()}
                </p>
              )}
            </Show>

            {/* Signed out: the list still reads, but say why there is nothing to
                press rather than showing a button that can only 401. */}
            <Show when={!signedIn()}>
              <p class="border-gold/40 bg-gold/5 text-gold-ink font-body mx-auto mb-8 max-w-[34rem] rounded-sm border px-4 py-3 text-[0.8rem] leading-[1.6]">
                Enter your invite code at the top of this page to reserve a gift.
              </p>
            </Show>

            <Show when={shippingAddress()}>
              {(address) => (
                <div
                  data-gift-shipping
                  class="border-border mx-auto mb-8 max-w-[34rem] rounded-sm border px-4 py-3"
                >
                  <p class="font-body text-text-muted mb-1 text-[0.72rem] tracking-[0.14em] uppercase">
                    Send gifts to
                  </p>
                  <p class="font-body text-text text-[0.88rem] leading-[1.6] break-words whitespace-pre-line">
                    {address()}
                  </p>
                </div>
              )}
            </Show>

            {/* One status line for the whole section, at the section root — a live
                region so a screen reader hears the 409 the same moment a sighted
                guest reads it. Never an overlay: page-level fixed positioning is
                trapped by any ancestor `transform`, and this section sits among
                animated ones. */}
            <p
              data-gift-status
              role="status"
              aria-live="polite"
              class="font-body text-text mx-auto mb-8 min-h-[1.25rem] max-w-[34rem] text-[0.82rem] leading-[1.6]"
            >
              {status()}
            </p>

            <Show
              when={items().length > 0}
              fallback={
                /* PUBLISHED BUT EMPTY — a real state, and not the same as an
                   unpublished registry, which 404s and renders no section at all. */
                <p class="font-body text-text-muted text-[0.88rem]">
                  The couple haven’t added any gifts yet.
                </p>
              }
            >
              <ul class="grid list-none grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                <For each={itemIds()}>
                  {(id) => (
                    <li>
                      <Show when={itemsById().get(id)}>
                        {(item) => (
                          <GiftRegistryItemCard
                            item={item()}
                            currency={registry()?.currency ?? ""}
                            imageBase={imageBase(item())}
                            claim={claims().get(id)}
                            canClaim={signedIn()}
                            busy={busyItem() === id}
                            onClaim={(claimBody) => claimItem(id, item().title, claimBody)}
                            onRelease={() => void releaseItem(id, item().title)}
                          />
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </section>
      </Show>
    </div>
  );
}
