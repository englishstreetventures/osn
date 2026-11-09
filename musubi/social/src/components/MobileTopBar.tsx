import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { createMemo, Show } from "solid-js";

import { profileInitials, safeAvatarUrl } from "../lib/utils";
import { AccountMenu } from "./AccountMenu";
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

  return (
    <TopBarHeader
      end={
        <div class="flex items-center gap-2">
          <ThemeToggle />
          <Show
            when={session()}
            fallback={
              <div class="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  class="h-9"
                  data-dialog-return="sign-in"
                  onClick={() => dialogs.open("sign-in")}
                >
                  Sign in
                </Button>
                <Button
                  size="sm"
                  class="h-9"
                  data-dialog-return="register"
                  onClick={() => dialogs.open("register")}
                >
                  Create account
                </Button>
              </div>
            }
          >
            <AccountMenu
              triggerClass="cursor-pointer rounded-pill"
              onSwitchProfile={() => dialogs.open("switcher")}
            >
              <Avatar class="h-9 w-9">
                <Show when={safeAvatarUrl(activeProfile()?.avatarUrl)}>
                  {(url) => (
                    <AvatarImage
                      src={url()}
                      alt={activeProfile()!.handle}
                      referrerpolicy="no-referrer"
                      loading="lazy"
                    />
                  )}
                </Show>
                <AvatarFallback>{profileInitials(activeProfile())}</AvatarFallback>
              </Avatar>
            </AccountMenu>
          </Show>
        </div>
      }
    />
  );
}
