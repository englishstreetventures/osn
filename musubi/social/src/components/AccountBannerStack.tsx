import { clsx } from "@shared/ui/lib/utils";
import { createSignal, Show } from "solid-js";

import { RecoveryCodesPrompt } from "./RecoveryCodesPrompt";
import SecurityEventsBannerMount from "./SecurityEventsBannerMount";

/**
 * The account-health banners, stacked above the page on every route a signed-in
 * user sees.
 *
 * Exactly one of them shows at a time, and security events win. An
 * unacknowledged security event is something that already happened to the
 * account and takes a step-up ceremony to clear, so it stays on screen for as
 * long as the user leaves it; a recovery-code offer is housekeeping. Running
 * both would be ordinary rather than rare — most of the eighteen event kinds
 * the server records, adding a passkey and signing in from a second device
 * among them, sit happily on an account that has never generated a code.
 *
 * The recovery prompt waits for a settled count rather than an empty one, so
 * it never appears for an instant and then gives way to a security event that
 * was still in flight.
 *
 * Vertical space belongs to whichever banner is showing, never to this
 * container: on the common route where neither has anything to say, an empty
 * stack must take up no room at all. The two get there differently, and the
 * asymmetry is not an oversight. `SecurityEventsBanner` is shared code that
 * reports its count but not its layout, so its padding is applied here from
 * that count. `RecoveryCodesPrompt` is this app's own and is the only thing
 * that knows whether its status read cleared it to render, so it carries its
 * own.
 */
export default function AccountBannerStack(props: { accessToken: string }) {
  const [eventCount, setEventCount] = createSignal<number | null>(null);
  const showingEvents = () => (eventCount() ?? 0) > 0;

  return (
    <div class="mx-auto w-full max-w-2xl px-4 md:px-8">
      <div class={clsx(showingEvents() && "pt-6 md:pt-8")}>
        <SecurityEventsBannerMount
          accessToken={props.accessToken}
          onVisibleCountChange={setEventCount}
        />
      </div>
      <Show when={eventCount() === 0}>
        <RecoveryCodesPrompt accessToken={props.accessToken} />
      </Show>
    </div>
  );
}
