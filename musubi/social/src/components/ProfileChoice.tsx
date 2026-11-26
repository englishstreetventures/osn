import type { PublicProfile } from "@osn/client";
import { clsx } from "@shared/ui/lib/utils";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { For, type JSX, Show, splitProps } from "solid-js";

import { ProfileAvatar } from "./Avatars";

/** What a profile row draws. */
type ProfileFace = Pick<PublicProfile, "id" | "handle" | "displayName" | "avatarUrl">;

/**
 * A profile as a row names it: the avatar, the display name (or the handle
 * when there is none) at the title step and 500, and the handle under it in
 * the secondary ink. The avatar is hidden from a screen reader, which hears
 * the name and handle beside it.
 */
export function ProfileIdentity(props: { profile: ProfileFace }) {
  return (
    <span class="flex min-w-0 items-start gap-3">
      <ProfileAvatar profile={props.profile} class="size-9" lazy={false} decorative />
      <span class="flex min-w-0 flex-col">
        <span class="text-foreground text-title truncate font-medium">
          {props.profile.displayName || `@${props.profile.handle}`}
        </span>
        <Show when={props.profile.displayName}>
          <span class="text-muted-foreground text-meta truncate">@{props.profile.handle}</span>
        </Show>
      </span>
    </span>
  );
}

/**
 * The bordered row a profile sits in on `/authorize` (DESIGN.md §Choices): a
 * hairline on the 8px corner, padded 12px by 10px. `ProfileChoice` draws each
 * of its rows in it, and the account screen's one profile and consent's chosen
 * profile sit in it too, so the three cannot drift apart. `class` adds the
 * row's layout and its state; the frame itself is this part's.
 */
export function ProfileRow(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={clsx("rounded-lg border px-3 py-2.5", local.class)} {...others} />;
}

/**
 * Choosing one profile of several (DESIGN.md §Choices): `@shared/ui`'s
 * `RadioGroup`, each choice a radio in a bordered row whose edge turns ink
 * when it is the one chosen. Arrow keys move and choose, so the screen that
 * holds it commits with a button of its own, never on change.
 *
 * The row's frame is drawn here, around the shared radio, which owns its own
 * look: the radio's label reaches over the whole frame (`after:inset-0`), so a
 * press anywhere in the row chooses it, and the frame is the containing block
 * of the radio's visually hidden input. The edge follows the value this part
 * is given, not `:has(:checked)`, which the oldest browsers Musubi serves lack.
 */
export function ProfileChoice(props: {
  profiles: readonly ProfileFace[];
  /** The chosen profile's id, or `""` while none is chosen. */
  value: string;
  onChange: (id: string) => void;
  /** What the group is: its name for a screen reader. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <RadioGroup
      value={props.value}
      onChange={props.onChange}
      orientation="vertical"
      size="sm"
      disabled={props.disabled}
      aria-label={props.label}
      class="items-stretch"
    >
      <For each={props.profiles}>
        {(profile) => (
          <ProfileRow
            class={clsx(
              "transition-ui-colors relative",
              !props.disabled && "hover:bg-muted active:bg-muted",
              profile.id === props.value && "border-foreground",
            )}
            data-profile-choice=""
          >
            <RadioGroupItem
              value={profile.id}
              class="w-full after:absolute after:inset-0"
              label={<ProfileIdentity profile={profile} />}
            />
          </ProfileRow>
        )}
      </For>
    </RadioGroup>
  );
}
