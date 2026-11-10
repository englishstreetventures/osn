import { Register } from "@osn/auth-ui/Register";
import { SignIn } from "@osn/auth-ui/SignIn";
import { useAuth } from "@osn/client/solid";
import { Dialog } from "@shared/ui/ui/dialog";
import { createEffect } from "solid-js";

import { PRODUCT_NAME, TURNSTILE_SITEKEY } from "../lib/auth";
import { registrationClient, loginClient, recoveryClient } from "../lib/authClients";
import { runPasskeyRegistrationDeferred } from "../lib/webauthn-registration-deferred";
import { ResponsiveDialogContent } from "./ResponsiveDialogContent";

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

  return (
    <>
      <Dialog open={props.showRegister && !session()} onOpenChange={props.onShowRegisterChange}>
        {/* The view heads itself with a plain heading, not a dialog title,
            so the dialog takes its name here. */}
        <ResponsiveDialogContent
          aria-label="Create account"
          onCloseAutoFocus={props.onCloseAutoFocus}
        >
          <Register
            client={registrationClient}
            turnstileSiteKey={TURNSTILE_SITEKEY}
            productName={PRODUCT_NAME}
            onCancel={() => props.onShowRegisterChange(false)}
            onSuccess={() => props.onShowRegisterChange(false)}
          />
        </ResponsiveDialogContent>
      </Dialog>
      <Dialog open={props.showSignIn && !session()} onOpenChange={props.onShowSignInChange}>
        <ResponsiveDialogContent aria-label="Sign in" onCloseAutoFocus={props.onCloseAutoFocus}>
          <SignIn
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
