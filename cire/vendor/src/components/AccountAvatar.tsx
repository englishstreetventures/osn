import type { RpSession } from "@shared/rp-auth";
import { Show } from "solid-js";

/**
 * The account avatar, and the identity strings that go with it.
 *
 * Its own module because two things render it and they must agree exactly:
 * `ProfileMenu`'s Kobalte trigger, and the placeholder `TopBar` shows while
 * `ProfileMenu`'s chunk is still in flight. If those two drifted by a pixel the
 * swap would be visible, which is the whole thing the placeholder exists to
 * avoid.
 *
 * Nothing here imports Kobalte. That is the point — the trigger's visual
 * identity is a border, a circle and one glyph, none of which need an 86 KB
 * menu library to draw.
 */

/** The trigger's box. Worn by the real trigger and by the placeholder alike. */
export const AVATAR_TRIGGER_CLASS =
  "border-border bg-surface/40 hover:border-gold-dim flex h-9 w-9 shrink-0 items-center " +
  "justify-center overflow-hidden rounded-full border transition-colors duration-(--dur-fast)";

/** Best available name for the account: display name → handle → email. */
export function accountName(session: RpSession | null | undefined): string {
  return session?.displayName ?? session?.handle ?? session?.email ?? "Your account";
}

/**
 * The avatar URL, if it is one we are willing to request.
 *
 * The URL rides in from the OIDC `picture` claim with no validation at any
 * earlier hop, so the sink enforces the scheme: an absolute https URL, or
 * nothing. `new URL` with no base throws on a relative or malformed string,
 * which the catch turns into the fallback.
 */
export function httpsAvatarUrl(session: RpSession | null | undefined): string | null {
  const raw = session?.avatarUrl;
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * What sits inside the circle: the avatar image, else the account's initial.
 *
 * `alt=""` is correct — whatever wraps this carries the accessible name
 * ("Account menu"), so the image itself is decorative and naming it twice would
 * make a screen reader say it twice.
 */
export default function AccountAvatar(props: { session: RpSession | null | undefined }) {
  const initial = () => accountName(props.session).charAt(0).toUpperCase();
  return (
    <Show
      when={httpsAvatarUrl(props.session)}
      fallback={
        <span aria-hidden="true" class="font-display text-gold text-[0.95rem] leading-none">
          {initial()}
        </span>
      }
    >
      {(url) => <img src={url()} alt="" class="h-full w-full rounded-full object-cover" />}
    </Show>
  );
}
