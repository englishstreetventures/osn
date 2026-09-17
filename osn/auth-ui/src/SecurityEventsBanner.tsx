import type {
  SecurityEventsClient,
  SecurityEventSummary,
  StepUpClient,
  TotpClient,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { createEffect, createResource, createSignal, For, Show } from "solid-js";

import { StepUpDialog, type RunPasskeyCeremony } from "./StepUpDialog";

/**
 * Banner for out-of-band security events. Its host decides where it mounts —
 * a settings panel, or the application shell, where it is seen without being
 * looked for.
 *
 * Surfaces "somebody regenerated your recovery codes — was this you?" style
 * prompts on a loop that survives email filtering. The banner is the audit
 * trail's last-mile delivery: it keeps rendering until the user clicks
 * "Acknowledge" (and completes a step-up ceremony), regardless of whether
 * the notification email was delivered.
 *
 * It renders nothing rather than throwing when the list cannot be read. A
 * Solid resource rethrows its fetch error on read, and a host that mounts
 * this in an application shell has no page-sized blast radius to absorb that:
 * one 429 on a shared address would blank every route.
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
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * TOTP client. Supplied, the step-up dialog offers the authenticator-app
   * factor — `security_event_ack` admits it. Omitted, it does not.
   * See `StepUpDialog.totpClient`.
   */
  totpClient?: TotpClient;
  /** Product name shown in this banner's copy — e.g. "Musubi". */
  productName: string;
  /**
   * Reports how many events the banner is showing, whenever that settles: 0
   * when the account has none, 0 when the list could not be read, and 0 again
   * once an acknowledgement clears them.
   *
   * Never called while the first read is still in flight, so a host can tell
   * "nothing to show" from "not known yet" and stack its own banners
   * underneath without one flashing in before this one arrives. Omit it and
   * the banner behaves exactly as it does without it.
   */
  onVisibleCountChange?: (count: number) => void;
}

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function headlineFor(kind: SecurityEventSummary["kind"], productName: string): string {
  switch (kind) {
    case "recovery_code_generate":
      return `Your ${productName} recovery codes were regenerated`;
    case "recovery_code_consume":
      return `A recovery code was used on your ${productName} account`;
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
  const visibleEvents = (): readonly SecurityEventSummary[] => {
    if (localRemovedAll()) return [];
    // `.error` before `serverEvents()`: reading a rejected resource rethrows,
    // and this component renders inside an application shell.
    if (serverEvents.error) return [];
    return serverEvents() ?? [];
  };

  // Reported after the read settles, never during it, so a host stacking its
  // own banners under this one can distinguish "none" from "not yet known".
  createEffect(() => {
    if (serverEvents.loading) return;
    props.onVisibleCountChange?.(visibleEvents().length);
  });

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
                <span class="font-medium">{headlineFor(event.kind, props.productName)}</span>
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
          totpClient={props.totpClient}
          purpose="security_event_ack"
        />
      </Show>
    </>
  );
}
