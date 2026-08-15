import { useAuth } from "@osn/client/solid";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { Dialog } from "@osn/ui/ui/dialog";
import { createEffect } from "solid-js";

import { TURNSTILE_SITEKEY } from "../lib/auth";
import { registrationClient, loginClient, recoveryClient } from "../lib/authClients";
import { ResponsiveDialogContent } from "./ResponsiveDialogContent";

/**
 * The Create-account and Sign-in dialogs, shared by the desktop rail and the
 * mobile top bar. Each shell owns its open/close signals; both dialogs close
 * themselves the moment a session exists.
 */
export function AuthDialogs(props: {
  showRegister: boolean;
  onShowRegisterChange: (open: boolean) => void;
  showSignIn: boolean;
  onShowSignInChange: (open: boolean) => void;
}) {
  const { session } = useAuth();

  // A controlled Dialog never fires `onOpenChange` when the `open` prop flips
  // on its own, so the `!session()` guard below hides a dialog without ever
  // clearing the shell's flag. Left set, that flag re-opened the sheet the
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
        <ResponsiveDialogContent class="max-w-sm p-0">
          <Register
            client={registrationClient}
            turnstileSiteKey={TURNSTILE_SITEKEY}
            onCancel={() => props.onShowRegisterChange(false)}
            onSuccess={() => props.onShowRegisterChange(false)}
          />
        </ResponsiveDialogContent>
      </Dialog>
      <Dialog open={props.showSignIn && !session()} onOpenChange={props.onShowSignInChange}>
        <ResponsiveDialogContent class="max-w-sm p-0">
          <SignIn
            client={loginClient}
            recoveryClient={recoveryClient}
            turnstileSiteKey={TURNSTILE_SITEKEY}
            onCancel={() => props.onShowSignInChange(false)}
            onSuccess={() => props.onShowSignInChange(false)}
          />
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}
