import { hasPendingRecovery } from "@osn/auth-ui/pending-recovery";
import { hasPendingSignUp } from "@osn/auth-ui/pending-sign-up";
import { Register } from "@osn/auth-ui/Register";
import { SignIn } from "@osn/auth-ui/SignIn";
import { useAuth } from "@osn/client/solid";
import { Dialog } from "@shared/ui/ui/dialog";
import { createEffect, onMount } from "solid-js";

import { PRODUCT_NAME, TURNSTILE_SITEKEY } from "../lib/auth";
import { registrationClient, loginClient, recoveryClient } from "../lib/authClients";
import { runPasskeyRegistrationDeferred } from "../lib/webauthn-registration-deferred";
import { ResponsiveDialogContent } from "./ResponsiveDialogContent";

/**
 * Opens a dialog with focus on the dialog itself, not its first control. The
 * sign-in view's first control is its text field, which would raise a
 * phone's keyboard over the sheet as it opens, and the create-account view's
 * is the "i" beside Email. A screen reader still hears the dialog's name, and
 * Tab reaches the first field.
 */
function focusDialog(event: Event) {
  const dialog = event.currentTarget;
  if (!(dialog instanceof HTMLElement)) return;
  event.preventDefault();
  dialog.focus();
}

/**
 * The Create-account and Sign-in dialogs, mounted once through
 * `ShellDialogSet`, above the desktop/phone shell switch; `ShellDialogs` owns
 * their open flags. Both close themselves the moment a session exists.
 */
export function AuthDialogs(props: {
  showRegister: boolean;
  onShowRegisterChange: (open: boolean) => void;
  showSignIn: boolean;
  onShowSignInChange: (open: boolean) => void;
  /** Where focus goes as either dialog closes; see `ResponsiveDialogContent`. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { session } = useAuth();

  // A controlled Dialog never fires `onOpenChange` when the `open` prop flips
  // on its own, so the `!session()` guard below hides a dialog without ever
  // clearing its flag. Left set, that flag re-opened the sheet the
  // next time the session went away — sign out, and the create-account modal
  // was waiting. Reset on any arriving session, whatever its source: this
  // flow's own `onSuccess`, another tab, a cookie bootstrap.
  createEffect(() => {
    if (!session()) return;
    if (props.showRegister) props.onShowRegisterChange(false);
    if (props.showSignIn) props.onShowSignInChange(false);
  });

  // A sign-up this tab was waiting on before a reload — or before a phone
  // discarded the tab while the person read their mail — opens again on its
  // waiting view, so a link confirmed meanwhile finishes here.
  // The same for an emailed recovery link: the sign-in dialog opens on its
  // recovery view, which resumes the wait.
  onMount(() => {
    if (session()) return;
    if (hasPendingSignUp()) props.onShowRegisterChange(true);
    else if (hasPendingRecovery()) props.onShowSignInChange(true);
  });

  return (
    <>
      <Dialog open={props.showRegister && !session()} onOpenChange={props.onShowRegisterChange}>
        {/* The view's title is the dialog's `DialogTitle`, which names it. */}
        <ResponsiveDialogContent
          onOpenAutoFocus={focusDialog}
          onCloseAutoFocus={props.onCloseAutoFocus}
        >
          <Register
            host="dialog"
            client={registrationClient}
            turnstileSiteKey={TURNSTILE_SITEKEY}
            productName={PRODUCT_NAME}
            onCancel={() => props.onShowRegisterChange(false)}
            onSuccess={() => props.onShowRegisterChange(false)}
          />
        </ResponsiveDialogContent>
      </Dialog>
      <Dialog open={props.showSignIn && !session()} onOpenChange={props.onShowSignInChange}>
        <ResponsiveDialogContent
          onOpenAutoFocus={focusDialog}
          onCloseAutoFocus={props.onCloseAutoFocus}
        >
          <SignIn
            host="dialog"
            client={loginClient}
            recoveryClient={recoveryClient}
            registrationClient={registrationClient}
            runPasskeyRegistration={runPasskeyRegistrationDeferred}
            turnstileSiteKey={TURNSTILE_SITEKEY}
            productName={PRODUCT_NAME}
            onCancel={() => props.onShowSignInChange(false)}
            onSuccess={() => props.onShowSignInChange(false)}
          />
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}
