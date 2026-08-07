import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { RpSession } from "@shared/rp-auth";
import { For, Show } from "solid-js";

import { haptic, hapticsAvailable } from "../lib/haptics";
import {
  hapticsEnabled,
  setHapticsEnabled,
  setThemePreference,
  type ThemePreference,
  themePreference,
} from "../lib/theme";

/**
 * The top bar's account affordance: an avatar button opening a menu with
 * everything scoped to the person rather than to a wedding — appearance,
 * haptics, security, sign out. Those used to sit in a portal-wide nav row next
 * to Weddings, which put "who am I" housekeeping on the same axis as "what am I
 * working on"; an avatar menu splits the two and leaves the bar for the work.
 *
 * The trigger shows the account's avatar when the session carries one, else the
 * first letter of whatever identifies the account best (display name → handle →
 * email). The menu head names the account so a host juggling two OSN accounts
 * can tell which one is signed in before acting on it.
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
 *  following the host's OS after they close the menu. */
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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
  const initial = () => name().charAt(0).toUpperCase();

  // The avatar URL rides in from the OIDC `picture` claim with no validation
  // at any earlier hop, so the sink enforces the scheme: render only an
  // absolute https URL, else fall back to the initial (S-L1, prep-pr review).
  const httpsAvatarUrl = () => {
    const raw = props.session?.avatarUrl;
    if (!raw) return null;
    try {
      return new URL(raw).protocol === "https:" ? raw : null;
    } catch {
      return null;
    }
  };

  return (
    <DropdownMenu placement="bottom-end" gutter={8}>
      <DropdownMenu.Trigger
        aria-label="Account menu"
        class="border-border bg-surface/40 hover:border-gold-dim flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border transition-colors duration-(--dur-fast)"
      >
        <Show
          when={httpsAvatarUrl()}
          fallback={
            <span aria-hidden="true" class="font-display text-gold text-[0.95rem] leading-none">
              {initial()}
            </span>
          }
        >
          {(url) => <img src={url()} alt="" class="h-full w-full rounded-full object-cover" />}
        </Show>
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
              Feedback a host cannot turn off is the failure worth avoiding. */}
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
          <DropdownMenu.Item class={itemClass} onSelect={() => props.onSecurity()}>
            Security &amp; passkeys
          </DropdownMenu.Item>
          <DropdownMenu.Item class={itemClass} onSelect={() => props.onSignOut()}>
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
