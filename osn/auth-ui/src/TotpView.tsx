import {
  describeAuthError,
  type StepUpClient,
  type StepUpToken,
  type TotpClient,
  type TotpEnrollment,
  type TotpStatus,
} from "@osn/client";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { labelVariants } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { OtpInput } from "@shared/ui/ui/otp-input";
import { QrCode } from "@shared/ui/ui/qr-code";
import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";

import { describedBy, fieldError, plainError, type FieldError } from "./error-lines";
import { LoadFailed } from "./LoadFailed";
import { RowPlaceholder } from "./RowPlaceholder";
import { ownRead, writeEnd, type SettingsRead, type WriteEnd } from "./settings-read";
import { SettingsRow } from "./SettingsRow";
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
 * - The status may be one the host remembered, being read again behind it
 *   (`read`). Add and Remove are busy from the press until that read lands,
 *   then act only if it still says so.
 */

export interface TotpViewProps {
  /** TOTP client, built via `createTotpClient({ issuerUrl, authFetch })`. */
  client: TotpClient;
  /** Step-up client, built via `createStepUpClient({ issuerUrl, authFetch })`. */
  stepUpClient: StepUpClient;
  /**
   * Executes the browser-side WebAuthn assertion for the step-up ceremony.
   * Kept caller-side so the host picks the WebAuthn wrapper.
   */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * The host cannot deliver mail: the step-up sheet offers no emailed link.
   * See `StepUpDialog.passkeyOnly`. No host passes it today.
   */
  passkeyOnly?: boolean;
  /**
   * The status, read by the host (Musubi's page cache), which may draw it
   * from memory and read it again behind it. Read once, when the view mounts.
   * Omitted, the view reads `client.status()` itself.
   */
  read?: SettingsRead<TotpStatus>;
}

type Pending = "enroll" | "disable" | null;

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

