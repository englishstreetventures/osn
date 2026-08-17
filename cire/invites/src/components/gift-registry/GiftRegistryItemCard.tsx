import { createEffect, createMemo, createSignal, Show } from "solid-js";

import {
  formatGiftPrice,
  giftRegistryExternalHref,
  giftRegistryRemaining,
  giftRegistryRemainingCopy,
  GIFT_REGISTRY_MAX_QUANTITY,
  type GiftRegistryClaimBody,
  type GiftRegistryHouseholdClaim,
  type GiftRegistryItem,
} from "../../lib/gift-registry";
import { buildSrcSet, variantSrc } from "../invite-images";

/**
 * One gift on the couple's list, as a guest sees it.
 *
 * THE PRIVACY PROPERTY THIS COMPONENT EXISTS TO KEEP: a guest sees COUNTS, never
 * names. "1 of 2 left" and nothing else. Who reserved a gift, what anyone spent,
 * and any running total are the couple's alone. That is enforced at the API —
 * the public read never selects a claimant identity — and this card must never
 * become the place it leaks back in. The ONLY name this component may ever
 * render is the household's OWN `displayName`, echoed back inside its own claim,
 * and only because that household typed it.
 *
 * A CLAIM IS NOT A PURCHASE. The guest reserves; nothing is charged, nothing is
 * sent. The copy says "reserve" throughout for that reason.
 */

/**
 * The image box's shape. Exported for the drift guard in the tests: it exists
 * BOTH as the literal `aspect-[4/3]` inside {@link GIFT_CARD_IMAGE_CLASS} — the
 * Tailwind scanner reads source text, so a computed class emits no CSS at all —
 * and as this number in the card's `contain-intrinsic-size` reserve. The two
 * have to be asserted equal rather than trusted.
 */
export const GIFT_CARD_IMAGE_ASPECT = 4 / 3;

/** The image box: a fixed 4∶3 frame, centre-cropped, so a grid of mixed source
 *  shapes reads as one list rather than a ragged collage. */
export const GIFT_CARD_IMAGE_CLASS = "aspect-[4/3] w-full object-cover";

export interface GiftRegistryItemCardProps {
  item: GiftRegistryItem;
  /** The wedding's one primary currency, from the registry payload. */
  currency: string;
  /** Base image URL for this item (no `?variant=` yet), or null for no image. */
  imageBase: string | null;
  /** THIS household's own claim on this item, if it has one. */
  claim: GiftRegistryHouseholdClaim | undefined;
  /** Whether a claim/release control may be shown at all (i.e. signed in). */
  canClaim: boolean;
  /** A write on THIS card is in flight. */
  busy: boolean;
  /** Resolves `true` when the claim landed, which closes the form. */
  onClaim: (body: GiftRegistryClaimBody) => Promise<boolean>;
  onRelease: () => void;
}

