import { InlineAction } from "@osn/auth-ui/InlineAction";
import {
  type AppStepUpRequest,
  describeAuthError,
  StepUpError,
  type StepUpPurpose,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { useParams } from "@solidjs/router";
import { createResource, createSignal, Match, Show, Switch, type JSX } from "solid-js";

import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { SignedOutNote } from "../components/SignedOutNote";
import { appStepUpClient } from "../lib/app-step-up-client";
import { usePageTitle } from "../lib/page-title";
import { returnTo } from "../lib/return-to";
import { createStepUp } from "../lib/step-up";

const TITLE = "Confirm a request";

/** What each purpose an app may ask for says, on the page and on the sheet. */
const PURPOSE_COPY = {
  cire_app_delete: {
    heading: "Remove your Cire data",
    asks: "Cire asks you to confirm it's you before it removes your data there. Confirming removes nothing yet: you finish on Cire.",
    does: "On Cire, removing it takes every profile of this account off its weddings and signs you out of Cire. Your Musubi account stays.",
    sheetTitle: "Remove your Cire data?",
    sheetReason: "Cire asks Musubi to confirm it's you before it removes your data.",
  },
} as const satisfies Partial<
  Record<
    StepUpPurpose,
    {
      heading: string;
      asks: string;
      does: string;
      sheetTitle: string;
      sheetReason: string;
    }
  >
>;

type CopiedPurpose = keyof typeof PURPOSE_COPY;

/**
 * The placeholder's height in spacing steps: the ready card's, measured in
 * `tests/pages/ConfirmRequestPage.browser.test.tsx` (DESIGN.md §Layout, An
 * app's step-up request).
 */
const CARD_HEIGHT = { desktop: 58, phone: 73.5 } as const;

/** Why the last press of Confirm did not go through. */
type Problem = { readonly kind: "refused" } | { readonly kind: "line"; readonly text: string };

/**
 * `/confirm/:requestId`: an app's step-up request. An app whose pages cannot
 * run a step-up (cire's organiser portal holds no OSN token, and passkeys are
 * bound to Musubi's origin) sends the person here in the same tab. The page
 * reads the request (`appStepUpClient.read`), says what the app asks and the
 * host it will send them back to, runs the step-up for the request's purpose,
 * confirms, and goes to the address osn-api answered. Musubi builds no app
 * address of its own: the only one it follows is that answer.
 *
 * A page in the shell, so a signed-out reader gets Musubi's own sign-in, and
 * an account whose deletion is pending gets the window screen in its place,
 * as on every shell route. A request that is gone, used, or another
 * account's, reads as one card: start again from the app.
 */
export function ConfirmRequestPage() {
  const params = useParams<{ requestId: string }>();
  const { session } = useAuth();
  usePageTitle(() => TITLE);
  const stepUp = createStepUp();

  const [request, { refetch }] = createResource(
    () => (session() ? params.requestId : false),
    (id: string) => appStepUpClient.read(id),
  );
  const [ended, setEnded] = createSignal(false);
  const [phase, setPhase] = createSignal<"idle" | "confirming" | "leaving">("idle");
  const [problem, setProblem] = createSignal<Problem | null>(null);

  /** What the read answered, once it has: a request, or null for none. */
  const read = () => (request.state === "ready" ? request() : undefined);
  const known = (value: AppStepUpRequest): value is AppStepUpRequest & { purpose: CopiedPurpose } =>
    Object.hasOwn(PURPOSE_COPY, value.purpose);
  /** The request on screen, once read and still open. */
  const open = () => {
    const value = read();
    return !ended() && value && known(value) ? value : null;
  };
  /** No such request is open for this account: used, run out, or another's. */
  const gone = () => {
    const value = read();
    return ended() || value === null || (value !== undefined && !known(value));
  };

  async function confirm() {
    const current = open();
    if (current === null || phase() !== "idle" || stepUp.open()) return;
    setProblem(null);
    const copy = PURPOSE_COPY[current.purpose];
    const token = await stepUp.ask({
      purpose: current.purpose,
      title: copy.sheetTitle,
      reason: copy.sheetReason,
    });
    if (token === null) return;
    setPhase("confirming");
    try {
      const answer = await appStepUpClient.confirm({
        requestId: params.requestId,
        stepUpToken: token,
      });
      if (answer.status === "gone") {
        setPhase("idle");
        setEnded(true);
        return;
      }
      setPhase("leaving");
      // The tab leaves for the app; the button stays busy until it has.
      if (!returnTo(answer.returnTo)) {
        setPhase("idle");
        setEnded(true);
      }
    } catch (err) {
      setPhase("idle");
      setProblem(
        err instanceof StepUpError && err.status === 403
          ? { kind: "refused" }
          : { kind: "line", text: describeAuthError(err) },
      );
    }
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-display font-medium">{TITLE}</h1>
        <p class="text-muted-foreground text-body mt-1">
          An app asked you to confirm it's you on Musubi.
        </p>
      </div>

      <Show
        when={session()}
        fallback={<SignedOutNote>Sign in to confirm this request.</SignedOutNote>}
      >
        <Switch>
          <Match when={open()}>
            {(current) => (
              <RequestCard heading={PURPOSE_COPY[current().purpose].heading} problem={problem()}>
                <p class="text-foreground text-body">{PURPOSE_COPY[current().purpose].asks}</p>
                <p class="text-muted-foreground text-body">
                  {PURPOSE_COPY[current().purpose].does}
                </p>
                <p class="text-foreground text-body">
                  After you confirm, we send you back to{" "}
                  <span class="font-medium wrap-anywhere">{current().returnHost}</span>.
                </p>
                <div class="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    size="sm"
                    class="max-md:h-10"
                    busy={phase() !== "idle"}
                    onClick={() => void confirm()}
                  >
                    {phase() === "confirming"
                      ? "Confirming…"
                      : phase() === "leaving"
                        ? "Taking you back…"
                        : "Confirm it's you"}
                  </Button>
                </div>
              </RequestCard>
            )}
          </Match>

          <Match when={gone()}>
            <Card padding="md" class="flex flex-col gap-3">
              <h2 class="text-foreground text-title font-medium">This request has ended</h2>
              <p class="text-muted-foreground text-body">
                It was already used, it ran out, or it's for another Musubi account. Start again
                from the app that sent you here.
              </p>
            </Card>
          </Match>

          <Match when={request.state === "errored"}>
            <Notice tone="danger" size="inline" alert>
              This request didn't load.{loadDetail(request.error)}{" "}
              <InlineAction onClick={() => void refetch()}>Try again</InlineAction>
            </Notice>
          </Match>

          <Match when={true}>
            <div aria-busy="true">
              <ResponsiveSkeleton
                standsFor="card"
                height={CARD_HEIGHT.desktop}
                phoneHeight={CARD_HEIGHT.phone}
              />
            </div>
          </Match>
        </Switch>
        <stepUp.Sheet />
      </Show>
    </main>
  );
}

/** The request's card: its heading, why the last press failed, then the rest. */
function RequestCard(props: { heading: string; problem: Problem | null; children: JSX.Element }) {
  return (
    <Card padding="md" class="flex flex-col gap-3" data-request-card>
      <h2 class="text-foreground text-title font-medium">{props.heading}</h2>
      <Show when={props.problem} keyed>
        {(current) => (
          <Notice tone="danger" size="inline" alert>
            {current.kind === "refused"
              ? "Musubi couldn't use that confirmation. Confirm it's you again."
              : current.text}
          </Notice>
        )}
      </Show>
      {props.children}
    </Card>
  );
}

/** The copy map's sentence after the lead, only when it adds something: a wait, or the connection. */
function loadDetail(err: unknown): string {
  const status = err instanceof StepUpError ? err.status : undefined;
  return status === 429 || status === 0 ? ` ${describeAuthError(err)}` : "";
}
