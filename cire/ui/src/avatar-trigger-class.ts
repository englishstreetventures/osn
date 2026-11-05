/**
 * The round button an account menu opens from: 36px, on the portals' pill
 * ground (`--pill-ground`, the surface at 30%, which `Button`'s pills sit on)
 * and `Button`'s own focus ring; the `initial` avatar inside it, sized
 * `size-full`, draws the hairline circle and the edge that turns under the
 * pointer.
 */
export const avatarTriggerClass =
  "group/avatar-trigger base:flex base:size-9 base:shrink-0 base:items-center base:justify-center base:rounded-full " +
  "base:bg-[color:var(--pill-ground,transparent)] " +
  "base:focus-visible:outline-2 base:focus-visible:outline-offset-2 base:focus-visible:outline-ui-focus";
