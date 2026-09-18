import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

/**
 * A picture of a person, with initials behind it.
 *
 * `ring` is here because an overlapping stack is the one arrangement that needs
 * the avatar's own edge to change: without a band of the page's own colour
 * between them, two circles that overlap read as one shape. The ring is drawn
 * in the surface colour rather than a border colour for that reason — it is
 * standing in for the gap, not outlining the avatar.
 */
type AvatarProps = ComponentProps<"span"> & {
  /** `surface` draws a band of the page's own colour around the circle, for an overlapping stack. */
  ring?: "none" | "surface";
};

const Avatar: Component<AvatarProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "ring"]);
  return (
    <span
      class={clsx(
        "base:relative base:flex base:shrink-0 base:overflow-hidden base:rounded-ui-pill",
        local.ring === "surface" && "base:border-2 base:border-ui-surface",
        local.class,
      )}
      {...others}
    />
  );
};

const AvatarImage: Component<ComponentProps<"img">> = (props) => {
  const [local, others] = splitProps(props, ["class", "alt"]);
  return (
    <img
      class={clsx("base:aspect-square base:h-full base:w-full base:object-cover", local.class)}
      alt={local.alt ?? ""}
      {...others}
    />
  );
};

/**
 * The initials standing in for a face.
 *
 * `size` exists because the fallback is the only part of an avatar that does
 * not scale with it. The circle is sized by the caller — `size-8` in a row,
 * `size-16` on a profile header — and the image inside it is `h-full w-full`,
 * so it follows for free; initials are type, and type does not. Left at one
 * size, the same two letters that fill an 8px circle sit marooned in the middle
 * of a 64px one.
 *
 * Two steps, because two is what the products actually distinguish: `sm` for
 * the avatar in a row or a menu, which is every one of them but one, and `lg`
 * for the one at the top of a profile that is the subject of the page. There is
 * no middle step until a design asks for one — an open scale here would be
 * three names guessing at sizes no call site has needed.
 */
type AvatarFallbackProps = ComponentProps<"span"> & {
  /** Matches the initials to the circle the caller sized. Defaults to `sm`. */
  size?: "sm" | "lg";
};

const avatarFallbackText = {
  sm: "base:text-ui-xs",
  lg: "base:text-ui-xl",
} as const;

const AvatarFallback: Component<AvatarFallbackProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "size"]);
  return (
    <span
      class={clsx(
        "base:bg-ui-surface-sunk base:text-ui-ink-secondary base:flex base:h-full base:w-full base:items-center base:justify-center base:font-semibold",
        avatarFallbackText[local.size ?? "sm"],
        local.class,
      )}
      {...others}
    />
  );
};

export { Avatar, AvatarImage, AvatarFallback };
export type { AvatarProps, AvatarFallbackProps };
