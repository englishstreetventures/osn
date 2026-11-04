import { avatarTriggerClass } from "@cire/ui/avatar-trigger-class";
import PersonAvatar from "@cire/ui/person-avatar";
import type { RpSession } from "@shared/rp-auth";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { For, type JSX, Show } from "solid-js";

import { haptic, hapticsAvailable } from "../lib/haptics";
import {
  hapticsEnabled,
  setHapticsEnabled,
  setThemePreference,
  type ThemePreference,
  themePreference,
} from "../lib/theme";

/** "System" first because it is the default, and the only one that keeps
 *  following the host's OS after they close the menu. */
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The avatar circle the menu opens from: a control with its own look, which
 *  the menu's trigger renders as (`as`), as it would a `Button`. */
function AvatarButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} class={avatarTriggerClass} />;
}

/**
 * The top bar's account affordance: an avatar button opening a menu with
 * everything scoped to the person rather than to a wedding — appearance,
 * haptics, security, sign out. Those used to sit in a portal-wide nav row next
 * to Weddings, which put "who am I" housekeeping on the same axis as "what am I
 * working on"; an avatar menu splits the two and leaves the bar for the work.
 *
 * The trigger shows the account's avatar when the session carries one, else the
 * first letter of whatever identifies the account best (display name, then
 * handle, then email), drawn by `@cire/ui`'s `PersonAvatar`. The menu head names the account so a host juggling two OSN accounts
 * can tell which one is signed in before acting on it.
 *
 * The shared menu's accent look, as every portal menu draws it: full-ink rows,
 * the highlighted one a gold wash with readable gold, a muted eyebrow over the
 * theme choices, the shared `Switch`'s own track and thumb on the haptics row.
 */
export default function ProfileMenu(props: {
  session: RpSession | null | undefined;
  onSecurity: () => void;
  onSignOut: () => void;
}) {
  const name = () =>
    props.session?.displayName ?? props.session?.handle ?? props.session?.email ?? "Your account";
  // The secondary line — skipped when it would only repeat the primary one.
  const detail = () => {
    const s = props.session;
    if (!s) return null;
    if (s.displayName) return s.handle ? `@${s.handle}` : s.email;
    return s.handle ? s.email : null;
  };
  return (
    <DropdownMenu placement="bottom-end" gutter={8}>
      <DropdownMenuTrigger as={AvatarButton} aria-label="Account menu">
        <PersonAvatar
          fallback="initial"
          name={name()}
          url={props.session?.avatarUrl}
          class="size-full"
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent variant="accent" class="min-w-52">
        <div class="flex flex-col gap-0.5 px-3 pt-2 pb-2.5">
          <span class="font-body text-text text-ui-sm truncate">{name()}</span>
          <Show when={detail()}>
            {(line) => <span class="font-body text-text-muted text-ui-xs truncate">{line()}</span>}
          </Show>
        </div>
        <DropdownMenuSeparator />

        {/* Appearance and haptics stay open on select: both are things you
            try, look at (or feel), and try again — closing the menu after
            each one would make comparing them a three-click job. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel tone="eyebrow">Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={themePreference()}
            onChange={(next) => setThemePreference(next as ThemePreference)}
          >
            <For each={THEME_OPTIONS}>
              {(option) => (
                <DropdownMenuRadioItem value={option.value} closeOnSelect={false}>
                  {option.label}
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>

        {/* Offered wherever the portal can deliver feedback — which includes
            iOS, where the API check says no and the switch fallback says yes.
            Feedback a host cannot turn off is the failure worth avoiding. */}
        <Show when={hapticsAvailable()}>
          <DropdownMenuCheckboxItem
            checked={hapticsEnabled()}
            indicator="switch"
            onChange={(checked) => {
              setHapticsEnabled(checked);
              // Fire the confirmation *after* enabling, so turning it on
              // demonstrates itself.
              if (checked) haptic("commit");
            }}
          >
            Haptics
          </DropdownMenuCheckboxItem>
        </Show>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => props.onSecurity()}>
          Security &amp; passkeys
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onSignOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
