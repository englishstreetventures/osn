import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { createMemo, createSignal, Show } from "solid-js";

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
          <div class="flex items-baseline gap-1.5">
            <span class="text-foreground text-title font-medium">OSN</span>
            <span class="text-subtle text-meta tracking-[0.06em] uppercase">Social</span>
          </div>
          <div class="flex items-center gap-2">
            <ThemeToggle />
            <Show
              when={session()}
              fallback={
                <div class="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    class="text-body rounded-pill h-9"
                    onClick={() => {
                      setShowRegister(false);
                      setShowSignIn(true);
                    }}
                  >
                    Sign in
                  </Button>
                  <Button
                    size="sm"
                    class="text-body rounded-pill h-9"
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
                  <AvatarFallback class="text-meta">
                    {profileInitials(activeProfile())}
                  </AvatarFallback>
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