export function TotpView(props: TotpViewProps) {
  const status = props.read ?? ownRead(() => props.client.status());
  /**
   * The status once a read has landed, and nothing before, after one failed,
   * or after a change to it, until it is read again: the view shows its own
   * placeholder meanwhile.
   */
  const current = status.value;
  /** A first read, or one after a change, is out. */
  const loading = () => status.state() === "pending";
  /** The app's name, or what the row calls an unnamed one. */
  const appName = () => current()?.label?.trim() || "Authenticator app";

  // The only place the shared secret exists in this component. Cleared on
  // every exit from the enrolment panel, including unmount.
  const [enrollment, setEnrollment] = createSignal<TotpEnrollment | null>(null);
  const [code, setCode] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [pending, setPending] = createSignal<Pending>(null);
  const [busy, setBusy] = createSignal(false);
  // A refused code sits under the code boxes, tied to them; any other
  // failure under the heading's note. Errors are lines, never toasts: toasts
  // are for success.
  const [error, setError] = createSignal<(FieldError & { code: boolean }) | null>(null);
  const codeError = () => (error()?.code ? error() : null);
  const codeLabelId = createUniqueId();
  const codeErrorId = createUniqueId();

  function clearEnrollment() {
    setEnrollment(null);
    setCode("");
    setLabel("");
  }

  onCleanup(clearEnrollment);

  // The action pressed while the status is read again: busy until it lands.
  const [checking, setChecking] = createSignal<Pending>(null);
  const locked = () => busy() || pending() !== null || checking() !== null;

  /**
   * Opens the step-up for `action` once no read of the status is out, and
   * only if the status then still says `enrolled` is `wanted`. Busy from the
   * press; when no read is out the wait ends before anything paints.
   */
  async function onFreshStatus(action: "enroll" | "disable", wanted: boolean) {
    if (locked()) return;
    setError(null);
    setChecking(action);
    try {
      const fresh = await status.settled();
      if (fresh?.enrolled === wanted) setPending(action);
    } finally {
      setChecking(null);
    }
  }

  const requestEnroll = () => void onFreshStatus("enroll", false);

  // The step-up sheet asks before the removal: its title names it, its warning
  // says what it costs, and the factor picked there commits it.
  const requestDisable = () => void onFreshStatus("disable", true);

  async function handleStepUp(token: StepUpToken) {
    const action = pending();
    if (!action) return;
    setBusy(true);
    setError(null);
    let finish: ((end: WriteEnd<TotpStatus>) => void) | undefined;
    try {
      if (action === "enroll") {
        // Starting an enrolment changes no status; the step-up before it
        // moved a factor's "Last used", so the tab is read again.
        finish = status.write();
        setEnrollment(
          await props.client.enrollBegin({
            stepUpToken: token.token,
          }),
        );
        finish("unchanged");
      } else {
        finish = status.write();
        await props.client.disable({
          stepUpToken: token.token,
        });
        finish("unknown");
        clearEnrollment();
        toast.success("Authenticator app removed");
      }
    } catch (e) {
      finish?.(action === "enroll" ? "unchanged" : writeEnd(e));
      setError({ ...plainError(describeAuthError(e)), code: false });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function confirmEnrollment() {
    if (busy() || code().length !== 6) return;
    setBusy(true);
    setError(null);
    // The confirm runs no step-up: the one before the enrolment began did.
    const finish = status.write({ steppedUp: false });
    try {
      await props.client.enrollComplete({
        code: code(),
        label: label().trim() || undefined,
      });
      // Before anything else can fail: once the credential exists the secret
      // has no further use here, and the panel that displays it must not
      // survive this line.
      clearEnrollment();
      // Its times are the server's: read again, the placeholder meanwhile.
      finish("unknown");
      toast.success("Authenticator app added");
    } catch (e) {
      finish(writeEnd(e));
      // The pending secret is parked server-side for ten minutes. Past that
      // the code cannot be checked against anything and the user has to start
      // again — so the error keeps the panel, and "Cancel" is the way out.
      setError({ ...fieldError(describeAuthError(e, "code"), e), code: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      {/* The action goes under the heading when the two do not fit on one line. */}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-ui-ink text-ui-md font-ui-title">Authenticator app</h2>
        <Show when={current()?.enrolled === false && enrollment() === null}>
          <Button
            size="sm"
            class="max-md:h-10"
            onClick={requestEnroll}
            busy={checking() === "enroll"}
            disabled={checking() !== "enroll" && locked()}
          >
            {checking() === "enroll" ? "Checking…" : "Add an authenticator app"}
          </Button>
        </Show>
      </div>

      <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
        A six-digit code from an app on your phone. It needs neither your email nor the device
        holding your passkey, so it works when both are out of reach.
      </p>

      <Show when={!error()?.code && error()}>
        {(line) => (
          <Notice tone="danger" size="inline" alert>
            {line().text}
          </Notice>
        )}
      </Show>

      {/* The status row's place: a row's placeholder while a read is out, the
          failure, or the enrolled app. Drawn only when one of them shows, so
          an account with none set up gets no empty slot. */}
      <Show
        when={
          enrollment() === null &&
          (loading() || status.state() === "errored" || current()?.enrolled === true)
        }
      >
        <div aria-busy={loading() || undefined}>
          <Show when={loading()}>
            <RowPlaceholder />
          </Show>
          <Show when={status.failure()}>
            {(failure) => (
              <LoadFailed
                lead="Your authenticator app didn't load."
                error={failure().error}
                onRetry={status.retry}
              />
            )}
          </Show>
          <Show when={current()?.enrolled === true}>
            <SettingsRow
              name={appName()}
              meta={[
                `Added ${formatTs(current()?.createdAt ?? null)}`,
                `Last used ${formatTs(current()?.lastUsedAt ?? null)}`,
              ]}
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  class="max-md:h-10"
                  onClick={requestDisable}
                  busy={checking() === "disable"}
                  disabled={checking() !== "disable" && locked()}
                  aria-label={`Remove ${appName()}`}
                >
                  {checking() === "disable" ? "Checking…" : "Remove"}
                </Button>
              }
            />
          </Show>
        </div>
      </Show>

      <Show when={enrollment()}>
        {(secret) => (
          // Below `md` the step drops its frame, so the code row keeps the
          // column Settings' card gives it (§4 Layout in DESIGN.md).
          // A step, not a row, so not a `Card`: `Card` cannot drop its edge
          // below `md`.
          <div class="rounded-ui-md border-ui-hairline flex flex-col gap-4 border p-4 max-md:border-0 max-md:p-0">
            <div class="flex flex-col gap-1">
              <h3 class="text-ui-ink text-ui-base font-medium">
                Scan this with your authenticator app
              </h3>
              <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
                Then enter the six-digit code it shows, to prove the app is set up.
              </p>
            </div>

            <QrCode
              value={secret().otpauthUri}
              // Never the URI itself: it carries the whole shared secret, and
              // an accessible name is read aloud and copied into tooling.
              label="QR code to set up your authenticator app. If you can't scan it, use the setup key below."
            />

            <div class="flex flex-col gap-1.5">
              <span class={labelVariants()} id="totp-setup-key-label">
                Or enter this setup key by hand
              </span>
              {/* Selectable text, not an image: this is the QR's text
                  alternative and the only path for anyone who cannot scan. */}
              <code
                class="bg-ui-surface-sunk rounded-ui-md font-ui-mono text-ui-sm text-ui-ink px-3 py-2 break-all select-all"
                aria-labelledby="totp-setup-key-label"
              >
                {secret().totpSecret}
              </code>
            </div>

            <Field labelTreatment="plain" label="Name this device (optional)">
              {(field) => (
                <Input
                  {...field}
                  value={label()}
                  maxLength={64}
                  placeholder="iPhone"
                  onInput={(e) => setLabel(e.currentTarget.value)}
                />
              )}
            </Field>

            <div class="flex flex-col gap-1.5">
              <span class={labelVariants()} id={codeLabelId}>
                Code from the app
              </span>
              <OtpInput
                value={code()}
                onChange={setCode}
                status={codeError()?.invalid ? "error" : busy() ? "verifying" : "idle"}
                autofocus
                aria-labelledby={codeLabelId}
                aria-describedby={describedBy(codeError() && codeErrorId)}
              />
              <Show when={codeError()}>
                {(line) => (
                  <Notice tone="danger" size="inline" alert id={codeErrorId}>
                    {line().text}
                  </Notice>
                )}
              </Show>
            </div>

            <div class="flex gap-2">
              <Button
                onClick={confirmEnrollment}
                busy={busy()}
                disabled={!busy() && code().length !== 6}
              >
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
            onToken={handleStepUp}
            onCancel={() => setPending(null)}
            runPasskeyCeremony={props.runPasskeyCeremony}
            passkeyOnly={props.passkeyOnly}
            // Removing an authenticator may be authorised by that same
            // authenticator — holding the device is the proof that matters.
            totpClient={action() === "disable" ? props.client : undefined}
            title={action() === "disable" ? `Remove ${appName()}?` : undefined}
            warning={
              action() === "disable"
                ? "You'll lose it as a way back into your account. Confirm it's you to remove it."
                : undefined
            }
            reason={
              action() === "enroll" ? "To add an authenticator app, confirm it's you." : undefined
            }
            purpose={action() === "enroll" ? "totp_enroll" : "totp_disable"}
          />
        )}
      </Show>
    </div>
  );
}
