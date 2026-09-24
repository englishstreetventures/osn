import { Button, buttonVariants } from "@shared/ui/ui/button";
import { A } from "@solidjs/router";
import { createResource, createSignal, Show } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { recoveryClient } from "../lib/authClients";
import { dismissRecoveryPrompt, isRecoveryPromptDismissed } from "../lib/recovery-codes-prompt";
import { getTokenClaims } from "../lib/utils";

/**
 * Offers recovery-code setup to an account that has never generated a set.
 *
 * An account finishes signup with one passkey and nothing else: no recovery
 * codes and no authenticator app. A recovery code is the only way back in that
 * needs neither the account's mailbox nor a second device, and it is the only
 * recovery factor that returns an ordinary session rather than a restricted
 * one good for fifteen minutes and a single passkey enrolment. Nothing else in
 * the app says the codes exist — they sit behind the Security tab of Settings,
 * which is where this points.
 *
 * `generatedAt === null` from `GET /recovery/status` is the condition: it means
 * the account holds no recovery-code rows at all. The count is deliberately
 * re-read on each load rather than remembered, because that answer can go back
 * to `null` on a live account — scheduling an account deletion erases every
 * recovery code, and cancelling inside the grace window restores the account
 * without re-minting them.
 *
 * A status that cannot be read shows nothing. Offering codes to somebody who
 * already has them is worse than staying quiet, and the offer returns on the
 * next load.
 *
 * App-local rather than shared: the copy names this product and the link names
 * a route only this app has. See `wiki/shared/osn-and-musubi.md`.
 */
export function RecoveryCodesPrompt(props: { accessToken: string }) {
  const profileId = () => getTokenClaims(props.accessToken).profileId;

  // Tracked separately from storage so a dismissal takes effect at once, and
  // re-derived from the profile id so switching profile asks the new one.
  const [justDismissed, setJustDismissed] = createSignal<string | null>(null);
  const dismissed = () => {
    const id = profileId();
    if (id === null) return true;
    return justDismissed() === id || isRecoveryPromptDismissed(id);
  };

  // A dismissed prompt never reaches the network: the source stays null and
  // the fetcher does not run.
  const [status] = createResource(
    () => (dismissed() ? null : props.accessToken),
    (accessToken) => recoveryClient.getRecoveryCodesStatus({ accessToken }),
  );

  // `dismissed()` is checked here as well as in the resource's source. A Solid
  // resource keeps its last value when its source goes falsy, so a dismissal
  // stops the next fetch but does not retract the answer already in hand.
  const visible = () => !dismissed() && status.state === "ready" && status()?.generatedAt === null;

  function dismiss() {
    const id = profileId();
    setJustDismissed(id);
    dismissRecoveryPrompt(id);
  }

  return (
    <Show when={visible()}>
      {/* The top padding is inside this branch on purpose: this component is
          the only thing that knows whether the status read cleared it to
          render, and a wrapper outside it would leave dead vertical space on
          every route for the accounts that already have codes. */}
      <div class="border-border bg-muted/40 mt-6 flex flex-col gap-2 rounded-md border p-3 md:mt-8">
        <div class="flex items-start justify-between gap-2">
          <span class="font-medium">Set up recovery codes</span>
          <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss">
            &#10005;
          </Button>
        </div>
        <p class="text-muted-foreground text-sm">
          If you lose your passkey, a recovery code gets you back into {PRODUCT_NAME} without your
          email or another device. You get ten single-use codes to keep somewhere safe.
        </p>
        <div class="flex justify-end">
          <A href="/settings#security" class={buttonVariants({ variant: "outline", size: "sm" })}>
            Go to Security settings
          </A>
        </div>
      </div>
    </Show>
  );
}
