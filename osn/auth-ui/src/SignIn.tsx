import type { LoginClient, RecoveryClient, RegistrationClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { createSignal, createUniqueId, Show, onMount } from "solid-js";

import { AuthHeader } from "./AuthHeader";
import { describedBy, fieldError, plainError, type FieldError } from "./error-lines";
import { InlineAction } from "./InlineAction";
import { describePasskeyError } from "./passkey-errors";
import { hasPendingRecovery, RecoveryLoginForm } from "./RecoveryLoginForm";
import type { RunPasskeyRegistration } from "./StepUpDialog";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import { StepLink, stepAction, ViewStep } from "./ViewParts";

/**
 * Shared sign-in component. WebAuthn (passkey or security key) is the only
 * primary login factor. If the environment lacks WebAuthn support we show
 * an informational screen rather than a broken form; users can still click
 * through to recovery-code login.
 *
 * Drives `/login/passkey/*` through an injected `LoginClient`, talks to
 * `AuthProvider.adoptSession` from `@osn/client/solid`, and never redirects
 * the browser.
 */

type View = "passkey" | "recovery";

// Musubi imports views by subpath, so the recovery wait's probe comes from here.
export { hasPendingRecovery };

interface SignInBaseProps {
  client: LoginClient;
  /** Needed for the "Lost your passkey?" escape hatch. */
  recoveryClient: RecoveryClient;
  /**
   * Enables the two recovery factors that end in passkey enrolment (an emailed
   * link, an authenticator code). Both mint a restricted session whose only
   * permitted action is enrolling a passkey, so both need a registration
   * client and a ceremony runner to finish. Omit either and only the
   * recovery-code path is offered.
   */
  registrationClient?: RegistrationClient;
  /** Executes the browser-side WebAuthn attestation for that enrolment. */
  runPasskeyRegistration?: RunPasskeyRegistration;
  onSuccess?: () => void;
  /**
   * Cloudflare Turnstile sitekey (public, build-time). When provided, the
   * identifier-bound passkey form renders the Turnstile challenge and gates
   * "Continue" on it (the token rides on `/login/passkey/begin`). The silent
   * conditional-UI (autofill) ceremony does NOT carry a token — it runs in the
   * background before the user touches the widget, and osn-api only enforces the
   * gate on the explicit begin call. Omitted/blank ⇒ no widget, no gate.
   */
  turnstileSiteKey?: string;
  /** Product name shown in this dialog's copy — e.g. "Musubi". */
  productName: string;
}

/**
 * What the view is mounted in. See `AuthHeader`.
 *
 * - `"dialog"`: inside `@shared/ui`'s `Dialog`, whose name its title becomes.
 *   `onCancel` is required: it is the footer's Cancel, first beside each
 *   step's action, and always reads "Cancel". It closes nothing itself;
 *   Escape and a press outside are the host's `onOpenChange`, which should
 *   run the same handler.
 * - `"page"`: on a page such as `/authorize`, with no padding at the sides.
 *   Cancel, when the page gives `onCancel`, sits at the title row's end, in
 *   the page's words (`cancelLabel`).
 */
export type SignInProps = SignInBaseProps &
  (
    | { host: "dialog"; onCancel: () => void }
    | { host: "page"; onCancel?: () => void; cancelLabel?: string }
  );

export function SignIn(props: SignInProps) {
  const { adoptSession } = useAuth();
  const client = props.client;

  // Feature-detect on mount so test code can toggle the underlying mock
  // between renders without needing a fresh import.
  const [webauthnSupported, setWebauthnSupported] = createSignal(false);
  onMount(() => setWebauthnSupported(browserSupportsWebAuthn()));

  // A tab waiting on an emailed recovery link opens on the recovery view, which
  // resumes the wait.
  const [view, setView] = createSignal<View>(hasPendingRecovery() ? "recovery" : "passkey");
  const [identifier, setIdentifier] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // The line under the identifier field, and whether it came from the passkey
  // attempt — that one carries the "Lost your passkey?" pointer.
  const [error, setError] = createSignal<(FieldError & { passkey: boolean }) | null>(null);
  const errorId = createUniqueId();
  const [signedIn, setSignedIn] = createSignal(false);
  // Turnstile token — REQUIRED only when a sitekey is provided.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);
  const turnstileOn = () => turnstileEnabled(props.turnstileSiteKey);
  // Bound to the widget once it mounts; lets us force a fresh token after the
  // current one is redeemed by `/login/passkey/begin` (tokens are single-use).
  let resetTurnstile: (() => void) | undefined;

  /** The recovery form, with this form's error left behind. */
  function openRecovery() {
    setError(null);
    setView("recovery");
  }

  async function finishWithSession(session: Parameters<typeof adoptSession>[0]) {
    await adoptSession(session);
    setSignedIn(true);
    toast.success("Signed in");
    props.onSuccess?.();
  }

  async function submitPasskey(e: Event) {
    e.preventDefault();
    if (busy() || !identifier().trim()) return;
    if (turnstileOn() && !turnstileToken()) {
      setError({
        ...plainError("Please complete the verification challenge below."),
        passkey: false,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trimmed = identifier().trim();
      const token = turnstileToken() ?? undefined;
      let beginResult: { options: Parameters<typeof startAuthentication>[0]["optionsJSON"] };
      try {
        // Pass the token only when present so the no-Turnstile call shape is
        // unchanged (single-arg `passkeyBegin(identifier)`).
        beginResult = (await (token
          ? client.passkeyBegin(trimmed, token)
          : client.passkeyBegin(trimmed))) as typeof beginResult;
      } finally {
        // The server checks the token before it answers, so `/begin` has
        // spent it whether it accepted or refused. Tokens are single-use, so
        // retire it and ask the widget for a fresh one — otherwise any retry
        // replays the spent token, the server refuses it, and the user is
        // trapped on the sign-in screen. Cloudflare only refreshes a token
        // when it expires (~300s), never when it is spent.
        if (turnstileOn()) resetTurnstile?.();
      }
      const assertion = await startAuthentication({ optionsJSON: beginResult.options });
      const { session } = await client.passkeyComplete({ identifier: trimmed, assertion });
      await finishWithSession(session);
    } catch (err) {
      // Never the error's own text: the server's and the browser's words stay
      // off the screen, and two failures the server answers alike read alike.
      setError({
        ...fieldError(describePasskeyError(err, "authentication"), err),
        passkey: true,
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Discoverable-credential (conditional-UI) flow. Kicks off on mount when
   * the browser supports `mediation: "conditional"` and the user has at
   * least one resident credential for the RP. The ceremony runs in the
   * background — if the user ignores the autofill prompt, nothing happens
   * and the regular identifier flow still works.
   */
  async function startConditionalPasskey() {
    if (typeof window === "undefined") return;
    // lib.dom declares `PublicKeyCredential` as always present. It is absent
    // wherever WebAuthn is — older browsers, and the jsdom test env — so the
    // local type keeps the member optional and the detection below real.
    const PKC: {
      isConditionalMediationAvailable?: () => Promise<boolean>;
    } = window.PublicKeyCredential ?? {};
    if (typeof PKC.isConditionalMediationAvailable !== "function") return;
    try {
      const available = await PKC.isConditionalMediationAvailable();
      if (!available) return;
      const beginResult = (await client.passkeyBegin()) as {
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeId?: string;
      };
      if (!beginResult.challengeId) return;
      const assertion = await startAuthentication({
        optionsJSON: beginResult.options,
        useBrowserAutofill: true,
      });
      const { session } = await client.passkeyComplete({
        challengeId: beginResult.challengeId,
        assertion,
      });
      await finishWithSession(session);
    } catch {
      // Silent fail — conditional UI is opportunistic. A real failure
      // surfaces when the user submits via the form.
    }
  }

  onMount(() => {
    if (webauthnSupported()) void startConditionalPasskey();
  });

  const title = () =>
    view() === "recovery" ? "Recover your account" : `Sign in to ${props.productName}`;
  // The dialog's way out, first in each step's footer; a page's is its title row's.
  const dismiss = () => (props.host === "dialog" ? props.onCancel : undefined);
  const page = () => (props.host === "page" ? props : undefined);
  const lostPasskey = () => (
    <StepLink host={props.host} onClick={openRecovery} disabled={busy()}>
      Lost your passkey?
    </StepLink>
  );

  return (
    <div class="flex flex-col">
      {/* The one title in the view: the recovery form below draws none, so
          a dialog keeps one name as the view switches. */}
      <Show when={page()} fallback={<AuthHeader host="dialog" title={title()} />}>
        {(onPage) => (
          <AuthHeader
            host="page"
            title={title()}
            onCancel={onPage().onCancel}
            cancelLabel={onPage().cancelLabel}
            cancelDisabled={busy()}
          />
        )}
      </Show>

      {/* The host closes the dialog on success, so this line has no footer. */}
      <Show when={signedIn()}>
        <ViewStep host={props.host}>
          <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">You&apos;re all set.</p>
        </ViewStep>
      </Show>

      {/* Primary WebAuthn flow. The step sits inside the form, footer and
          all, so Enter in the field submits. */}
      <Show when={!signedIn() && view() === "passkey" && webauthnSupported()}>
        <form onSubmit={submitPasskey} class="flex flex-col">
          <ViewStep
            host={props.host}
            onCancel={dismiss()}
            cancelDisabled={busy()}
            action={
              // The other reasons apply only while idle: begin spends the
              // token, and the widget drops it before the passkey prompt has
              // closed.
              <Button
                type="submit"
                {...stepAction(props.host)}
                busy={busy()}
                disabled={!busy() && (!identifier().trim() || (turnstileOn() && !turnstileToken()))}
              >
                {busy() ? "Verifying…" : "Continue"}
              </Button>
            }
            links={lostPasskey()}
          >
            <Field labelTreatment="plain" label="Email or @handle">
              {(field) => (
                <>
                  <Input
                    id={field.id}
                    type="text"
                    required
                    autocomplete="username webauthn"
                    autocapitalize="none"
                    spellcheck={false}
                    value={identifier()}
                    onInput={(e) => setIdentifier(e.currentTarget.value)}
                    aria-describedby={describedBy(field["aria-describedby"], error() && errorId)}
                    aria-invalid={error()?.invalid || undefined}
                  />
                  <Show when={error()}>
                    {(line) => (
                      <Notice tone="danger" size="inline" alert id={errorId}>
                        {line().text}
                        {/* The passkey sentence names no cause, so the way in
                            without one sits beside it. */}
                        <Show when={line().passkey}>
                          {" "}
                          <InlineAction onClick={openRecovery}>Lost your passkey?</InlineAction>
                        </Show>
                      </Notice>
                    )}
                  </Show>
                </>
              )}
            </Field>
            {/* Turnstile challenge — renders only when a sitekey is provided. */}
            <TurnstileWidget
              siteKey={props.turnstileSiteKey}
              onToken={setTurnstileToken}
              onReady={(c) => (resetTurnstile = c.reset)}
              alternative="Signing in with a recovery code doesn't need this challenge: choose “Lost your passkey?”."
            />
          </ViewStep>
        </form>
      </Show>

      {/* No WebAuthn support in this environment */}
      <Show when={!signedIn() && view() === "passkey" && !webauthnSupported()}>
        <ViewStep
          host={props.host}
          onCancel={dismiss()}
          action={
            // The step's one way forward. In a dialog it is the footer's
            // commit beside a `secondary` Cancel; on a page it stays the
            // `secondary` fallback it has always been.
            <Button
              type="button"
              {...stepAction(props.host)}
              variant={props.host === "dialog" ? "default" : "secondary"}
              onClick={openRecovery}
            >
              Use a recovery code instead
            </Button>
          }
        >
          {/* A blocker that stops the flow here: an info notice, not body copy. */}
          <Notice tone="info" size="sm">
            {props.productName} sign-in needs a passkey or security key, and this browser
            doesn&apos;t support WebAuthn.
          </Notice>
          <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">You can either:</p>
          <ul class="text-ui-sm leading-ui-snug text-ui-ink-secondary list-inside list-disc">
            <li>Sign in on a device that does (iOS 16+, Android 9+, recent desktop browsers).</li>
            <li>
              Use your phone via the QR / Bluetooth cross-device flow offered by your password
              manager on next try.
            </li>
            <li>Plug in a FIDO2 security key and reload the page.</li>
          </ul>
        </ViewStep>
      </Show>

      {/* Recovery escape hatch */}
      <Show when={!signedIn() && view() === "recovery"}>
        <RecoveryLoginForm
          {...(props.host === "dialog"
            ? { host: "dialog" as const, onDismiss: props.onCancel }
            : { host: "page" as const })}
          client={props.recoveryClient}
          registrationClient={props.registrationClient}
          runPasskeyRegistration={props.runPasskeyRegistration}
          turnstileSiteKey={props.turnstileSiteKey}
          productName={props.productName}
          onSuccess={() => {
            setSignedIn(true);
            props.onSuccess?.();
          }}
          onCancel={() => setView("passkey")}
        />
      </Show>
    </div>
  );
}
