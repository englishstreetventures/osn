import type { StepUpClient, StepUpPurpose, StepUpToken, TotpClient } from "@osn/client";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { createResource, createSignal, onMount, Show } from "solid-js";

import { Button } from "../components/ui/button";

/**
 * Runs the browser-side WebAuthn assertion and resolves with the signed
 * assertion — the exact JSON `@simplewebauthn/browser`'s `startAuthentication`
 * produces, which the OSN API expects verbatim at
 * `/step-up/passkey/complete`. Nothing in `@osn/ui` reads a field off it; it
 * is forwarded whole.
 *
 * The ceremony itself stays caller-side (this package imports the response
 * types, not the runtime) so hosts can wire their own WebAuthn wrapper.
 *
 * `options` is the standard lib.dom `PublicKeyCredentialRequestOptionsJSON`,
 * exactly what `StepUpClient.passkeyBegin` resolves with. Nothing in `@osn/ui`
 * reads a field off it — it is forwarded whole — but naming the shape keeps
 * every host from asserting its way out of `unknown` at the call site.
 */
export type RunPasskeyCeremony = (
  options: PublicKeyCredentialRequestOptionsJSON,
) => Promise<AuthenticationResponseJSON>;

/**
 * Enrolment counterpart of {@link RunPasskeyCeremony}: runs the WebAuthn
 * attestation ceremony and resolves with the attestation JSON
 * `startRegistration` produces, forwarded whole to `/passkeys/register/complete`.
 */
export type RunPasskeyRegistration = (
  options: PublicKeyCredentialCreationOptionsJSON,
) => Promise<RegistrationResponseJSON>;

/**
 * Which factors the server will accept for each ceremony.
 *
 * A step-up token records the factor that minted it as an AMR value, and the
 * gated endpoint checks that value against an allow-list. Offering a factor
 * the allow-list refuses is not a smaller menu — it is a dead end: the
 * ceremony succeeds, a token is minted, and the call it was minted for fails.
 * So the dialog offers a factor only where the purpose admits it.
 *
 * A passkey (`webauthn`) is admitted everywhere and is therefore not listed.
 *
 * This mirrors the **defaults** in `osn/api/src/services/auth/context.ts`
 * (`recoveryGenerateAllowedAmr`, `passkeyRegisterAllowedAmr`,
 * `passkeyDeleteAllowedAmr`, `emailChangeAllowedAmr`). Three of those four are
 * `AuthConfig` fields, so a deployment that narrows one reintroduces the dead
 * end here; no deployment sets them today.
 *
 * The two `false` entries each have a reason worth keeping:
 * `passkey_delete` (which gates rename as well) stays WebAuthn-only because
 * the caller necessarily holds a passkey already, so requiring one costs
 * nothing; `email_change` admits the emailed code because it proves control of
 * the current mailbox, which an authenticator seed does not.
 */
const PURPOSE_FACTORS = {
  recovery_generate: { otp: true, totp: true },
  security_event_ack: { otp: true, totp: true },
  account_delete: { otp: true, totp: true },
  account_export: { otp: true, totp: true },
  pulse_app_delete: { otp: true, totp: true },
  zap_app_delete: { otp: true, totp: true },
  passkey_register: { otp: true, totp: true },
  totp_enroll: { otp: true, totp: true },
  totp_disable: { otp: true, totp: true },
  passkey_delete: { otp: false, totp: false },
  email_change: { otp: true, totp: false },
  // `satisfies` rather than an annotation: it still fails to compile when a
  // new `StepUpPurpose` is added without a row here, which is the whole point
  // of the table, but keeps the literal's own types.
} satisfies Record<StepUpPurpose, { otp: boolean; totp: boolean }>;

/**
 * Modal that drives the step-up (sudo) ceremony and yields a short-lived
 * step-up token to the caller via `onToken`. Three factors: passkey, an
 * emailed code, and an authenticator app. Which of them appear depends on the
 * ceremony (see {@link PURPOSE_FACTORS}) and on what the account has set up.
 */
export interface StepUpDialogProps {
  client: StepUpClient;
  accessToken: string;
  /**
   * Fires as soon as a step-up token is successfully minted. The caller
   * should close the dialog and proceed with the gated action.
   */
  onToken: (token: StepUpToken) => void;
  /** Called when the user cancels the ceremony without completing it. */
  onCancel: () => void;
  /** Executes the browser-side WebAuthn assertion. */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * TOTP client, for the "enter a code from your authenticator app" factor.
   * Omit it and that factor is never offered.
   *
   * The dialog asks `GET /totp/status` itself rather than taking a boolean,
   * so a host cannot wire the client and the flag inconsistently and end up
   * offering a factor the account has not set up. A failed status read leaves
   * the factor hidden and never blocks the other two.
   */
  totpClient?: TotpClient;
  /**
   * **The host cannot deliver mail**: suppress the emailed-code factor and
   * drive the passkey ceremony directly. With this set the dialog auto-starts
   * the passkey ceremony on mount and offers a retry on failure, and the
   * "choose a method" helper line goes with the factor picker.
   *
   * It suppresses the emailed code and **nothing else**. An authenticator app
   * needs no delivery, so it cannot fail the way this prop exists to prevent,
   * and it stays on offer wherever the ceremony and the account allow it —
   * which is why the name is not the whole story and this paragraph is here.
   * Where no authenticator is enrolled the dialog really is passkey-only, the
   * state the name was written for.
   *
   * @see wiki/systems/passkey-primary.md — the settled meaning, and why the
   * prop was not renamed.
   */
  passkeyOnly?: boolean;
  /**
   * Optional heading override. Defaults to "Confirm it's you".
   */
  title?: string;
  /**
   * Optional one-liner explaining WHY re-authentication is needed (e.g.
   * "to generate recovery codes"). Rendered under the heading so the user
   * isn't asked to re-auth without context.
   */
  reason?: string;
  /**
   * Ceremony the minted token is for. Endpoints that name a purpose reject
   * tokens minted for a different one, so a token this dialog produces for
   * one action can't be replayed at another.
   */
  purpose?: StepUpPurpose;
}

