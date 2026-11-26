import type { OrgSummary } from "@osn/client";
import { clsx } from "@shared/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { createSignal, Show } from "solid-js";

import { profileInitials, safeAvatarUrl, type AvatarSubject } from "../lib/utils";

/**
 * Musubi's two avatars (DESIGN.md §Avatars): a person's is a circle, an
 * organisation's a square with 8px corners, so the two never read as one
 * kind. Both draw the picture when there is one and it loads, and the
 * initials otherwise — one or the other, never both side by side — and both
 * take their initials from `profileInitials`, the one rule.
 *
 * `class` sizes the avatar (`size-9`); nothing else.
 */
interface AvatarProps {
  class: string;
  /** The initials' step: `lg` for the one avatar that heads a page (Settings' profile card). */
  size?: "sm" | "lg";
  /** Off where the avatar is in the first viewport (`/authorize`, an organisation's own page). */
  lazy?: boolean;
  /**
   * Beside the name it stands for, so a screen reader would hear the name
   * twice: the picture says nothing and the whole avatar is hidden.
   */
  decorative?: boolean;
}

/** The picture, or the initials when there is none or it does not load. */
function Face(props: {
  url: string | null | undefined;
  alt: string;
  initials: string;
  size?: "sm" | "lg";
  lazy?: boolean;
  decorative?: boolean;
}) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const url = () => {
    const safe = safeAvatarUrl(props.url);
    return safe && safe !== failed() ? safe : null;
  };
  return (
    <Show
      when={url()}
      fallback={<AvatarFallback size={props.size}>{props.initials}</AvatarFallback>}
    >
      {(src) => (
        <AvatarImage
          src={src()}
          alt={props.decorative ? "" : props.alt}
          referrerpolicy="no-referrer"
          loading={props.lazy === false ? undefined : "lazy"}
          onError={() => setFailed(src())}
        />
      )}
    </Show>
  );
}

/** A person: `@shared/ui`'s round `Avatar`. */
export function ProfileAvatar(
  props: AvatarProps & {
    profile: (AvatarSubject & { avatarUrl?: string | null }) | null | undefined;
  },
) {
  return (
    <Avatar class={props.class} aria-hidden={props.decorative ? "true" : undefined}>
      <Face
        url={props.profile?.avatarUrl}
        alt={props.profile?.handle ?? ""}
        initials={profileInitials(props.profile ?? null)}
        size={props.size}
        lazy={props.lazy}
        decorative={props.decorative}
      />
    </Avatar>
  );
}

/**
 * An organisation. The square frame is drawn here: `@shared/ui`'s `Avatar`
 * draws circles only and owns its shape, so the picture and the initials are
 * the shared parts and the frame around them is this one.
 */
export function OrgAvatar(
  props: AvatarProps & { org: Pick<OrgSummary, "name" | "handle" | "avatarUrl"> },
) {
  return (
    <span
      class={clsx("relative flex shrink-0 overflow-hidden rounded-md", props.class)}
      aria-hidden={props.decorative ? "true" : undefined}
      data-org-avatar=""
    >
      <Face
        url={props.org.avatarUrl}
        alt={props.org.name}
        initials={profileInitials({ displayName: props.org.name, handle: props.org.handle })}
        size={props.size}
        lazy={props.lazy}
        decorative={props.decorative}
      />
    </span>
  );
}
