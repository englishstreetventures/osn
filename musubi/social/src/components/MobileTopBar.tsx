import { useAuth } from "@osn/client/solid";
import { clsx } from "@shared/ui/lib/utils";
import { Button } from "@shared/ui/ui/button";
import { createMemo, Show } from "solid-js";

import { getTokenClaims } from "../lib/utils";
import { AccountMenu } from "./AccountMenu";
import { ProfileAvatar } from "./Avatars";
import { useShellDialogs } from "./ShellDialogs";
import { TopBarHeader } from "./ShellFrame";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The mobile shell's header, rendered below `md` only: wordmark on the left;
 * theme toggle plus the account control (avatar menu when signed in, the auth
 * CTAs when signed out) on the right. Sits above the scroll container in the
 * layout column, so it never scrolls away. The dialogs it opens live in
 * `ShellDialogs`, above both shells.
 */
export function MobileTopBar() {
  const { session, profiles, activeProfileId } = useAuth();
  const dialogs = useShellDialogs();

  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );
  // Read for display only, as the menu's own label reads it.
  const handle = createMemo(() => getTokenClaims(session()?.accessToken ?? null).handle);

  return (
    <TopBarHeader
      end={
        <div class="flex items-center gap-2">
          <ThemeToggle place="bar" />
          <Show
            when={session()}
            fallback={
              // Invisible until the dialogs they open have loaded: they hold
              // their place, and never offer a dialog that cannot open.
              <div class={clsx("flex items-center gap-1.5", !dialogs.ready() && "invisible")}>
                <Button
                  variant="secondary"
                  size="sm"
                  class="h-10"
                  data-dialog-return="sign-in"
                  onClick={() => dialogs.open("sign-in")}
                >
                  Sign in
                </Button>
                <Button
                  size="sm"
                  class="h-10"
                  data-dialog-return="register"
                  onClick={() => dialogs.open("register")}
                >
                  Create account
                </Button>
              </div>
            }
          >
            {/* The avatar says nothing a screen reader can use, so the
                trigger carries its own name: what it opens, and whose. */}
            <AccountMenu
              triggerClass="cursor-pointer rounded-pill"
              triggerLabel={handle() ? `Account menu, @${handle()}` : "Account menu"}
            >
              <ProfileAvatar profile={activeProfile()} class="size-10" decorative />
            </AccountMenu>
          </Show>
        </div>
      }
    />
  );
}