type Mode = "choose" | "passkey" | "otp" | "totp";

export function StepUpDialog(props: StepUpDialogProps) {
  const [mode, setMode] = createSignal<Mode>(props.passkeyOnly ? "passkey" : "choose");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // An unbound ceremony names no purpose, so there is no allow-list to look
  // up and the dialog offers what it always has.
  const factors = () =>
    props.purpose === undefined ? { otp: true, totp: true } : PURPOSE_FACTORS[props.purpose];

  const [totpStatus] = createResource(
    () => props.totpClient,
    async (client: TotpClient) => {
      try {
        return await client.status({ accessToken: props.accessToken });
      } catch {
        // Whether an authenticator exists is not worth failing a ceremony
        // over — the user still has a passkey, and may still have email.
        return null;
      }
    },
  );

  const totpOffered = () => factors().totp && totpStatus()?.enrolled === true;
  const otpOffered = () => factors().otp && !props.passkeyOnly;

  // Passkey-only contexts skip the factor picker — kick the ceremony off as
  // soon as the dialog mounts so the user lands straight on the platform
  // authenticator prompt.
  onMount(() => {
    if (props.passkeyOnly) void startPasskey();
  });

  async function startPasskey() {
    if (!props.runPasskeyCeremony) {
      setError("Passkey ceremony not available in this context");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const begin = await props.client.passkeyBegin({ accessToken: props.accessToken });
      const assertion = await props.runPasskeyCeremony(begin.options);
      const token = await props.client.passkeyComplete({
        accessToken: props.accessToken,
        assertion,
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Step-up failed");
    } finally {
      setBusy(false);
    }
  }

  async function startOtp() {
    setBusy(true);
    setError(null);
    try {
      await props.client.otpBegin({ accessToken: props.accessToken });
      setMode("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  }

  async function completeOtp() {
    if (code().length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await props.client.otpComplete({
        accessToken: props.accessToken,
        code: code(),
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid or expired code");
    } finally {
      setBusy(false);
    }
  }

  function startTotp() {
    // No `begin` half: TOTP is challenge-free, so there is nothing for the
    // server to mint, park or send. `GET /totp/status` already answered the
    // only question — whether the factor exists at all.
    setError(null);
    setCode("");
    setMode("totp");
  }

  async function completeTotp() {
    if (code().length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await props.client.totpComplete({
        accessToken: props.accessToken,
        code: code(),
        purpose: props.purpose,
      });
      props.onToken(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid or expired code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3 p-4">
      <h2 class="text-lg font-semibold">{props.title ?? "Confirm it's you"}</h2>
      <Show when={props.reason}>
        {(reason) => <p class="text-muted-foreground text-sm">Re-authenticate {reason()}.</p>}
      </Show>
      {/* Passkey-only mode has no factor picker, so the "choose a method"
          helper line would be misleading — the ceremony auto-starts. */}
      <Show when={!props.passkeyOnly}>
        <p class="text-muted-foreground text-sm">
          This action needs a fresh authentication. Choose a method below.
        </p>
      </Show>
      {/* A step-up failure is the reason the user cannot proceed, so it is
          announced rather than left for them to notice. */}
      <Show when={error()}>
        {(msg) => (
          <p class="text-destructive text-sm" role="alert">
            {msg()}
          </p>
        )}
      </Show>
      <Show when={!props.passkeyOnly && mode() === "choose"}>
        <div class="flex flex-col gap-2">
          <Button onClick={startPasskey} disabled={busy()}>
            Use passkey
          </Button>
          <Show when={otpOffered()}>
            <Button variant="outline" onClick={startOtp} disabled={busy()}>
              Email me a code
            </Button>
          </Show>
          <Show when={totpOffered()}>
            <Button variant="outline" onClick={startTotp} disabled={busy()}>
              Use your authenticator app
            </Button>
          </Show>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={props.passkeyOnly && mode() === "passkey"}>
        <div class="flex flex-col gap-2">
          <Show when={busy()}>
            <p class="text-muted-foreground text-sm" aria-live="polite">
              Waiting for your passkey…
            </p>
          </Show>
          <Show when={!busy()}>
            <Button onClick={startPasskey}>{error() ? "Try again" : "Use passkey"}</Button>
          </Show>
          {/* An authenticator code needs no delivery, so it survives the
              no-mail mode this dialog was put in. */}
          <Show when={totpOffered()}>
            <Button variant="outline" onClick={startTotp} disabled={busy()}>
              Use your authenticator app
            </Button>
          </Show>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={mode() === "otp"}>
        <div class="flex flex-col gap-2">
          <label class="flex flex-col gap-1 text-sm">
            Code
            <input
              class="bg-background rounded-md border px-3 py-2 font-mono tracking-widest"
              inputmode="numeric"
              maxLength={6}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </label>
          <Button onClick={completeOtp} disabled={busy()}>
            Confirm
          </Button>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={mode() === "totp"}>
        <div class="flex flex-col gap-2">
          <label class="flex flex-col gap-1 text-sm">
            Code from your authenticator app
            <input
              class="bg-background rounded-md border px-3 py-2 font-mono tracking-widest"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxLength={6}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </label>
          <Button onClick={completeTotp} disabled={busy()}>
            Confirm
          </Button>
          <Button variant="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </Button>
        </div>
      </Show>
    </div>
  );
}
