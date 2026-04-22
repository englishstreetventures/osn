import type { SecurityEventsClient, SecurityEventSummary, StepUpClient } from "@osn/client";
import { createResource, createSignal, For, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Settings-panel banner for out-of-band security events (M-PK1b).
 *
 * Surfaces "somebody regenerated your recovery codes — was this you?" style
 * prompts on a loop that survives email filtering. The banner is the audit
 * trail's last-mile delivery: it keeps rendering until the user clicks
 * "Acknowledge" (and completes a step-up ceremony), regardless of whether
 * the notification email was delivered.
 *
 * Design notes
 * ------------
 * - S-M1: the access token alone cannot dismiss the banner — the banner
 *   exists precisely to notice that compromise. Clicking "Acknowledge"
 *   opens `StepUpDialog` (passkey or OTP). On success the step-up token
 *   is posted to `/account/security-events/ack-all`, which clears every
 *   unacked event in one call.
 * - P-I3: the UI removes rows optimistically from a local signal after
 *   a successful ack. No follow-up GET to the list endpoint — the server
 *   is already consistent and the refetch wasted a rate-limit slot.
 * - `kind` is a bounded string union; the headline switch falls through to
 *   a generic message so a forward-compatible server can ship a new kind
 *   before the client learns about it.
 */

export interface SecurityEventsBannerProps {
  client: SecurityEventsClient;
  stepUpClient: StepUpClient;
  accessToken: string;
  /**
   * Executes the browser-side WebAuthn assertion. Same shape as
   * `StepUpDialog.runPasskeyCeremony`. Pass undefined to hide the passkey
   * option in the step-up modal (OTP-only fallback).
   */
  runPasskeyCeremony?: (options: unknown) => Promise<unknown>;
}

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function headlineFor(kind: SecurityEventSummary["kind"]): string {
  switch (kind) {
    case "recovery_code_generate":
      return "Your OSN recovery codes were regenerated";
    case "recovery_code_consume":
      return "An OSN recovery code was used on your account";
    default:
      return "Security event on your account";
  }
}

export function SecurityEventsBanner(props: SecurityEventsBannerProps) {
  // `events` loads once on mount. Further updates are local-optimistic (P-I3)
  // — a successful ack-all empties `localEvents` without re-hitting the list
  // endpoint, which would otherwise burn a rate-limit slot per click.
  const [serverEvents] = createResource(async () => {
    const res = await props.client.list({ accessToken: props.accessToken });
    return res.events;
  });
  const [localRemovedAll, setLocalRemovedAll] = createSignal(false);
  const visibleEvents = () => (localRemovedAll() ? [] : (serverEvents() ?? []));

  const [error, setError] = createSignal<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function onStepUpToken(token: { token: string }) {
    setStepUpOpen(false);
    setBusy(true);
    setError(null);
    try {
      await props.client.acknowledgeAll({
        accessToken: props.accessToken,
        stepUpToken: token.token,
      });
      setLocalRemovedAll(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to acknowledge events");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Show when={visibleEvents().length > 0}>
        <div class="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
          <For each={visibleEvents()}>
            {(event: SecurityEventSummary) => (
              <div class="flex flex-col gap-0.5">
                <span class="font-medium">{headlineFor(event.kind)}</span>
                <span class="text-muted-foreground text-xs">
                  {formatTs(event.createdAt)}
                  <Show when={event.uaLabel}> · {event.uaLabel}</Show>
                </span>
              </div>
            )}
          </For>
          <span class="text-muted-foreground text-xs">
            If you don't recognise this, review your active sessions and rotate your credentials.
            Acknowledging requires a fresh passkey or OTP check.
          </span>
          <div class="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStepUpOpen(true)}
              disabled={busy()}
            >
              Acknowledge
            </Button>
          </div>
        </div>
      </Show>
      <Show when={stepUpOpen()}>
        <StepUpDialog
          client={props.stepUpClient}
          accessToken={props.accessToken}
          onToken={onStepUpToken}
          onCancel={() => setStepUpOpen(false)}
          runPasskeyCeremony={props.runPasskeyCeremony}
        />
      </Show>
    </>
  );
}
