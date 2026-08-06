import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { RpSession } from "@shared/rp-auth";
import { createSignal, For, onMount, Show } from "solid-js";

import { haptic, hapticsAvailable } from "../lib/haptics";
import { OSN_ACCOUNT_URL } from "../lib/osn";
import {
  hapticsEnabled,
  setHapticsEnabled,
  setThemePreference,
  type ThemePreference,
  themePreference,
} from "../lib/theme";
import AccountAvatar, { accountName, AVATAR_TRIGGER_CLASS } from "./AccountAvatar";

/**
 * The top bar's account affordance: an avatar button opening a menu with
 * everything scoped to the person rather than to an organisation — appearance,
 * haptics, account, sign out.
 *
 * Sign out used to be a third bare button in a row beside "Listings" and
 * "Enquiries", which put "who am I" housekeeping on the same axis as "what am I
 * working on", one mis-click apart. An avatar menu splits the two and leaves the
 * bar for the work.
 *
 * ## Account management is a link out, not a view
 *
 * The host portal's equivalent row opens an in-portal security panel. There is
 * no such panel here and there should not be: passkeys and recovery codes are
 * bound to the `musubi.social` RP ID, so every ceremony has to run on musubi's
 * own origin anyway. A row that opened a local screen whose every button then
 * redirected would be a hop that exists only to be got past. `rel="noopener"` on
 * the link because a named target would otherwise hand `window.opener` to the
 * other origin.
 */
const itemClass =
  "font-body flex w-full cursor-pointer items-center rounded-sm px-3 py-2 text-[0.76rem] " +
  "tracking-[0.12em] uppercase outline-none transition-colors duration-(--dur-fast) " +
  "text-text-muted data-[highlighted]:bg-gold/10 data-[highlighted]:text-gold";

/** The same row, plus room for the indicator column the settings rows carry. */
const settingClass = `${itemClass} justify-between gap-4`;

const groupLabelClass =
  "font-body text-text-faint px-3 pt-2 pb-1 text-[0.6rem] tracking-[0.18em] uppercase";

/** "System" first because it is the default, and the only one that keeps
 *  following the vendor's OS after they close the menu. */
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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
      <DropdownMenu.Trigger aria-label="Account menu" class={AVATAR_TRIGGER_CLASS}>
        <AccountAvatar session={props.session} />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content class="border-border bg-surface z-50 min-w-52 rounded-sm border p-1.5 shadow-lg outline-none">
          <div class="flex flex-col gap-0.5 px-3 pt-2 pb-2.5">
            <span class="font-body text-text truncate text-[0.85rem]">{name()}</span>
            <Show when={detail()}>
              {(line) => (
                <span class="font-body text-text-muted truncate text-[0.72rem]">{line()}</span>
              )}
            </Show>
          </div>
          <DropdownMenu.Separator class="bg-border/60 mx-1 my-1 h-px border-0" />

          {/* Appearance and haptics stay open on select: both are things you
              try, look at (or feel), and try again — closing the menu after
              each one would make comparing them a three-click job. */}
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class={groupLabelClass}>Appearance</DropdownMenu.GroupLabel>
            <DropdownMenu.RadioGroup
              value={themePreference()}
              onChange={(next) => setThemePreference(next as ThemePreference)}
            >
              <For each={THEME_OPTIONS}>
                {(option) => (
                  <DropdownMenu.RadioItem
                    value={option.value}
                    closeOnSelect={false}
                    class={settingClass}
                  >
                    {option.label}
                    <DropdownMenu.ItemIndicator class="text-gold shrink-0 text-[0.7rem]">
                      ✓
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                )}
              </For>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Group>

          {/* Offered wherever the portal can deliver feedback — which includes
              iOS, where the API check says no and the switch fallback says yes.
              Feedback a vendor cannot turn off is the failure worth avoiding. */}
          <Show when={hapticsAvailable()}>
            <DropdownMenu.CheckboxItem
              checked={hapticsEnabled()}
              closeOnSelect={false}
              onChange={(checked) => {
                setHapticsEnabled(checked);
                // Fire the confirmation *after* enabling, so turning it on
                // demonstrates itself.
                if (checked) haptic("commit");
              }}
              class={settingClass}
            >
              Haptics
              <span
                aria-hidden="true"
                class={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-(--dur-fast) ${
                  hapticsEnabled() ? "bg-gold" : "bg-border"
                }`}
              >
                <span
                  class={`bg-bg absolute top-0.5 h-3 w-3 rounded-full transition-[left] duration-(--dur-fast) ease-(--ease-out) ${
                    hapticsEnabled() ? "left-3.5" : "left-0.5"
                  }`}
                />
              </span>
            </DropdownMenu.CheckboxItem>
          </Show>

          <DropdownMenu.Separator class="bg-border/60 mx-1 my-1 h-px border-0" />
          {/* A real anchor via Kobalte's polymorphic `as`, rather than an Item
              with a click handler: this is a navigation, and only an `<a>` gets
              a middle-click, a "copy link address" and a status-bar preview of
              where it goes. `noopener` because a named target would otherwise
              hand `window.opener` to the other origin. */}
          <DropdownMenu.Item
            as="a"
            href={`${OSN_ACCOUNT_URL}/settings`}
            target="_blank"
            rel="noopener noreferrer"
            class={itemClass}
          >
            Account &amp; passkeys
            <span aria-hidden="true" class="text-text-faint ml-auto text-[0.7rem]">
              ↗
            </span>
            <span class="sr-only">(opens musubi in a new tab)</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item class={itemClass} onSelect={() => props.onSignOut()}>
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
