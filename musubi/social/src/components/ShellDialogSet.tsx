import { AuthDialogs } from "./AuthDialogs";
import { ProfileSwitcherDialog } from "./ProfileSwitcherDialog";
import type { ShellDialog } from "./ShellDialogs";

/**
 * The shell's dialogs as one unit, and one lazy chunk: sign in, create
 * account, switch profile. `ShellDialogs` holds which one is open.
 *
 * One chunk, not one per dialog. Two separate dynamic imports make the bundler
 * split the entry chunk in two and keep client code it otherwise drops, which
 * adds about 1 KB gzipped to what `/authorize` downloads before it can paint.
 */
export function ShellDialogSet(props: {
  open: ShellDialog | null;
  onOpenChange: (dialog: ShellDialog, open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <>
      <AuthDialogs
        showRegister={props.open === "register"}
        onShowRegisterChange={(open) => props.onOpenChange("register", open)}
        showSignIn={props.open === "sign-in"}
        onShowSignInChange={(open) => props.onOpenChange("sign-in", open)}
        onCloseAutoFocus={props.onCloseAutoFocus}
      />
      <ProfileSwitcherDialog
        open={props.open === "switcher"}
        onOpenChange={(open) => props.onOpenChange("switcher", open)}
        onCloseAutoFocus={props.onCloseAutoFocus}
      />
    </>
  );
}
