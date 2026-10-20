import Button from "@cire/ui/button";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import {
  contributeGift,
  formatGiftPrice,
  GIFT_AMOUNT_PRESETS_MINOR,
  parseGiftAmountMinor,
  type GiftContributionResult,
  type GiftRegistryFund,
} from "../../lib/gift-registry";
import { variantSrc } from "../invite-images";

/**
 * GIVING MONEY, on the couple's gift page.
 *
 * IT IS ALWAYS HERE, whether or not anything is left on the list. A guest who
 * finds every gift taken has not stopped wanting to give something, and a
 * money option that only appears once the list runs dry reads as a consolation
 * prize. It sits under the ledger, above the shelves, in the same place every
 * time.
 *
 * WHAT IT DOES NOT DO. It takes no card details and knows no card details: the
 * button hands the guest to Stripe's own hosted page, which is the only place
 * a number is typed. Nothing is recorded when they leave — the gift is written
 * when Stripe says the money moved, which is the only party that knows.
 *
 * WHAT THE COUPLE SEE, and what nobody else does: the name and note a guest
 * writes here go to the couple's gift log. They are never on this page, in any
 * state, for any visitor — the same rule the item cards keep.
 *
 * THE AMOUNT IS TYPED IN MAJOR UNITS because that is what people type ("50",
 * not "5000"), and converted once, in `parseGiftAmountMinor`, using the same
 * exponent the prices are formatted with. JPY has no minor unit and KWD has
 * three; a fixed ×100 here would be wrong by 100× on a payment screen.
 *
 * THE COUPLE'S CASH FUNDS are a choice of where the money goes, above the
 * amount: "wherever they choose" first and chosen, then each fund by its name,
 * picture and the couple's words. Nothing else about a fund is here, and
 * nothing else exists on the wire to show: its goal and what has come in are
 * the couple's. A fund that closed while the page was open is said so, and the
 * page is asked for a fresh list.
 */

export interface GiftMoneyPanelProps {
  /** cire-api origin. */
  apiUrl: string;
  /** The wedding this page renders. */
  slug: string;
  /** The wedding's primary currency — what the presets are denominated in. */
  currency: string;
  /** Back to the invitation, for the one failure a guest can act on. */
  inviteHref: string;
  /**
   * The organiser's preview session, which never gives. The panel is shown as
   * a guest sees it, with its button disabled; the page says why.
   */
  preview?: boolean;
  /** The couple's cash funds, in list order. Absent or empty: no choice shown. */
  funds?: readonly GiftRegistryFund[];
  /** A fund's picture route, with no `?variant=` yet, or null for no picture. */
  fundImageBase?: (fund: GiftRegistryFund) => string | null;
  /** The fund the guest chose has closed: the page should read the list again. */
  onFundClosed?: () => void;
  /**
   * How the guest is handed to Stripe. A seam, not a setting: the one line
   * that leaves the site is the one line a test cannot let run, and stubbing
   * `window.location` wholesale breaks every later navigation in the file.
   */
  navigate?: (url: string) => void;
}

/** What the guest is told when the hand-off did not happen. */
export function giftMoneyMessage(result: GiftContributionResult): string {
  switch (result.kind) {
    case "ok":
      // The caller navigates; nothing is said, because the page is leaving.
      return "";
    case "unavailable":
      return "The couple aren’t taking money gifts at the moment.";
    case "fund-closed":
      return "That fund is no longer on the couple’s list. Choose another, or give to them directly.";
    case "signed-out":
      return "Your invite session has ended. Enter your invite code again on the invitation.";
    case "rate-limited":
      return result.retryAfterSeconds === null
        ? "That was a lot of tries at once. Give it a moment."
        : `That was a lot of tries at once. Try again in ${result.retryAfterSeconds} seconds.`;
    case "invalid":
      return "That amount is outside what this page can take. Try another.";
    case "preview":
      return "Preview mode. Nothing can be given from a preview.";
    case "error":
      return "Could not reach the payment page. Check your connection and try again.";
  }
}

