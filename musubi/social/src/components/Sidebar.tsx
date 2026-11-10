import { useAuth } from "@osn/client/solid";
import { clsx } from "@shared/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { A, useLocation } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";

import { getTokenClaims, profileInitials, safeAvatarUrl } from "../lib/utils";
import { AccountMenu } from "./AccountMenu";
import { GlobalSearch } from "./GlobalSearch";
import { DESKTOP_NAV_ITEMS, isNavActive } from "./nav";
import { useShellDialogs } from "./ShellDialogs";
import { RailAside, RailHead } from "./ShellFrame";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The desktop shell: the fixed 240px left rail. Hidden below `md`, where
 * `MobileTopBar` + `MobileNav` take over. Nav items live in `nav.tsx`
 * (shared with the tab bar); the account dropdown is shared with the top bar,
 * and the dialogs it opens live in `ShellDialogs`, above both shells.
 */
export function Sidebar() {
  const location = useLocation();
  const { session, profiles, activeProfileId } = useAuth();
  const dialogs = useShellDialogs();

  // Claims are read for display only; no request carries this token.
  const claims = createMemo(() => getTokenClaims(session()?.accessToken ?? null));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  return (
    <RailAside>
      <RailHead toggle={<ThemeToggle />} />

      {/* Search — signed-in only; the endpoint needs a session, and an
            input that can only fail is worse than no input. */}
      <Show when={session()}>
        <GlobalSearch />
      </Show>

      {/* Navigation */}
      <nav class="flex flex-1 flex-col gap-0.5 px-3 pt-5">
        <For each={DESKTOP_NAV_ITEMS}>
          {(item) => (
            <A
              href={item.href}
              class={clsx(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body font-medium transition-ui-colors",
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
                class="w-full"
                data-dialog-return="register"
                onClick={() => dialogs.open("register")}
              >
                Create account
              </Button>
              <Button
                variant="secondary"
                size="sm"
                class="w-full"
                data-dialog-return="sign-in"
                onClick={() => dialogs.open("sign-in")}
              >
                Sign in
              </Button>
            </div>
          }
        >
          <AccountMenu
            triggerClass="hover:bg-muted flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-ui-colors"
            onSwitchProfile={() => dialogs.open("switcher")}
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
              <AvatarFallback>{profileInitials(activeProfile())}</AvatarFallback>
            </Avatar>
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="text-foreground text-body truncate font-medium">
                {activeProfile()?.displayName || `@${claims().handle ?? "…"}`}
              </span>
              <Show when={activeProfile()?.displayName}>
                <span class="text-muted-foreground text-meta truncate">@{claims().handle}</span>
              </Show>
            </div>
          </AccountMenu>
        </Show>
      </div>
    </RailAside>
  );
}
