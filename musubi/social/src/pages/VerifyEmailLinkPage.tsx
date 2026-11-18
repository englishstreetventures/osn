import {
  ConfirmLinkPage,
  type ConfirmLinkPurpose,
  type ConfirmOutcome,
} from "@osn/auth-ui/ConfirmLinkPage";
import { describeAuthError, emailLinkPurpose, type EmailLinkCandidates } from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { useParams } from "@solidjs/router";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";

import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { PRODUCT_NAME } from "../lib/auth";
import { emailLinkClient } from "../lib/authClients";
import { emailLinkSecret } from "../lib/email-link";

const CHECKING_LINE = "Checking this link…";
const FAILED_HEADING = "We couldn't open this link just now";

/**
 * `/verify/<request id>`: the page an emailed link opens. A bare route — no
 * app shell, no `AuthProvider` — with the product's name above the card, so a
 * person who arrived from their mail knows which site this is.
 *
 * `index.tsx` has already taken the link's secret off the address bar. The
 * confirm step requires the number shown on the waiting screen. For sign-up
 * this page reads the candidates with the secret and hands `ConfirmLinkPage`
 * the list, in the ascending order osn-api sends, and the confirm call; the
 * person picks the number among them. A
 * read that finds the request already confirmed, or refuses it, opens the
 * page on that answer instead, with nothing to pick. For recovery and
 * step-up — links to an account's own address that someone else may have
 * asked for — there is no list: the person types the number (`typeNumber`),
 * and the confirm call's answer is the page's only read. Either way they may
 * say they did not ask. A link whose id names no flow, or that has no
 * secret, opens on `ConfirmLinkPage`'s expired card: every dead link is that
 * card.
 *
 * Confirming never signs this browser in: the tab that began holds the claim
 * secret and finishes there, on this device or another. So the page offers no
 * Continue; it sends the person back to where they began.
 *
 * Every card on the route is `@shared/ui`'s `Card`: `ConfirmLinkPage`'s, and
 * the page's own card for a read that failed, whose line is the copy map's
 * sentence for the failure. While the read runs, a `Skeleton` in the ready
 * card's shape holds its place, so the name above does not move when the card
 * arrives.
 */
export function VerifyEmailLinkPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = () => params.requestId ?? "";
  const purpose = () => emailLinkPurpose(requestId());
  // Where the number is typed, there is nothing to read before the confirm.
  const typed = () => purpose() === "recovery" || purpose() === "step-up";

  // One read, after the page mounts; never a confirm. A link with no secret
  // (opened again after a reload, or cut short) is a dead link here.
  const [read, { refetch }] = createResource(
    () => (purpose() && !typed() ? requestId() : null),
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

  // What the failed card says: a lost connection, a wait or a server fault,
  // never the error's own text.
  const failedLine = () => describeAuthError(read.error);

  // A failed read keeps `read.error` until the next try settles, so the
  // failed card stays up through a retry and its button shows the wait.
  const spoken = () => {
    if (read.loading) return CHECKING_LINE;
    if (read.error && retried()) return failedLine();
    return "";
  };

  // `pick` goes to the client exactly as the page gives it: a number, or
  // `null` for "I didn't ask for this".
  const confirm = async (pick: string | null): Promise<ConfirmOutcome> => {
    const secret = emailLinkSecret(requestId());
    if (!secret) return "expired";
    return emailLinkClient.confirm(requestId(), { linkSecret: secret, pick });
  };

  // Try again is busy while the read runs: it keeps focus and refuses a press.
  function retry() {
    if (read.loading) return;
    setRetried(true);
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
          <ConfirmLinkPage
            purpose="sign-up"
            initialOutcome="expired"
            showLockoutRule={false}
            onConfirm={confirm}
          />
        </Match>
        <Match when={typed() && !emailLinkSecret(requestId()) && purpose()}>
          {(flow) => (
            <ConfirmLinkPage purpose={flow()} initialOutcome="expired" onConfirm={confirm} />
          )}
        </Match>
        <Match when={typed() && purpose()}>
          {(flow) => <ConfirmLinkPage purpose={flow()} typeNumber onConfirm={confirm} />}
        </Match>
        <Match when={read.error}>
          <Card padding="lg" class="flex flex-col gap-6">
            <div class="flex flex-col gap-2">
              <h1 class="text-foreground text-title font-medium">{FAILED_HEADING}</h1>
              <Notice tone="danger" size="inline" alert>
                {failedLine()}
              </Notice>
            </div>
            <Button size="lg" class="w-full max-md:h-11" busy={read.loading} onClick={retry}>
              {read.loading ? "Checking…" : "Try again"}
            </Button>
          </Card>
        </Match>
        <Match when={read.loading || !read()}>
          {/* The ready card's height with five numbers, on a 360–430px phone
              and from `md` up, so the name above it stays put when the card
              replaces it (`DESIGN.md` §Motion). The wrapper goes with the
              placeholder, and its busy state with it. */}
          <div aria-busy="true">
            <ResponsiveSkeleton standsFor="card" height={140} phoneHeight={147.5} />
          </div>
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
