import { useAuth } from "@osn/client/solid";
import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { A, useLocation } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";

import { getTokenClaims, profileInitials, safeAvatarUrl } from "../lib/utils";
import { AccountMenu } from "./AccountMenu";
import { AuthDialogs } from "./AuthDialogs";
import { isNavActive, NAV_ITEMS } from "./nav";
import { ProfileSwitcherDialog } from "./ProfileSwitcherDialog";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The desktop shell: the fixed 240px left rail. Hidden below `md`, where
 * `MobileTopBar` + `MobileNav` take over. Nav items live in `nav.tsx`
 * (shared with the tab bar); the account dropdown and the auth / switcher
 * dialogs are shared components mounted per shell.
 */
export function Sidebar() {
  const location = useLocation();
  const { session, profiles, activeProfileId } = useAuth();

  const [showRegister, setShowRegister] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [showSwitcher, setShowSwitcher] = createSignal(false);

  const accessToken = () => session()?.accessToken ?? null;
  const claims = createMemo(() => getTokenClaims(accessToken()));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  return (
    <>
      <aside class="border-border hidden h-dvh w-60 shrink-0 flex-col border-r md:flex">
        {/* Logo */}
        <div class="flex items-center justify-between px-4 pt-6 pb-1">
          <div class="flex items-baseline gap-1.5">
            <span class="text-foreground text-title font-medium">OSN</span>
            <span class="text-subtle text-meta tracking-[0.06em] uppercase">Social</span>
          </div>
          <ThemeToggle />
        </div>

        {/* Navigation */}
        <nav class="flex flex-1 flex-col gap-0.5 px-3 pt-5">
          <For each={NAV_ITEMS}>
            {(item) => (
              <A
                href={item.href}
                class={clsx(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body font-medium transition-colors",
                  isNavActive(location.pathname, item.href)
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <span
                  class={clsx(
                    isNavActive(location.pathname, item.href) ? "text-foreground" : "text-subtle",
                  )}
                >
                  <item.icon class="h-3.5 w-3.5" />
                </span>
                {item.label}
              </A>
            )}
          </For>
        </nav>

        {/* User section */}
        <div class="border-border border-t px-3 py-3">
          <Show
            when={session()}
            fallback={
              <div class="flex flex-col gap-1.5">
                <Button
                  size="sm"
                  class="text-body rounded-pill w-full"
                  onClick={() => {
                    setShowSignIn(false);
                    setShowRegister(true);
                  }}
                >
                  Create account
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  class="text-body rounded-pill w-full"
                  onClick={() => {
                    setShowRegister(false);
                    setShowSignIn(true);
                  }}
                >
                  Sign in
                </Button>
              </div>
            }
          >
            <AccountMenu
              triggerClass="hover:bg-muted flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors outline-none"
              onSwitchProfile={() => setShowSwitcher(true)}
            >
              <Avatar class="h-8 w-8">
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
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="text-foreground text-body truncate font-medium">
                  {activeProfile()?.displayName || `@${claims().handle ?? "..."}`}
                </span>
                <Show when={activeProfile()?.displayName}>
                  <span class="text-subtle text-meta truncate">@{claims().handle}</span>
                </Show>
              </div>
            </AccountMenu>
          </Show>
        </div>
      </aside>

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
