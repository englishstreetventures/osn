import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { RpSession } from "@shared/rp-auth";
import { Show } from "solid-js";

/**
 * The masthead's account affordance: an avatar button opening a menu with the
 * account-scoped actions (security, sign out). Those used to sit in the
 * top-level view nav next to Weddings, which put "who am I" housekeeping on the
 * same axis as "what am I working on" — the conventional avatar-menu splits the
 * two, and frees the nav for wedding-scoped sections only.
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
