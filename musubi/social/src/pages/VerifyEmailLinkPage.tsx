import {
  ConfirmLinkPage,
  type ConfirmLinkPurpose,
  type ConfirmOutcome,
} from "@osn/auth-ui/ConfirmLinkPage";
import { emailLinkPurpose, type EmailLinkCandidates } from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { useParams } from "@solidjs/router";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { emailLinkClient } from "../lib/authClients";
import { emailLinkSecret } from "../lib/email-link";

const CHECKING_LINE = "Checking this link…";
const FAILED_HEADING = "We couldn't open this link just now";
const FAILED_LINE = "Check your connection, then try again.";

/**
 * `/verify/<request id>`: the page an emailed link opens. A bare route — no
 * app shell, no `AuthProvider` — with the product's name above the card, so a
 * person who arrived from their mail knows which site this is.
 *
 * `index.tsx` has already taken the link's secret off the address bar. This
 * page reads the candidates with it, then hands `ConfirmLinkPage` the list
 * and the confirm call. The confirm step requires the number shown on the
 * waiting screen, so the person picks it here, or says they did not ask. A
 * read that finds the request already confirmed, or refuses it, opens the
 * page on that answer instead, with nothing to pick. So does a link whose id
 * names no flow: every dead link is `ConfirmLinkPage`'s expired card.
 *
 * Confirming never signs this browser in: the tab that began the sign-up holds
 * the claim secret and finishes there, on this device or another. So the page
 * offers no Continue; it sends the person back to where they began.
 *
 * Every card on the route is `@shared/ui`'s `Card`: `ConfirmLinkPage`'s, and
 * the page's own card for a read that failed. While the read runs, a
 * placeholder in the ready card's shape holds its place, so the name above
 * does not move when the card arrives.
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

  // Set by Try again. The failed card's alert speaks the first failure as it
  // appears; each later one is said through the live region instead, because
  // the alert's text does not change between tries.
  const [retried, setRetried] = createSignal(false);

  // A failed read keeps `read.error` until the next try settles, so the
  // failed card stays up through a retry and its button shows the wait.
  const spoken = () => {
    if (read.loading) return CHECKING_LINE;
    if (read.error && retried()) return FAILED_LINE;
    return "";
  };

  // `pick` goes to the client exactly as the page gives it: a number, or
  // `null` for "I didn't ask for this".
  const confirm = async (pick: string | null): Promise<ConfirmOutcome> => {
    const secret = emailLinkSecret(requestId());
    if (!secret) return "expired";
    return emailLinkClient.confirm(requestId(), { linkSecret: secret, pick });
  };

  // Try again disables itself while the read runs, and a disabled button
  // loses focus to the page. The card's heading takes it instead, as
  // `ConfirmLinkPage`'s does when a tapped number disables itself.
  let failedHeading: HTMLHeadingElement | undefined;

  function retry() {
    setRetried(true);
    failedHeading?.focus();
    void refetch();
  }

  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      {/* Mounted from the start: a live region added with its text is not
          reliably read. `<output>` is a polite status. */}
      <output class="sr-only">{spoken()}</output>
      <p class="text-foreground text-title text-center font-medium" translate="no">
        {PRODUCT_NAME}
      </p>
      <Switch>
        <Match when={!purpose()}>
          <ConfirmLinkPage purpose="sign-up" initialOutcome="expired" onConfirm={confirm} />
        </Match>
        <Match when={read.error}>
          <Card padding="lg" class="flex flex-col gap-6">
            <div class="flex flex-col gap-2">
              <h1
                ref={failedHeading}
                tabindex="-1"
                class="text-foreground text-title font-medium focus:outline-none"
              >
                {FAILED_HEADING}
              </h1>
              <Notice tone="danger" size="inline" alert>
                {FAILED_LINE}
              </Notice>
            </div>
            <Button size="lg" class="w-full max-md:h-11" disabled={read.loading} onClick={retry}>
              {read.loading ? "Checking…" : "Try again"}
            </Button>
          </Card>
        </Match>
        <Match when={read.loading || !read()}>
          {/* The ready card's height with five numbers, on a 360–430px phone
              and from `md` up, so the name above it stays put when the card
              replaces it (`DESIGN.md` §Motion). */}
          <div aria-hidden="true" class="bg-muted/50 rounded-card h-138 animate-pulse md:h-130" />
        </Match>
        <Match when={read()}>
          {(answer) => (
            <Show when={purpose()}>
              {(flow) => <LinkCard purpose={flow()} read={answer()} onConfirm={confirm} />}
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  );
}

/** `ConfirmLinkPage` with the numbers read, or opened on the answer the read already gave. */
function LinkCard(props: {
  purpose: ConfirmLinkPurpose;
  read: EmailLinkCandidates;
  onConfirm: (pick: string | null) => Promise<ConfirmOutcome>;
}) {
  const ready = () => (props.read.status === "ready" ? props.read : null);
  const opening = () => (props.read.status === "ready" ? null : props.read.status);
  return (
    <Switch>
      <Match when={ready()}>
        {(list) => (
          <ConfirmLinkPage
            purpose={props.purpose}
            candidates={list().candidates}
            onConfirm={props.onConfirm}
          />
        )}
      </Match>
      <Match when={opening()}>
        {(answer) => (
          <ConfirmLinkPage
            purpose={props.purpose}
            initialOutcome={answer()}
            onConfirm={props.onConfirm}
          />
        )}
      </Match>
    </Switch>
  );
}
