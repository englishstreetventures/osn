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
import { createSignal, For, type JSX, onMount, Show } from "solid-js";

import { accountName } from "../lib/account-name";
import { OSN_ACCOUNT_URL } from "../lib/osn";
import {
  hapticsEnabled,
  setHapticsEnabled,
  setThemePreference,
  type ThemePreference,
  themePreference,
} from "../lib/preferences";
import { haptic, hapticsAvailable } from "../lib/touch-feedback";

/** "System" first because it is the default, and the only one that keeps
 *  following the vendor's OS after they close the menu. */
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
 * The first seven characters of the commit this portal was built from, which
 * CI sets as `PUBLIC_BUILD_SHA` on each deploy build; "local" for a build
 * without it, as the guest site's footer says.
 */
function buildVersion(): string {
  const sha = import.meta.env.PUBLIC_BUILD_SHA?.trim();
  return sha ? sha.slice(0, 7) : "local";
}

/**
 * The top bar's account affordance: an avatar button opening a menu with
 * everything scoped to the person rather than to an organisation — appearance,
 * haptics, account, sign out.
 *
 * Sign out lives here, not as a button in the bar beside "Listings" and
 * "Enquiries": there it would put "who am I" housekeeping on the same axis as
 * "what am I working on", one mis-click apart. The menu splits the two and
 * leaves the bar for the work.
 *
 * ## Account management is a link out, not a view
 *
 * The host portal's equivalent row opens an in-portal security panel. There is
 * no such panel here and there should not be: passkeys and recovery codes are
 * bound to the `musubi.social` RP ID, so every ceremony has to run on musubi's
 * own origin anyway. A row that opened a local screen whose every button then
 * redirected would be a hop that exists only to be got past. The shared link
 * row adds `noopener noreferrer` to a new tab itself, so the other origin gets
 * no `window.opener`.
 *
 * The shared menu's accent look, as every portal menu draws it: full-ink rows,
 * the highlighted one a gold wash with readable gold, a muted eyebrow over the
 * theme choices, the shared `Switch`'s own track and thumb on the haptics row.
 */
export default function ProfileMenu(props: {
  session: RpSession | null | undefined;
  onSignOut: () => void;
  /**
   * Open as soon as this mounts.
   *
   * Set by `TopBar` when the vendor clicked the placeholder before this chunk
   * had landed. Without it that click is simply swallowed — the button they
   * pressed is replaced by a different button that is not open — and a control
   * that ignores the first press is worse than one that took a moment to arrive.
   */
  autoOpen?: boolean;
}) {
  // Controlled, so `autoOpen` has something to open.
  const [open, setOpen] = createSignal(false);

  // Deliberately a frame late rather than seeded true. The click that set
  // `autoOpen` is still propagating when this mounts, and Kobalte installs its
  // dismissable-layer listeners on mount — so a menu that is already open reads
  // its own opening click as an interaction *outside* itself and closes again.
  // One frame puts the open after the event that caused it.
  onMount(() => {
    if (!props.autoOpen) return;
    requestAnimationFrame(() => setOpen(true));
  });

  const name = () => accountName(props.session);
  // The secondary line — skipped when it would only repeat the primary one.
  const detail = () => {
    const s = props.session;
    if (!s) return null;
    if (s.displayName) return s.handle ? `@${s.handle}` : s.email;
    return s.handle ? s.email : null;
  };

  return (
    <DropdownMenu placement="bottom-end" gutter={8} open={open()} onOpenChange={setOpen}>
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
            onChange={(next) => setThemePreference(next as ThemePreference, { fade: true })}
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
            Feedback a vendor cannot turn off is the failure worth avoiding. */}
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
        {/* A real anchor, rather than a row with a click handler: this is a
            navigation, and only an `<a>` gets a middle-click, a "copy link
            address" and a status-bar preview of where it goes. */}
        <DropdownMenuItem as="a" href={`${OSN_ACCOUNT_URL}/settings`} target="_blank">
          Account &amp; passkeys
          <span aria-hidden="true" class="text-text-muted text-ui-xs ml-auto">
            ↗
          </span>
          <span class="sr-only">(opens musubi in a new tab)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onSignOut()}>Sign out</DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* The build, as the guest site's and the marketing site's footers
            print it, so a report from a phone names the build it saw. Not a
            row: nothing to choose, so the keyboard passes it by. */}
        <p
          class="font-body text-text-muted text-ui-xs px-3 pt-1.5 pb-2 tabular-nums"
          translate="no"
        >
          Version {buildVersion()}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