export function GiftRegistryItemCard(props: GiftRegistryItemCardProps) {
  const [open, setOpen] = createSignal(false);
  /**
   * The box's TEXT, not a number — so it can be empty while the guest retypes it.
   *
   * A numeric signal bound back into `value` makes the field un-editable in a way
   * that also loses data: clearing it writes `Number("") === 0` and snaps the box
   * to "0", and clearing THAT sets 0 → 0, which notifies nothing, so no write-back
   * happens and the box stays visibly empty. An empty `<input type="number">`
   * passes native validation (`min` constrains a value, and there is none), so the
   * guest reaches Confirm and posts 0 — which the server rejects as out of range
   * and the card reports as "That number is not available any more. Pick a smaller
   * one", advice that is nonsense for a number they never chose. Keeping the raw
   * string and bounding it on the way out (see {@link submit}) fixes both halves.
   */
  const [quantityText, setQuantityText] = createSignal("1");
  const [note, setNote] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");

  const remaining = createMemo(() => giftRegistryRemaining(props.item));

  /**
   * The most this household may reserve.
   *
   * `quantityClaimed` counts EVERY live claim including this household's own, so
   * `remaining` alone would refuse a guest raising their own reservation from 1
   * to 2 on a 2-wanted item. The server's guard excludes this family's row for
   * exactly that reason (the claim is an upsert, not an addition) — this mirrors
   * it, so the input can never offer a number the API will reject.
   */
  const maxQuantity = createMemo(() =>
    Math.min(GIFT_REGISTRY_MAX_QUANTITY, remaining() + (props.claim?.quantity ?? 0)),
  );

  const price = createMemo(() => formatGiftPrice(props.item.priceMinor, props.currency));

  /**
   * The shop link, re-checked HERE rather than trusted from the column.
   *
   * The API validates on write; this is the second half of the same gate at the
   * render site (CON-S-L2 — a `vendor.privacyUrl` reached an `href` unchecked and
   * `javascript:` was therefore a same-origin script sink). A row can also arrive
   * from a migration or a restored backup, which never passed that write path.
   * `null` ⇒ no link is rendered at all.
   */
  const externalHref = createMemo(() => giftRegistryExternalHref(props.item.externalUrl));

  const canReserveMore = createMemo(() => maxQuantity() >= 1);

  /**
   * Close an open form the moment the ceiling reaches zero.
   *
   * The 409 race leaves the form open on purpose — the guest's words are worth
   * more than the race they lost. But when the re-read says nothing is left at
   * all, the form holds `min="1"` beside `max="0"`: a Confirm that can only be
   * refused, under a message that already said another household took the last
   * one. Conditioned on the CEILING, never on the 409 itself, because the API
   * also answers 409 when other households' live claims exceed what is left
   * while some remain — there the form is still useful and stays open.
   */
  createEffect(() => {
    if (!canReserveMore()) setOpen(false);
  });

  function openForm() {
    // Open on what they already reserved, so the form reads as "change this"
    // rather than starting them back at 1.
    setQuantityText(String(Math.min(Math.max(1, props.claim?.quantity ?? 1), maxQuantity())));
    setNote(props.claim?.note ?? "");
    setDisplayName(props.claim?.displayName ?? "");
    setOpen(true);
  }

  /**
   * What the box's text means as a quantity: a whole number the API can accept.
   *
   * Empty, blank, "abc", "1e3", "-2", "2.5" and anything above the ceiling all
   * land inside 1…`maxQuantity()` here rather than on the wire. The clamp lives
   * on submit, not on every keystroke: bounding as they type would fight the
   * guest mid-edit, rewriting "1" to the ceiling before they finish typing "12".
   */
  function boundedQuantity(): number {
    const parsed = Math.floor(Number(quantityText().trim()));
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(Math.max(1, parsed), Math.max(1, maxQuantity()));
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmedNote = note().trim();
    const trimmedName = displayName().trim();
    const quantity = boundedQuantity();
    // Show them what was actually sent, so a form left open by a 409 does not
    // still read as the empty box or the out-of-range number they typed.
    setQuantityText(String(quantity));
    const landed = await props.onClaim({
      quantity,
      // Empty means "I said nothing", which is `null` on the wire, not `""`.
      note: trimmedNote === "" ? null : trimmedNote,
      displayName: trimmedName === "" ? null : trimmedName,
    });
    // Only close on success. A 409 leaves the form open on purpose: the counts
    // beside it have just been refreshed, so the guest can see what changed and
    // decide, instead of having their words thrown away by a race they lost.
    if (landed) setOpen(false);
  }

  return (
    <article
      data-gift-item={props.item.id}
      class="border-border bg-surface-raised flex flex-col overflow-hidden rounded-sm border text-left"
      // Reserve roughly a card while the section is skipped by
      // `content-visibility`, so scrolling into a long list doesn't jump.
      style={{ "contain-intrinsic-size": "auto 22rem" }}
    >
      <Show when={props.imageBase}>
        {(base) => (
          <img
            src={variantSrc(base(), "card")}
            srcset={buildSrcSet(base(), ["thumb", "card"])}
            // One column on a phone, two from `md`, three from `lg` inside a
            // 64rem shell — so a card is never wider than ~21rem on a desktop.
            sizes="(min-width: 1024px) 21rem, (min-width: 768px) 45vw, 100vw"
            alt=""
            loading="lazy"
            decoding="async"
            class={GIFT_CARD_IMAGE_CLASS}
          />
        )}
      </Show>

      <div class="flex flex-1 flex-col gap-3 p-5">
        <h3 class="font-display text-text text-[1.05rem] leading-snug font-light">
          {props.item.title}
        </h3>

        <Show when={props.item.description}>
          {(description) => (
            <p class="font-body text-text-muted text-[0.85rem] leading-[1.6] break-words whitespace-pre-line">
              {description()}
            </p>
          )}
        </Show>

        <Show when={price()}>
          {(amount) => <p class="font-body text-gold-ink text-[0.9rem]">{amount()}</p>}
        </Show>

        {/* COUNTS ONLY. Never a name, never a total. */}
        <p
          data-gift-remaining
          class="font-body text-text-muted text-[0.72rem] tracking-[0.14em] uppercase"
        >
          {giftRegistryRemainingCopy(props.item)}
        </p>

        <Show when={externalHref()}>
          {(href) => (
            <a
              href={href()}
              // A shop is someone else's site: open it away from the invite so a
              // guest never loses their place, and hand it no `window.opener`
              // handle back to this page.
              target="_blank"
              rel="noopener noreferrer"
              class="font-body text-text-muted hover:text-gold-ink focus-visible:ring-gold/60 self-start rounded-sm text-[0.78rem] underline underline-offset-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2"
            >
              View this gift
            </a>
          )}
        </Show>

        {/* This household's own reservation, echoed back. The only place a name
            may appear — and it is their own, which they typed. */}
        <Show when={props.claim}>
          {(claim) => (
            <p
              data-gift-mine
              class="border-gold/40 bg-gold/5 text-gold-ink font-body rounded-sm border px-3 py-2 text-[0.78rem]"
            >
              You reserved {claim().quantity === 1 ? "this" : `${claim().quantity} of these`}
              <Show when={claim().displayName}>{(name) => <> as {name()}</>}</Show>.
            </p>
          )}
        </Show>

        <div class="mt-auto flex flex-wrap items-center gap-3 pt-2">
          {/* Fully reserved by OTHER households — said once, for everyone,
              signed in or not. Still a count, still no name. */}
          <Show when={!props.claim && remaining() === 0}>
            <p class="font-body text-text-muted text-[0.78rem]">
              Another guest has this one covered.
            </p>
          </Show>
          <Show when={props.canClaim && !open()}>
            <Show when={canReserveMore()}>
              <button
                type="button"
                disabled={props.busy}
                onClick={openForm}
                class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink rounded-sm border bg-transparent px-4 py-2.5 text-[0.8rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {props.claim ? "Change" : "Reserve"}
              </button>
            </Show>
            <Show when={props.claim}>
              <button
                type="button"
                disabled={props.busy}
                onClick={() => props.onRelease()}
                class="font-body text-text-muted hover:text-gold-ink focus-visible:ring-gold/60 rounded-sm px-1 text-[0.78rem] underline underline-offset-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Release
              </button>
            </Show>
          </Show>
        </div>

        {/* The form is INLINE, not an overlay. Deliberate: a `transform` on any
            ancestor traps `position: fixed` against that ancestor, and this card
            sits inside animated sections — an inline form has no such hazard to
            get wrong, and keeps the counts it depends on visible while the guest
            fills it in. */}
        {/* `canClaim` gates the form as well as the buttons: a session that
            lapses mid-visit (the 401 branch) drops this household back to the
            signed-out surface, and leaving an open form behind would leave a
            Confirm that can only 401 again. */}
        <Show when={open() && props.canClaim}>
          <form class="flex flex-col gap-3 pt-1" onSubmit={submit}>
            <label class="font-body text-text-muted flex flex-col gap-1 text-[0.72rem] tracking-[0.14em] uppercase">
              How many
              <input
                type="number"
                min="1"
                max={maxQuantity()}
                step="1"
                value={quantityText()}
                onInput={(e) => setQuantityText(e.currentTarget.value)}
                class="border-text/55 bg-text/[0.045] font-body text-text focus:border-gold w-full rounded-sm border px-3 py-2 text-[0.9rem] tracking-normal normal-case transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
              />
            </label>

            <label class="font-body text-text-muted flex flex-col gap-1 text-[0.72rem] tracking-[0.14em] uppercase">
              From (optional)
              <input
                type="text"
                maxlength="80"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                placeholder="The Ashworths"
                class="border-text/55 bg-text/[0.045] font-body text-text placeholder:text-text-muted focus:border-gold w-full rounded-sm border px-3 py-2 text-[0.9rem] tracking-normal normal-case transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
              />
            </label>

            <label class="font-body text-text-muted flex flex-col gap-1 text-[0.72rem] tracking-[0.14em] uppercase">
              Note for the couple (optional)
              <textarea
                rows="2"
                maxlength="500"
                value={note()}
                onInput={(e) => setNote(e.currentTarget.value)}
                class="border-text/55 bg-text/[0.045] font-body text-text placeholder:text-text-muted focus:border-gold w-full resize-y rounded-sm border px-3 py-2 text-[0.9rem] tracking-normal normal-case transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
              />
            </label>

            <div class="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={props.busy}
                class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg disabled:hover:text-gold-ink rounded-sm border bg-transparent px-4 py-2.5 text-[0.8rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {props.busy ? "Saving" : "Confirm"}
              </button>
              <button
                type="button"
                disabled={props.busy}
                onClick={() => setOpen(false)}
                class="font-body text-text-muted hover:text-gold-ink focus-visible:ring-gold/60 rounded-sm px-1 text-[0.78rem] underline underline-offset-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </div>
    </article>
  );
}
