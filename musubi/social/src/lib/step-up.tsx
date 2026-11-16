import type { StepUpPurpose } from "@osn/client";
import { createSignal, lazy, onCleanup, Show, Suspense, type JSX } from "solid-js";

const StepUpSheet = lazy(() => import("../components/StepUpSheet"));

/** What the sheet says, and the ceremony its token is for. */
export interface StepUpRequest {
  purpose: StepUpPurpose;
  /** The sheet's title; "Confirm it's you" when absent. */
  title?: string;
  /** The line under the title: why it asks. */
  reason?: string;
  /** The line under the title for a destructive action: what it costs. */
  warning?: string;
}

interface Pending extends StepUpRequest {
  resolve: (token: string | null) => void;
}

export interface StepUp {
  /**
   * Opens the step-up sheet. Resolves with the step-up token once the person
   * has confirmed it is them and the sheet has gone, or with null when they
   * close it. One at a time: a second call while a sheet is open resolves
   * null at once.
   */
  ask: (request: StepUpRequest) => Promise<string | null>;
  /** Whether a sheet is open. */
  open: () => boolean;
  /** Mount once, anywhere in the screen that asks. Draws nothing while closed. */
  Sheet: () => JSX.Element;
}

/**
 * A step-up a screen can wait on: `const token = await stepUp.ask(…)`.
 *
 * The sheet's code, with the passkey ceremony behind it, loads on the first
 * `ask`, so a screen that never asks never fetches it.
 */
export function createStepUp(): StepUp {
  const [pending, setPending] = createSignal<Pending | null>(null);
  // A screen that goes while its sheet is open ends the wait as a close, so
  // nothing that awaits it is left hanging.
  onCleanup(() => pending()?.resolve(null));

  const ask = (request: StepUpRequest) =>
    new Promise<string | null>((resolve) => {
      if (pending() !== null) {
        resolve(null);
        return;
      }
      setPending({ ...request, resolve });
    });

  const settle = (request: Pending, token: string | null) => {
    if (pending() !== request) return;
    setPending(null);
    request.resolve(token);
  };

  const Sheet = () => (
    <Show when={pending()} keyed>
      {(request) => (
        <Suspense>
          <StepUpSheet
            purpose={request.purpose}
            title={request.title}
            reason={request.reason}
            warning={request.warning}
            onToken={(token) => settle(request, token.token)}
            onCancel={() => settle(request, null)}
          />
        </Suspense>
      )}
    </Show>
  );

  return { ask, open: () => pending() !== null, Sheet };
}
