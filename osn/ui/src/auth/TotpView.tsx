import type { StepUpClient, StepUpToken, TotpClient, TotpEnrollment } from "@osn/client";
import { toast } from "@shared/toast";
import { createResource, createSignal, onCleanup, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { OtpInput } from "../components/ui/otp-input";
import { QrCode } from "../components/ui/qr-code";
import { StepUpDialog, type RunPasskeyCeremony } from "./StepUpDialog";

/**
 * Settings-panel surface for the account's authenticator app. Sits beside
 * `PasskeysView` and `RecoveryCodesView`, and completes the set: a passkey is
 * how you get in, recovery codes and an authenticator are how you get back in
 * when every passkey is gone.
 *
 * Design notes
 * ------------
 * - **The secret is shown once and then never again.** `enrollBegin` returns
 *   it, `GET /totp/status` does not, and there is no second read anywhere. It
 *   lives in one signal that is cleared on success, on cancel and on unmount,
 *   so the only window in which it exists in this component is the one where
 *   the user is looking at it.
 * - **The base32 key is the QR's text alternative**, which is why it is
 *   selectable text rather than part of the picture. Somebody using a screen
 *   reader, a desktop authenticator, or a phone that cannot photograph its own
 *   screen types it in; the QR is the shortcut, not the path.
 * - Enrolling and removing are both step-up gated for the reason passkey
 *   registration is: a stolen access token must not silently bind an
 *   attacker's authenticator, and must not silently remove the real one.
 * - The authenticator can authorise its own removal — the disable ceremony
 *   accepts a TOTP code, which proves the person still holds the device they
 *   are asking to unbind.
 */

export interface TotpViewProps {
  /** TOTP client, built via `createTotpClient({ issuerUrl })`. */
  client: TotpClient;
  /** Step-up client, built via `createStepUpClient({ issuerUrl })`. */
  stepUpClient: StepUpClient;
  /** The caller's current access token. */
  accessToken: string;
  /**
   * Executes the browser-side WebAuthn assertion for the step-up ceremony.
   * Kept caller-side so the host picks the WebAuthn wrapper.
   */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * Suppress the emailed-code step-up factor. See `StepUpDialog.passkeyOnly` —
   * it means the host cannot deliver mail, and it leaves this surface fully
   * usable because both ceremonies here accept a passkey.
   */
  passkeyOnly?: boolean;
}

type Pending = "enroll" | "disable" | null;

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

export function TotpView(props: TotpViewProps) {
  const [reloadKey, setReloadKey] = createSignal(0);
  const [status] = createResource(reloadKey, () =>
    props.client.status({ accessToken: props.accessToken }),
  );

  // The only place the shared secret exists in this component. Cleared on
  // every exit from the enrolment panel, including unmount.
  const [enrollment, setEnrollment] = createSignal<TotpEnrollment | null>(null);
  const [code, setCode] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [pending, setPending] = createSignal<Pending>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function clearEnrollment() {
    setEnrollment(null);
    setCode("");
    setLabel("");
  }

  onCleanup(clearEnrollment);

  const locked = () => busy() || pending() !== null;

  function requestEnroll() {
    if (locked()) return;
    setError(null);
    setPending("enroll");
  }

  function requestDisable() {
    if (locked()) return;
    if (
      !window.confirm(
        "Remove this authenticator app? You'll lose it as a way back into your account.",
      )
    ) {
      return;
    }
    setError(null);
    setPending("disable");
  }

  async function handleStepUp(token: StepUpToken) {
    const action = pending();
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "enroll") {
        setEnrollment(
          await props.client.enrollBegin({
            accessToken: props.accessToken,
            stepUpToken: token.token,
          }),
        );
      } else {
        await props.client.disable({
          accessToken: props.accessToken,
          stepUpToken: token.token,
        });
        clearEnrollment();
        setReloadKey((k) => k + 1);
        toast.success("Authenticator app removed");
      }
    } catch (e) {
      const fallback =
        action === "enroll" ? "Couldn't start setting up an authenticator" : "Couldn't remove it";
      const message = e instanceof Error ? e.message : fallback;
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function confirmEnrollment() {
    if (busy() || code().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.enrollComplete({
        accessToken: props.accessToken,
        code: code(),
        label: label().trim() || undefined,
      });
      // Before the refetch, and before anything else can fail: once the
      // credential exists the secret has no further use here, and the panel
      // that displays it must not survive this line.
      clearEnrollment();
      setReloadKey((k) => k + 1);
      toast.success("Authenticator app added");
    } catch (e) {
      // The pending secret is parked server-side for ten minutes. Past that
      // the code cannot be checked against anything and the user has to start
      // again — so the error keeps the panel, and "Cancel" is the way out.
      const message = e instanceof Error ? e.message : "That code didn't work";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Authenticator app</h2>
        <Show when={status()?.enrolled === false && enrollment() === null}>
          <Button size="sm" onClick={requestEnroll} disabled={locked()}>
            Add an authenticator app
          </Button>
        </Show>
      </div>

      <p class="text-muted-foreground text-sm">
        A six-digit code from an app on your phone. It needs neither your email nor the device
        holding your passkey, so it works when both are out of reach.
      </p>

      <Show when={error()}>
        {(msg) => (
          <p class="text-destructive text-sm" role="alert">
            {msg()}
          </p>
        )}
      </Show>

      <Show when={status.loading && enrollment() === null}>
        <p class="text-muted-foreground text-sm">Loading…</p>
      </Show>

      <Show when={status()?.enrolled === true && enrollment() === null}>
        <div class="flex items-center justify-between rounded-md border p-3">
          <div class="flex flex-col gap-0.5">
            <span class="font-medium">{status()?.label ?? "Authenticator app"}</span>
            <span class="text-muted-foreground text-xs">
              Added {formatTs(status()?.createdAt ?? null)} · Last used{" "}
              {formatTs(status()?.lastUsedAt ?? null)}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={requestDisable} disabled={locked()}>
            Remove
          </Button>
        </div>
      </Show>

      <Show when={enrollment()}>
        {(secret) => (
          <div class="flex flex-col gap-4 rounded-md border p-4">
            <div class="flex flex-col gap-1">
              <h3 class="font-medium">Scan this with your authenticator app</h3>
              <p class="text-muted-foreground text-sm">
                Then enter the six-digit code it shows, to prove the app is set up.
              </p>
            </div>

            <QrCode
              value={secret().otpauthUri}
              // Never the URI itself: it carries the whole shared secret, and
              // an accessible name is read aloud and copied into tooling.
              label="QR code to set up your authenticator app. If you can't scan it, use the setup key below."
            />

            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium" id="totp-setup-key-label">
                Or enter this setup key by hand
              </span>
              {/* Selectable text, not an image: this is the QR's text
                  alternative and the only path for anyone who cannot scan. */}
              <code
                class="bg-muted rounded-md px-3 py-2 font-mono text-sm break-all select-all"
                aria-labelledby="totp-setup-key-label"
              >
                {secret().totpSecret}
              </code>
            </div>

            <div class="flex flex-col gap-1">
              <Label for="totp-label">Name this device (optional)</Label>
              <Input
                id="totp-label"
                value={label()}
                maxLength={64}
                placeholder="iPhone"
                onInput={(e) => setLabel(e.currentTarget.value)}
              />
            </div>

            <div class="flex flex-col gap-2">
              <span class="text-sm font-medium">Code from the app</span>
              <OtpInput
                value={code()}
                onChange={setCode}
                status={error() ? "error" : busy() ? "verifying" : "idle"}
                autofocus
              />
            </div>

            <div class="flex gap-2">
              <Button onClick={confirmEnrollment} disabled={busy() || code().length !== 6}>
                {busy() ? "Checking…" : "Confirm"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  clearEnrollment();
                  setError(null);
                }}
                disabled={busy()}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Show>

      <Show when={pending()}>
        {(action) => (
          <StepUpDialog
            client={props.stepUpClient}
            accessToken={props.accessToken}
            onToken={handleStepUp}
            onCancel={() => setPending(null)}
            runPasskeyCeremony={props.runPasskeyCeremony}
            passkeyOnly={props.passkeyOnly}
            // Removing an authenticator may be authorised by that same
            // authenticator — holding the device is the proof that matters.
            totpClient={action() === "disable" ? props.client : undefined}
            reason={
              action() === "enroll" ? "to add an authenticator app" : "to remove your authenticator"
            }
            purpose={action() === "enroll" ? "totp_enroll" : "totp_disable"}
          />
        )}
      </Show>
    </div>
  );
}
