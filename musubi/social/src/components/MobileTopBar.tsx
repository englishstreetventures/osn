import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { createMemo, createSignal, Show } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { profileInitials, safeAvatarUrl } from "../lib/utils";
import { AccountMenu } from "./AccountMenu";
import { AuthDialogs } from "./AuthDialogs";
import { ProfileSwitcherDialog } from "./ProfileSwitcherDialog";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The mobile shell's header, rendered below `md` only: wordmark on the left;
 * theme toggle plus the account control (avatar menu when signed in, the auth
 * CTAs when signed out) on the right. Sits above the scroll container in the
 * layout column, so it never scrolls away.
 */
export function MobileTopBar() {
  const { session, profiles, activeProfileId } = useAuth();

  const [showRegister, setShowRegister] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [showSwitcher, setShowSwitcher] = createSignal(false);

  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  return (
    <>
      <header class="border-border bg-background pt-safe px-safe border-b md:hidden">
        <div class="flex h-12 items-center justify-between px-4">
          {/* The product name alone, without the rail's small-caps "Social" tag:
              at 320px the signed-out bar has no room for the tag beside
              "Sign in" and "Create account". */}
          <span class="text-foreground text-title font-medium">{PRODUCT_NAME}</span>
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
                    onClick={() => {
                      setShowRegister(false);
                      setShowSignIn(true);
                    }}
                  >
                    Sign in
                  </Button>
                  <Button
                    size="sm"
                    class="h-9"
                    onClick={() => {
                      setShowSignIn(false);
                      setShowRegister(true);
                    }}
                  >
                    Create account
                  </Button>
                </div>
              }
            >
              <AccountMenu
                triggerClass="cursor-pointer rounded-pill outline-none"
                onSwitchProfile={() => setShowSwitcher(true)}
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
        </div>
      </header>

      <AuthDialogs
        showRegister={showRegister()}
        onShowRegisterChange={setShowRegister}
        showSignIn={showSignIn()}
        onShowSignInChange={setShowSignIn}
      />
      <ProfileSwitcherDialog open={showSwitcher()} onOpenChange={setShowSwitcher} />
    </>
  );
}
