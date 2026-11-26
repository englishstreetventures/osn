import { useAuth } from "@osn/client/solid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { createMemo, For, type JSX, Show } from "solid-js";

import { switching, switchToProfile } from "../lib/profile-switch";
import { getTokenClaims } from "../lib/utils";
import { ProfileAvatar } from "./Avatars";

/**
 * The signed-in account menu, shared by the desktop rail and the mobile top
 * bar: who is signed in, the account's profiles to switch between, and Log
 * out. The caller supplies the trigger's content and styling; the menu itself
 * is identical in both shells.
 *
 * The profiles are the switcher: one `menuitemradio` row each, the active one
 * checked, and choosing another switches to it and closes the menu. The rows
 * follow the active profile, so a row is checked only once its switch has
 * landed; while one runs every row is disabled, in this menu and the other
 * shell's. A single profile is not a choice, so an account with one shows no
 * rows.
 */
export function AccountMenu(props: {
  triggerClass?: string;
  /**
   * The trigger's name, for a trigger whose content says nothing (the top
   * bar's avatar). A trigger that shows the name and handle needs none.
   */
  triggerLabel?: string;
  children: JSX.Element;
}) {
  const { session, logout, profiles, activeProfileId, switchProfile } = useAuth();
  const claims = createMemo(() => getTokenClaims(session()?.accessToken ?? null));
  const all = () => profiles() ?? [];

  function choose(id: string) {
    const profile = all().find((p) => p.id === id);
    if (profile) void switchToProfile(switchProfile, profile);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        class={props.triggerClass}
        aria-label={props.triggerLabel}
        data-account-menu=""
      >
        {props.children}
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel tone="identity">@{claims().handle ?? "…"}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <Show when={all().length > 1}>
          <DropdownMenuSeparator />
          {/* Controlled by the active profile, never `undefined`: an
              uncontrolled group would check the chosen row before its switch
              has landed. */}
          <DropdownMenuRadioGroup value={activeProfileId() ?? ""} onChange={choose}>
            <For each={all()}>
              {(profile) => (
                <DropdownMenuRadioItem value={profile.id} disabled={switching()} closeOnSelect>
                  {/* The gap is the wrapper's: the avatar's class is its size alone. */}
                  <span class="mr-2.5 inline-flex shrink-0">
                    <ProfileAvatar profile={profile} class="size-5" letters={1} decorative />
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    {profile.displayName || `@${profile.handle}`}
                    <Show when={profile.displayName}>
                      <span class="text-muted-foreground ml-1.5">@{profile.handle}</span>
                    </Show>
                  </span>
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </Show>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout()}>Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
