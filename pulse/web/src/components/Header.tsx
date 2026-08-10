import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { useAuth } from "@shared/rp-auth/solid";
import { A, useNavigate } from "@solidjs/router";
import { createMemo, createSignal, Show } from "solid-js";

import { setShowCreateForm } from "../lib/createEventSignal";
import { displayNameOf, initialOf, safeAvatarUrl } from "../lib/utils";

export function Header() {
  // Pulse is a relying party: the passkey lives on `musubi.social`, so there
  // is no ceremony to run here and no sign-in dialog. `signIn()` is a
  // full-page trip to the issuer and back through Pulse's own API.
  const { session, signIn, logout } = useAuth();
  const navigate = useNavigate();

  const [createHovered, setCreateHovered] = createSignal(false);

  const name = createMemo(() => displayNameOf(session() ?? null));
  const avatar = createMemo(() => safeAvatarUrl(session()?.avatarUrl));

  return (
    <header class="flex w-full items-center justify-between px-6 py-4">
      {/* Left: logo */}
      <A href="/" class="text-foreground text-xl font-bold tracking-tight select-none">
        Pulse
      </A>

      {/* Right: actions */}
      <div class="flex items-center gap-3">
        <Show
          when={session()}
          // No `returnTo`: the default is the current URL, and the API
          // re-validates it against its own allowlist.
          fallback={
            <Button size="sm" onClick={() => signIn()}>
              Continue with musubi
            </Button>
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
                <Show when={avatar()}>
                  {(url) => <AvatarImage src={url()} alt={name() ?? "You"} />}
                </Show>
                <AvatarFallback class="text-xs">{initialOf(name())}</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel class="text-muted-foreground font-normal">
                  {name() ?? "…"}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
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
  );
}