export function GiftMoneyPanel(props: GiftMoneyPanelProps) {
  // `null` is the "Other" row: a preset is a number, and typing is its absence.
  const [preset, setPreset] = createSignal<number | null>(GIFT_AMOUNT_PRESETS_MINOR[0]);
  // The fund the money goes to, by id; `null` is "wherever they choose".
  const [fundId, setFundId] = createSignal<string | null>(null);
  const funds = createMemo(() => props.funds ?? []);
  // A fund the couple removed leaves the list on the next read. A choice that
  // still named it would send money nowhere the page shows, so it goes back
  // to the couple in general.
  createEffect(() => {
    const chosen = fundId();
    if (chosen !== null && !funds().some((fund) => fund.id === chosen)) setFundId(null);
  });
  const [customText, setCustomText] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  /** The amount as the server would read it, or `null` while it is unusable. */
  const amountMinor = createMemo(() => {
    const chosen = preset();
    if (chosen !== null) return chosen;
    return parseGiftAmountMinor(customText(), props.currency);
  });

  const priceLabel = (minor: number) => formatGiftPrice(minor, props.currency) ?? String(minor);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const amount = amountMinor();
    if (amount === null || busy() || props.preview) return;
    setBusy(true);
    setStatus("");
    const trimmedName = displayName().trim();
    const trimmedMessage = message().trim();
    const result = await contributeGift(props.apiUrl, props.slug, {
      amountMinor: amount,
      itemId: fundId(),
      // Empty means "I said nothing", which is `null` on the wire, not `""`.
      displayName: trimmedName === "" ? null : trimmedName,
      message: trimmedMessage === "" ? null : trimmedMessage,
    });
    if (result.kind === "ok") {
      // The hand-off. `assign`, not `replace`: the browser's back button should
      // bring a guest who changes their mind back to the couple's list.
      const go = props.navigate ?? ((url: string) => window.location.assign(url));
      go(result.url);
      return;
    }
    setBusy(false);
    setStatus(giftMoneyMessage(result));
    if (result.kind === "fund-closed") props.onFundClosed?.();
  }

  return (
    <section
      data-gift-money
      class="border-border max-w-ui-md mx-auto mb-10 rounded-sm border px-5 py-6 text-center"
    >
      <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-2 uppercase">Give money</p>
      <p class="font-body text-text-muted text-ui-base leading-ui-normal mb-5">
        Straight to the couple, whether or not anything is left on the list.
      </p>

      <form onSubmit={(event) => void submit(event)}>
        {/* Where the money goes. Radio-shaped for the same reason the amounts
            are: one choice, heard as a choice. Each fund is its name, its
            picture and the couple's words — the picture is decoration
            (`alt=""`), since the name beside it says what it is. */}
        <Show when={funds().length > 0}>
          <fieldset data-gift-money-funds class="mb-6 border-0 p-0 text-left">
            <legend class="font-body text-text-muted text-ui-sm mb-2">What it’s for</legend>
            <div class="flex flex-col gap-2">
              <label
                class="font-body focus-within:ring-gold/60 flex cursor-pointer items-center gap-3 rounded-sm border px-4 py-3 transition-colors duration-200 focus-within:ring-2"
                classList={{
                  "border-gold bg-gold/5": fundId() === null,
                  "border-border": fundId() !== null,
                }}
              >
                <input
                  type="radio"
                  name="gift-fund"
                  class="sr-only"
                  checked={fundId() === null}
                  onChange={() => setFundId(null)}
                />
                <span class="text-text text-ui-base">Wherever they choose</span>
              </label>
              <For each={funds()}>
                {(fund) => (
                  <label
                    data-gift-money-fund={fund.id}
                    class="font-body focus-within:ring-gold/60 flex cursor-pointer items-start gap-3 rounded-sm border px-4 py-3 transition-colors duration-200 focus-within:ring-2"
                    classList={{
                      "border-gold bg-gold/5": fundId() === fund.id,
                      "border-border": fundId() !== fund.id,
                    }}
                  >
                    <input
                      type="radio"
                      name="gift-fund"
                      class="sr-only"
                      checked={fundId() === fund.id}
                      onChange={() => setFundId(fund.id)}
                    />
                    <Show when={props.fundImageBase?.(fund)}>
                      {(base) => (
                        <img
                          src={variantSrc(base(), "thumb")}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          class="border-border aspect-4/3 w-20 shrink-0 rounded-sm border object-cover"
                        />
                      )}
                    </Show>
                    <span class="flex min-w-0 flex-col gap-1">
                      <span class="font-display text-text text-ui-md leading-snug font-light break-words">
                        {fund.title}
                      </span>
                      <Show when={fund.description}>
                        {(description) => (
                          <span class="text-text-muted text-ui-sm leading-ui-normal break-words whitespace-pre-line">
                            {description()}
                          </span>
                        )}
                      </Show>
                    </span>
                  </label>
                )}
              </For>
            </div>
          </fieldset>
        </Show>

        {/* The presets are radio-shaped, not buttons: only one amount is being
            given, and a screen reader should hear a choice rather than four
            things to press. */}
        <fieldset class="mb-5 border-0 p-0">
          <legend class="sr-only">How much to give</legend>
          <div class="flex flex-wrap justify-center gap-2">
            <For each={GIFT_AMOUNT_PRESETS_MINOR}>
              {(minor) => (
                <label
                  class="font-body focus-within:ring-gold/60 text-ui-sm cursor-pointer rounded-sm border px-4 py-2 transition-colors duration-200 focus-within:ring-2"
                  classList={{
                    "border-gold text-gold-ink bg-gold/5": preset() === minor,
                    "border-border text-text-muted": preset() !== minor,
                  }}
                >
                  <input
                    type="radio"
                    name="gift-amount"
                    class="sr-only"
                    checked={preset() === minor}
                    onChange={() => setPreset(minor)}
                  />
                  {priceLabel(minor)}
                </label>
              )}
            </For>
            <label
              class="font-body focus-within:ring-gold/60 text-ui-sm cursor-pointer rounded-sm border px-4 py-2 transition-colors duration-200 focus-within:ring-2"
              classList={{
                "border-gold text-gold-ink bg-gold/5": preset() === null,
                "border-border text-text-muted": preset() !== null,
              }}
            >
              <input
                type="radio"
                name="gift-amount"
                class="sr-only"
                checked={preset() === null}
                onChange={() => setPreset(null)}
              />
              Another amount
            </label>
          </div>
        </fieldset>

        <Show when={preset() === null}>
          <label class="font-body text-text-muted text-ui-sm mb-5 block">
            <span class="mb-1 block">Amount ({props.currency})</span>
            <input
              data-gift-money-amount
              type="text"
              inputmode="decimal"
              value={customText()}
              onInput={(event) => setCustomText(event.currentTarget.value)}
              class="border-border bg-text/[0.045] font-body text-text focus:border-gold text-ui-base mx-auto w-40 rounded-sm border px-3 py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
            />
          </label>
        </Show>

        <div class="mx-auto mb-5 flex max-w-104 flex-col gap-3 text-left">
          <label class="font-body text-text-muted text-ui-sm">
            <span class="mb-1 block">Your name (optional)</span>
            <input
              type="text"
              maxlength="120"
              value={displayName()}
              onInput={(event) => setDisplayName(event.currentTarget.value)}
              class="border-border bg-text/[0.045] font-body text-text focus:border-gold text-ui-base w-full rounded-sm border px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
            />
          </label>
          <label class="font-body text-text-muted text-ui-sm">
            <span class="mb-1 block">A note for them (optional)</span>
            <textarea
              rows="2"
              maxlength="400"
              value={message()}
              onInput={(event) => setMessage(event.currentTarget.value)}
              class="border-border bg-text/[0.045] font-body text-text focus:border-gold text-ui-base w-full rounded-sm border px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
            />
          </label>
        </div>

        <Button
          type="submit"
          variant="cta"
          size="lg"
          disabled={amountMinor() === null || busy() || props.preview === true}
        >
          {busy() ? "Taking you to pay…" : "Continue to payment"}
        </Button>

        {/* Said before they press, not after: where they are about to go, and
            who sees what they just typed. */}
        <p class="font-body text-text-muted text-ui-xs leading-ui-normal mt-3">
          You’ll pay on Stripe’s own page. Your name and note go to the couple — never to the other
          guests.
        </p>

        <p
          data-gift-money-status
          role="status"
          aria-live="polite"
          class="font-body text-text text-ui-sm leading-ui-normal mt-3 min-h-5"
        >
          {status()}
        </p>

        <Show when={status() !== "" && props.inviteHref}>
          <Show when={status().includes("invite code")}>
            <a
              href={props.inviteHref}
              class="font-body text-gold-ink focus-visible:ring-gold/60 text-ui-sm rounded-sm underline underline-offset-4 focus:outline-none focus-visible:ring-2"
            >
              Open the invitation
            </a>
          </Show>
        </Show>
      </form>
    </section>
  );
}
