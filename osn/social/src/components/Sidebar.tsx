import type { PublicProfile } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { Dialog, DialogContent } from "@osn/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { A, useLocation } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { registrationClient, loginClient } from "../lib/authClients";
import { getTokenClaims, profileInitials, safeAvatarUrl } from "../lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: () => import("solid-js").JSX.Element;
}

function IconConnections() {
  return (
    <svg
      class="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconDiscover() {
  return (
    <svg
      class="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function IconOrganisations() {
  return (
    <svg
      class="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg
      class="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { href: "/connections", label: "Connections", icon: IconConnections },
  { href: "/discover", label: "Discover", icon: IconDiscover },
  { href: "/organisations", label: "Organisations", icon: IconOrganisations },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

export function Sidebar() {
  const location = useLocation();
  const { session, logout, profiles, activeProfileId, switchProfile } = useAuth();

  const [showRegister, setShowRegister] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [showSwitcher, setShowSwitcher] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);

  const accessToken = () => session()?.accessToken ?? null;
  const claims = createMemo(() => getTokenClaims(accessToken()));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

  function isActive(href: string): boolean {
    return location.pathname === href || location.pathname.startsWith(href + "/");
  }

  async function handleSwitch(profile: PublicProfile) {
    if (switching() || profile.id === activeProfileId()) return;
    setSwitching(true);
    try {
      const result = await switchProfile(profile.id);
      setShowSwitcher(false);
      toast.success(`Switched to @${result.profile.handle}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch profile");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <aside class="border-border flex h-screen w-60 shrink-0 flex-col border-r">
        {/* Logo */}
        <div class="flex items-center gap-2 px-5 pt-6 pb-2">
          <span class="text-foreground text-lg font-semibold tracking-tight">OSN</span>
          <span class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Social
          </span>
        </div>

        {/* Navigation */}
        <nav class="flex flex-1 flex-col gap-0.5 px-3 pt-4">
          <For each={NAV_ITEMS}>
            {(item) => (
              <A
                href={item.href}
                class={clsx(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
                  isActive(item.href)
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.icon()}
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
                  class="w-full"
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
            <DropdownMenu>
              <DropdownMenuTrigger class="hover:bg-muted flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors outline-none">
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
                  <AvatarFallback class="text-[10px]">
                    {profileInitials(activeProfile())}
                  </AvatarFallback>
                </Avatar>
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="text-foreground truncate text-[13px] font-medium">
                    {activeProfile()?.displayName || `@${claims().handle ?? "..."}`}
                  </span>
                  <Show when={activeProfile()?.displayName}>
                    <span class="text-muted-foreground truncate text-[11px]">
                      @{claims().handle}
                    </span>
                  </Show>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel class="text-muted-foreground font-normal">
                    @{claims().handle ?? "..."}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setShowSwitcher(true)}>
                  Switch profile
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => logout()}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </div>
      </aside>

      {/* Auth dialogs */}
      <Dialog open={showRegister() && !session()} onOpenChange={setShowRegister}>
        <DialogContent class="max-w-sm p-0">
          <Register client={registrationClient} onCancel={() => setShowRegister(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={showSignIn() && !session()} onOpenChange={setShowSignIn}>
        <DialogContent class="max-w-sm p-0">
          <SignIn
            client={loginClient}
            onCancel={() => setShowSignIn(false)}
            onSuccess={() => setShowSignIn(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Profile switcher */}
      <Dialog open={showSwitcher()} onOpenChange={setShowSwitcher}>
        <DialogContent class="max-w-xs">
          <div class="flex flex-col gap-1 py-2">
            <p class="text-foreground mb-2 px-3 text-sm font-semibold">Switch profile</p>
            <For each={profiles() ?? []}>
              {(profile) => {
                const active = () => profile.id === activeProfileId();
                return (
                  <button
                    type="button"
                    class={clsx(
                      "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      active()
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted text-foreground",
                    )}
                    disabled={switching()}
                    onClick={() => handleSwitch(profile)}
                  >
                    <Avatar class="h-7 w-7">
                      <Show when={safeAvatarUrl(profile.avatarUrl)}>
                        {(url) => (
                          <AvatarImage
                            src={url()}
                            alt={profile.handle}
                            referrerpolicy="no-referrer"
                            loading="lazy"
                          />
                        )}
                      </Show>
                      <AvatarFallback class="text-[10px]">
                        {profileInitials(profile)}
                      </AvatarFallback>
                    </Avatar>
                    <span class="flex-1 truncate">
                      @{profile.handle}
                      <Show when={profile.displayName}>
                        <span class="text-muted-foreground ml-1 text-xs">
                          ({profile.displayName})
                        </span>
                      </Show>
                    </span>
                    <Show when={active()}>
                      <span class="text-primary text-xs">&#10003;</span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
