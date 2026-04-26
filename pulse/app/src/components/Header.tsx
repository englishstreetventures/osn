import type { PublicProfile } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Register } from "@osn/ui/auth/Register";
import { SignIn } from "@osn/ui/auth/SignIn";
import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@osn/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { A, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { registrationClient, loginClient, recoveryClient } from "../lib/authClients";
import { setShowCreateForm } from "../lib/createEventSignal";
import { getTokenClaims } from "../lib/utils";

function profileInitials(profile: PublicProfile | null): string {
  if (!profile) return "?";
  const name = profile.displayName || profile.handle;
  return name.slice(0, 2).toUpperCase();
}

export function Header() {
  const { session, logout, profiles, activeProfileId, switchProfile } = useAuth();
  const navigate = useNavigate();

  const [showRegister, setShowRegister] = createSignal(false);
  const [showSignIn, setShowSignIn] = createSignal(false);
  const [showSwitcher, setShowSwitcher] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  const [createHovered, setCreateHovered] = createSignal(false);

  const accessToken = () => session()?.accessToken ?? null;
  const claims = createMemo(() => getTokenClaims(accessToken()));
  const activeProfile = createMemo(
    () => profiles()?.find((p) => p.id === activeProfileId()) ?? null,
  );

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
      <header class="flex w-full items-center justify-between px-6 py-4">
        {/* Left: logo */}
        <A href="/" class="text-foreground text-xl font-bold tracking-tight select-none">
          Pulse
        </A>

        {/* Right: actions */}
        <div class="flex items-center gap-3">
          <Show
            when={session()}
            fallback={
              <>
                <Button
                  size="sm"
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
                  onClick={() => {
                    setShowRegister(false);
                    setShowSignIn(true);
                  }}
                >
                  Sign in
                </Button>
              </>
            }
          >
            {/* Expanding "+" → "Create new event" pill.
                Pure CSS transition on max-width. Inline style for the collapsed
                max-width so the transition target is explicit. All properties
                used (max-width, overflow, transition, opacity) have baseline
                browser support across all evergreen browsers. */}
            <button
              type="button"
              onClick={() => setShowCreateForm((v) => !v)}
              class="group bg-foreground text-background flex h-9 cursor-pointer items-center overflow-hidden rounded-full transition-[max-width,padding] duration-300 ease-out"
              style={{
                "max-width": createHovered() ? "200px" : "36px",
                "padding-left": createHovered() ? "12px" : "10px",
                "padding-right": createHovered() ? "14px" : "10px",
              }}
              onMouseEnter={() => setCreateHovered(true)}
              onMouseLeave={() => setCreateHovered(false)}
              aria-label="Create new event"
            >
              <svg
                class="h-4 w-4 shrink-0"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <line x1="8" y1="3" x2="8" y2="13" />
                <line x1="3" y1="8" x2="13" y2="8" />
              </svg>
              <span class="ml-2 text-sm font-medium whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                Create new event
              </span>
            </button>

            {/* Avatar dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger class="focus-visible:ring-ring cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2">
                <Avatar class="h-9 w-9">
                  <Show when={activeProfile()?.avatarUrl}>
                    {(url) => <AvatarImage src={url()} alt={activeProfile()!.handle} />}
                  </Show>
                  <AvatarFallback class="text-xs">
                    {profileInitials(activeProfile())}
                  </AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuGroup>
                  <DropdownMenuLabel class="text-muted-foreground font-normal">
                    @{claims().handle ?? "..."}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setShowSwitcher(true)}>
                  Switch profile
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate("/close-friends")}>
                  Close friends
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate("/settings")}>Settings</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => logout()}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </div>
      </header>

      {/* Auth dialogs (unauthenticated) */}
      <Dialog open={showRegister() && !session()} onOpenChange={setShowRegister}>
        <DialogContent class="max-w-sm p-0">
          <Register client={registrationClient} onCancel={() => setShowRegister(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={showSignIn() && !session()} onOpenChange={setShowSignIn}>
        <DialogContent class="max-w-sm p-0">
          <SignIn
            client={loginClient}
            recoveryClient={recoveryClient}
            onCancel={() => setShowSignIn(false)}
            onSuccess={() => setShowSignIn(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Profile switcher dialog */}
      <Dialog open={showSwitcher()} onOpenChange={setShowSwitcher}>
        <DialogContent class="max-w-xs">
          <DialogHeader>
            <DialogTitle>Switch profile</DialogTitle>
          </DialogHeader>
          <div class="flex flex-col gap-1 py-2">
            <For each={profiles() ?? []}>
              {(profile) => {
                const isActive = () => profile.id === activeProfileId();
                return (
                  <button
                    type="button"
                    class={clsx(
                      "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      isActive()
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted text-foreground",
                    )}
                    disabled={switching()}
                    onClick={() => handleSwitch(profile)}
                  >
                    <Avatar class="h-7 w-7">
                      <Show when={profile.avatarUrl}>
                        {(url) => <AvatarImage src={url()} alt={profile.handle} />}
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
                    <Show when={isActive()}>
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
