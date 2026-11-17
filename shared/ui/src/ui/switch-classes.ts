/**
 * The switch as drawn: a 20x36 track, its edge the choice edge
 * (`--ui-choice-edge`) on the page fill, the accent fill when on; a 14px
 * thumb in the secondary ink, the on-accent ink when on. Both read
 * `data-checked`, `data-disabled` and `data-readonly` on themselves. Keyboard
 * focus on the hidden input before it draws the house outline, 2px off, as
 * the drawn box and circle do (`DRAWN_FOCUS` in `choice.ts`, spelled out here
 * so this file imports nothing).
 *
 * A file of its own, with no JSX and nothing from Solid's DOM runtime, so the
 * menu's switch row (`dropdown-menu.tsx`) draws this switch and not a second
 * one without loading `Switch`.
 */
export const SWITCH_TRACK_CLASS =
  "base:border-ui-choice-edge base:bg-ui-ground base:data-[checked]:border-ui-accent base:data-[checked]:bg-ui-accent base:inline-flex base:h-5 base:w-9 base:shrink-0 base:cursor-pointer base:items-center base:rounded-full base:border base:p-0.5 base:transition-[color,background-color,border-color] base:peer-focus-visible:outline-2 base:peer-focus-visible:outline-offset-2 base:peer-focus-visible:outline-ui-focus base:data-[disabled]:cursor-not-allowed base:data-[disabled]:opacity-50 base:data-[readonly]:cursor-default base:motion-reduce:transition-none";
export const SWITCH_THUMB_CLASS =
  "base:bg-ui-ink-secondary base:data-[checked]:bg-ui-on-accent base:h-3.5 base:w-3.5 base:rounded-full base:transition-transform base:data-[checked]:translate-x-4 base:motion-reduce:transition-none base:forced-colors:forced-color-adjust-none base:forced-colors:bg-current base:forced-colors:data-[checked]:bg-current";
