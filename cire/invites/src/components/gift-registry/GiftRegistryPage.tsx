import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";

import {
  claimGiftRegistryItem,
  fetchGiftRegistry,
  fetchGiftRegistryHousehold,
  giftRegistryAvailabilityCopy,
  giftRegistryBody,
  giftRegistryClaimedCopy,
  giftRegistryImageBase,
  groupGiftRegistryItems,
  hasGiftRegistryCategories,
  releaseGiftRegistryItem,
  sortGiftRegistryItems,
  type GiftRegistry,
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
 * THE GIFT LIST, as a guest reads it — the couple's list, what is still free on
 * it, and this household's own reservations.
 *
 * This is the BODY of `/<slug>/registry`, its own page since the list left the
 * foot of the invite. The page shell (`GiftRegistryDocument.astro`) owns the
 * masthead — the eyebrow and heading, which come from the invite's own public
 * copy and can therefore be server-rendered. Everything that needs the list
 * itself is here, because the list is CREDENTIALED and the server has no way to
 * fetch it: `cire_session` is host-scoped to the API origin, so the browser
 * never sends it to the guest site and the SSR render has no household to be.
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
 * THE PAGE IS FOR THE COUPLE'S GUESTS. A gift list names what they want and
 * what it costs, and they only ever showed it to the people they invited — so
 * the API gates the read on the same `cire_session` the rest of the invitation
 * uses, and a visitor without one is told where to enter their code rather than
 * shown the list. The gate is the API's; this component's job is to make the
 * 401 read as an invitation rather than as a failure.
 */

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

export interface GiftRegistryPageProps {
  /** cire-api origin. */
  apiUrl: string;
  /** The wedding this page renders. */
  slug: string;
  /** Back to the couple's invitation — the page this list left. */
  inviteHref: string;
  /**
   * The couple's intro, from the invite's own registry copy. It lives HERE
   * rather than in the server-rendered masthead so one paragraph can carry the
   * whole precedence chain: the invite's copy when they wrote it there, the
   * registry module's `message` when they only wrote it there. The module's
   * words arrive with the list, which the server cannot read.
   */
  inviteBody?: string | null;
  /** Validated CSS-variable map for this surface (`sectionVars(theme, "registry")`). */
  themeVars?: Record<string, string>;
}

export function GiftRegistryPage(props: GiftRegistryPageProps) {
  /**
   * The list, and what the server last said about it.
   *
   * `registry` holds the last list the server actually sent; `answer` holds the
   * last one the server gave. They are separate because a failed re-read is not an answer: a
   * transport error (offline in a shop, an API blip) leaves both the list and
   * the outcome alone, so what is on screen stays on screen. Every other kind
   * IS an answer and replaces it — including `signed-out`, which is
   * what a 30-day session lapsing mid-visit looks like.
   *
   * `null` is the state before the first answer: the page is server-rendered
   * without a list (the read is credentialed, so the server cannot make it) and
   * says so for the moment the fetch takes.
   */
  const [registry, setRegistry] = createSignal<GiftRegistry | null>(null);
  const [answer, setAnswer] = createSignal<GiftRegistryFetch["kind"] | null>(null);
  const [mine, setMine] = createSignal<GiftRegistryHouseholdFetch | null>(null);
  const [status, setStatus] = createSignal("");
  const [busyItem, setBusyItem] = createSignal<string | null>(null);

  async function loadList(): Promise<void> {
    const result = await fetchGiftRegistry(props.apiUrl, props.slug);
    if (result.kind === "ok") {
      setRegistry(result.registry);
      setAnswer("ok");
      return;
    }
    // A transport failure is not an answer — keep whatever the last one was.
    if (result.kind === "error" && answer() !== null) return;
    setAnswer(result.kind);
  }

  async function loadHousehold(): Promise<void> {
    // No claim hint ⇒ this browser has never claimed here, so `…/registry/mine`
    // could only ever 401. Worth skipping even though the list read is gated
    // too: the page is a link people SHARE, and every visitor who opens it
    // without a code would otherwise spend a guaranteed 401 against an
    // account-wide Workers Free budget of 100k/day.
    if (!hasClaimedHint()) {
      setMine({ kind: "signed-out" });
      return;
    }
    setMine(await fetchGiftRegistryHousehold(props.apiUrl, props.slug));
  }

  onMount(() => {
    // Both reads on mount, in parallel — neither needs the other, and both are
    // credentialed, so this is the first moment either can run at all.
    void loadList();
    void loadHousehold();

    // A claim happens on the INVITE, in another document, so this page usually
    // learns about one by being loaded fresh. The event still matters for a
    // session that changes in THIS tab — a session restored, or one ended by
    // signing out — and it re-reads BOTH: the list is gated on the same cookie,
    // so a locked page becomes an open one (or the reverse) without a reload.
    // Re-reading the server, rather than trusting the event, keeps the rule that
    // the state a guest reads is always one the server just sent.
    const onSessionChange = () => {
      void loadList();
      void loadHousehold();
    };
    window.addEventListener(CLAIM_SESSION_EVENT, onSessionChange);
    onCleanup(() => window.removeEventListener(CLAIM_SESSION_EVENT, onSessionChange));
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
   *
   * The shelves are keyed the same way, on the category STRING (`null` for the
   * unlabelled tail — a primitive that compares equal to itself), never on the
   * group objects, which a refetch rebuilds. A shelf re-created on refetch would
   * take every open form under it down with it.
   */
  const itemsById = createMemo(() => new Map(items().map((item) => [item.id, item])));
  const groups = createMemo(() => groupGiftRegistryItems(items()));
  const groupKeys = createMemo(() => groups().map((group) => group.category));
  const groupsByKey = createMemo(() => new Map(groups().map((group) => [group.category, group])));
  const showShelfLabels = createMemo(() => hasGiftRegistryCategories(groups()));

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
   * The couple's intro: their invite copy when they wrote it there, the registry
   * module's own message when they only wrote it there. `null` ⇒ no paragraph.
   */
  const intro = createMemo(() => giftRegistryBody(props.inviteBody, registry()?.message));

  /** The two halves of the ledger line: what is free, and what is already theirs. */
  const availabilityCopy = createMemo(() => giftRegistryAvailabilityCopy(items()));
  const claimedCopy = createMemo(() => giftRegistryClaimedCopy(household()?.claims ?? []));

  /**
   * The couple's shipping address — rendered ONLY when the API actually sent it.
   * The field is optional on the wire and carries no reason: absent covers both
   * "the couple set none" and "you may not see it", deliberately, so there is
   * nothing honest to say in its place. Say nothing.
   */
  const shippingAddress = createMemo(() => household()?.shippingAddress?.trim() || null);

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
        // Unpublished while this page was open — the refetch 404s and the page
        // says so, which is the honest end state.
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
    <section
      data-gift-registry
      class="px-6 py-12 md:px-8 md:py-16"
      style={{
        ...props.themeVars,
        "background-color": "var(--invite-section-bg)",
      }}
    >
      <div class="mx-auto max-w-[540px] md:max-w-[64rem]">
        <Switch
          fallback={
            /* Before the first answer. The read is credentialed, so it cannot
               start until this island hydrates — a moment the page should name
               rather than fill with an empty frame. A live region, because for
               a screen reader this IS the page until it resolves. */
            <p
              data-gift-waiting
              role="status"
              aria-live="polite"
              class="font-body text-text-muted py-10 text-center text-[0.88rem]"
            >
              Opening the couple’s list…
            </p>
          }
        >
          <Match when={answer() === "signed-out"}>
            {/* THE GATE, as the guest meets it. The list is for the people the
                couple invited, and the code that proves it lives on the
                invitation — a different document now, so this is a link, never
                "scroll up". Not an error: nothing has gone wrong. */}
            <div data-gift-locked class="mx-auto max-w-[34rem] py-10 text-center">
              <p class="font-body text-text mb-4 text-[0.95rem] leading-[1.7]">
                This gift list is for the couple’s guests. Enter your invite code on the invitation
                and it opens here.
              </p>
              <a
                href={props.inviteHref}
                class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg inline-block rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
              >
                Open the invitation
              </a>
            </div>
          </Match>

          <Match when={answer() === "hidden"}>
            {/* Unpublished, unentitled, or a cookie for another wedding — the
                API answers one code for all three on purpose. The list is not
                here, so say that and hand back the link that still leads
                somewhere. */}
            <div data-gift-closed class="py-10 text-center">
              <p class="font-body text-text mb-4 text-[0.95rem] leading-[1.7]">
                The couple have closed their gift list.
              </p>
              <a
                href={props.inviteHref}
                class="font-body text-gold-ink focus-visible:ring-gold/60 rounded-sm text-[0.85rem] underline underline-offset-4 focus:outline-none focus-visible:ring-2"
              >
                Back to the invitation
              </a>
            </div>
          </Match>

          <Match when={answer() === "error"}>
            {/* Only reachable as the FIRST answer: once a list has landed, a
                transport failure is not allowed to replace it. */}
            <p
              data-gift-unreachable
              class="font-body text-text-muted py-10 text-center text-[0.9rem] leading-[1.7]"
            >
              Could not reach the gift list. Check your connection and refresh the page.
            </p>
          </Match>

          <Match when={registry()}>
            <Show when={intro()}>
              {(text) => (
                <p class="font-body text-text-muted mx-auto mb-8 max-w-[34rem] text-center text-[0.92rem] leading-[1.7] break-words whitespace-pre-line">
                  {text()}
                </p>
              )}
            </Show>

            {/* The list read needed a session, so reaching here means there was
                one. This says the OTHER read lost it — a 30-day session lapsing
                between the two, or on a later re-read — which is why the
                reserve controls are gone. */}
            <Show when={!signedIn()}>
              <p
                data-gift-signed-out
                class="border-gold/40 bg-gold/5 text-gold-ink font-body mx-auto mb-8 max-w-[34rem] rounded-sm border px-4 py-3 text-center text-[0.8rem] leading-[1.6]"
              >
                Your invite session has ended. Enter your invite code again on{" "}
                <a
                  href={props.inviteHref}
                  class="focus-visible:ring-gold/60 rounded-sm underline underline-offset-4 focus:outline-none focus-visible:ring-2"
                >
                  the invitation
                </a>{" "}
                to reserve a gift.
              </p>
            </Show>

            <Show when={shippingAddress()}>
              {(address) => (
                <div
                  data-gift-shipping
                  class="border-border mx-auto mb-8 max-w-[34rem] rounded-sm border px-4 py-3 text-center"
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

            {/* One status line for the whole page, at its root — a live region so
                a screen reader hears the 409 the same moment a sighted guest reads
                it. Never an overlay: page-level fixed positioning is trapped by any
                ancestor `transform`. */}
            <p
              data-gift-status
              role="status"
              aria-live="polite"
              class="font-body text-text mx-auto mb-8 min-h-[1.25rem] max-w-[34rem] text-center text-[0.82rem] leading-[1.6]"
            >
              {status()}
            </p>

            <Show
              when={items().length > 0}
              fallback={
                /* PUBLISHED BUT EMPTY — a real state, and not the same as an
                   unpublished list, which answers the 404 above. */
                <p class="font-body text-text-muted py-10 text-center text-[0.88rem]">
                  The couple haven’t added any gifts yet.
                </p>
              }
            >
              {/* The ledger: what is left, and what is already yours. The one place
                  on the page that reads the WHOLE list at once, which is exactly
                  what a page (rather than a section) is for — a guest scrolling a
                  long list should never have to count it themselves. Counts only. */}
              <div class="border-border font-body mb-10 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b pb-3 text-[0.72rem] tracking-[0.14em] uppercase">
                <p data-gift-availability class="text-text-muted">
                  {availabilityCopy()}
                </p>
                <Show when={claimedCopy()}>
                  {(copy) => (
                    <p data-gift-claimed-count class="text-gold-ink">
                      {copy()}
                    </p>
                  )}
                </Show>
              </div>

              <For each={groupKeys()}>
                {(key, index) => (
                  <Show when={groupsByKey().get(key)}>
                    {(group) => (
                      <section
                        data-gift-shelf={group().category ?? ""}
                        class={index() === 0 ? "" : "mt-14"}
                      >
                        {/* The shelf label is the couple's own word for these
                            gifts, with a rule running out to the edge — the list's
                            only structural device, and it encodes something real:
                            where their grouping starts. Absent when they grouped
                            nothing, since one unlabelled shelf is just a list. */}
                        <Show when={showShelfLabels()}>
                          <h2 class="font-body text-gold-ink mb-6 flex items-center gap-4 text-[0.72rem] tracking-[0.2em] uppercase">
                            <span>{group().category ?? "More gifts"}</span>
                            <span class="border-border h-px flex-1 border-t" aria-hidden="true" />
                          </h2>
                        </Show>
                        {/* `items-start`, so a card is its own height. Stretching the row
                            instead would hand a gift with no picture the height of
                            one that has a picture — a card that is mostly empty
                            box, which reads as something failing to load. */}
                        <ul class="grid list-none grid-cols-1 items-start gap-6 md:grid-cols-2 lg:grid-cols-3">
                          <For each={group().items.map((item) => item.id)}>
                            {(id) => (
                              <li class="flex">
                                <Show when={itemsById().get(id)}>
                                  {(item) => (
                                    <GiftRegistryItemCard
                                      item={item()}
                                      currency={registry()?.currency ?? ""}
                                      imageBase={imageBase(item())}
                                      claim={claims().get(id)}
                                      canClaim={signedIn()}
                                      busy={busyItem() === id}
                                      onClaim={(claimBody) =>
                                        claimItem(id, item().title, claimBody)
                                      }
                                      onRelease={() => void releaseItem(id, item().title)}
                                    />
                                  )}
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </section>
                    )}
                  </Show>
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </section>
  );
}
