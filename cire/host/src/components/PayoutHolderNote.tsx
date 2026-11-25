import { proseLinkClass } from "@cire/ui/button";
import { Show } from "solid-js";

import { followInApp, type InAppLink } from "../lib/link-click";

/**
 * Why the person who holds the wedding's Stripe account cannot leave, be
 * removed or stop being an owner (the API's 409 `holds_payout_account`), and
 * where the account is handed over: Money gifts. `name` is how the hosts panel
 * names their seat; `null` is the reader's own seat.
 *
 * Shown to owners only: `GET /hosts` marks the holder's seat for an owner
 * reading it and for no one else, so an editor is never told whose account it
 * is.
 */
function holderWords(name: string | null): { before: string; after: string } {
  return name === null
    ? {
        before:
          "You connected the Stripe account money gifts are paid into. Hand money gifts to another owner or disconnect your account in ",
        after: " before you leave or step down.",
      }
    : {
        before: `${name} connected the Stripe account money gifts are paid into. Before ${name} can leave or stop being an owner, the account has to be handed over: ${name} can hand money gifts to another owner or disconnect it, or you can replace it with your own account in `,
        after: ".",
      };
}

/** The note as one sentence, for a toast. */
export function payoutHolderSentence(name: string | null): string {
  const { before, after } = holderWords(name);
  return `${before}Money gifts${after}`;
}

/**
 * The note on the page, with "Money gifts" a link through the dashboard where
 * the reader can open it (the registry module comes with Gold; below it the
 * words stand alone). `id` is what the disabled controls it explains name in
 * their `aria-describedby`.
 */
export default function PayoutHolderNote(props: {
  id: string;
  name: string | null;
  moneyGifts?: InAppLink;
  class?: string;
  testId?: string;
}) {
  const words = () => holderWords(props.name);
  return (
    <p
      id={props.id}
      data-testid={props.testId ?? "payout-holder-note"}
      class={`font-body text-text-muted text-ui-sm leading-ui-snug [overflow-wrap:anywhere] ${props.class ?? ""}`}
    >
      {words().before}
      <Show when={props.moneyGifts} fallback="Money gifts">
        {(link) => (
          <a href={link().href} class={proseLinkClass()} onClick={followInApp(link())}>
            Money gifts
          </a>
        )}
      </Show>
      {words().after}
    </p>
  );
}
