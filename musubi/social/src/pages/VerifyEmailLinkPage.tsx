import { ConfirmLinkPage } from "@osn/auth-ui/ConfirmLinkPage";
import { emailLinkPurpose } from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { useParams } from "@solidjs/router";
import { createResource, Match, Show, Switch, type JSX } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { emailLinkClient } from "../lib/authClients";
import { emailLinkSecret } from "../lib/email-link";

/**
 * `/verify/<request id>`: the page an emailed link opens. A bare route — no
 * app shell, no `AuthProvider` — with the product's name above the card, so a
 * person who arrived from their mail knows which site this is.
 *
 * `index.tsx` has already taken the link's secret off the address bar. This
 * page reads the candidates with it, then hands `ConfirmLinkPage` the list
 * and the confirm call. The confirm step requires the number shown on the
 * waiting screen, so the person picks it here.
 *
 * Confirming never signs this browser in: the tab that began the sign-up holds
 * the claim secret and finishes there, on this device or another. So the page
 * offers no Continue; it sends the person back to where they began.
 */
export function VerifyEmailLinkPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = () => params.requestId ?? "";
  const purpose = () => emailLinkPurpose(requestId());

  // One read, after the page mounts; never a confirm. A link with no secret
  // (opened again after a reload, or cut short) is a dead link here.
  const [read, { refetch }] = createResource(
    () => (purpose() ? requestId() : null),
    async (id) => {
      const secret = emailLinkSecret(id);
      if (!secret) return { status: "expired" as const };
      return emailLinkClient.candidates(id, secret);
    },
  );

  const confirm = async (pick: string) => {
    const secret = emailLinkSecret(requestId());
    if (!secret) return "expired" as const;
    return emailLinkClient.confirm(requestId(), { linkSecret: secret, pick });
  };

  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p class="text-foreground text-title text-center font-medium" translate="no">
        {PRODUCT_NAME}
      </p>
      <Switch>
        <Match when={!purpose()}>
          <DeadLink />
        </Match>
        <Match when={read.error}>
          <Notice heading="We couldn't open this link just now">
            <p class="text-muted-foreground text-body mt-2" role="alert">
              Check your connection, then try again.
            </p>
            <Button class="mt-4" onClick={() => void refetch()}>
              Try again
            </Button>
          </Notice>
        </Match>
        <Match when={read.loading || !read()}>
          <p class="text-muted-foreground text-body text-center">Checking this link…</p>
        </Match>
        <Match when={read()?.status === "expired"}>
          <DeadLink />
        </Match>
        <Match when={read()?.status === "confirmed"}>
          <Notice heading="Confirmed">
            <p class="text-muted-foreground text-body mt-2">
              Go back to where you started to finish. You can close this page.
            </p>
          </Notice>
        </Match>
        <Match when={read()?.status === "ready" ? read() : null}>
          {(ready) => (
            <Show when={purpose()}>
              {(flow) => (
                <ConfirmLinkPage
                  purpose={flow()}
                  candidates={
                    (ready() as { readonly candidates: readonly string[] }).candidates as string[]
                  }
                  onConfirm={confirm}
                />
              )}
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  );
}

/** A card in `AuthorizePage`'s dead-request style. */
function Notice(props: { heading: string; children: JSX.Element }) {
  return (
    <div class="border-border rounded-card border p-6 text-center">
      <h1 class="text-foreground text-title font-medium">{props.heading}</h1>
      {props.children}
    </div>
  );
}

function DeadLink() {
  return (
    <Notice heading="This link no longer works">
      <p class="text-muted-foreground text-body mt-2">
        It has expired or was already used. Go back to where you started, and ask for a new link if
        you need one.
      </p>
    </Notice>
  );
}
