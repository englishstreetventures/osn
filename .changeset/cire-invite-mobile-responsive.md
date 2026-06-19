---
"@cire/web": patch
---

Mobile-responsiveness pass over the guest invite (no redesign — visual design and
theme tokens preserved), audited at 320 / 375 / 390 / 414 / 768px:

- **Hero** (`InviteHeader.tsx`): a long custom title/subtitle can no longer
  overflow horizontally on a 320px screen (`max-w-full` + `break-words`), and the
  overlay padding respects the notch via `max(1.5rem, env(safe-area-inset-*))`.
- **Modals** (`AnimatedModal.tsx`): the mobile bottom-sheet uses `max-h-[85dvh]`
  and `pb-[max(2.5rem, env(safe-area-inset-bottom))]` so content and buttons clear
  the home indicator; the desktop centred dialog is unchanged.
- **RSVP** (`RsvpModal.tsx`): the dietary input renders at 16px (`text-base`) on
  mobile (`sm:text-[0.9rem]` above) to stop iOS focus-zoom, and the sticky action
  footer tracks the same safe-area inset.
- **Pinterest** (`PinterestBoard.tsx`): the fixed-pixel-width board embed now sits
  in a centred `overflow-x-auto` box (narrower `data-pin-board-width`) so a wide
  embed scrolls within its own box instead of panning the whole page; the
  always-visible fallback link is unchanged.
- **Event cards** (`EventCard.tsx`): Respond / View Event are `min-h-11` (≥44px tap
  target), full-width on mobile, intrinsic width from `sm:` up.
- **Add-to-calendar** (`AddToCalendar.tsx`): the portalled popover is clamped into
  the viewport so it never spills off the right edge on a narrow device.
- **Global** (`global.css`): `overflow-x: hidden` on `body` as a guard against any
  single wide island panning the page sideways.
