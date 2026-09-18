---
"@musubi/social": patch
"@musubi/landing": patch
"@osn/auth-ui": patch
"@shared/ui": patch
---

Final `@shadcn/lint` pass over the musubi surfaces: `no-restyle` and
`no-arbitrary-values` both reach zero there.

`ResponsiveDialogContent` is now `<DialogContent presentation="sheet">` rather
than a hand-spelled anchor, radius and safe-area inset. Collapsing it onto the
shared variant made the plugin recognise it as a forwarding wrapper and start
tracking its own call sites, which surfaced two more: `p-0` on
`<ResponsiveDialogContent>` in `AuthDialogs`, a no-op on desktop that below `md`
was cancelling the sheet's `env(safe-area-inset-bottom)` padding.

**Two gaps in `@shared/ui` that the migration found by hitting them.** Both were
first met by dropping the call-site class, and both turned out to be real
regressions rather than surplus styling:

- `AvatarFallback` takes a `size`. The circle is sized by the caller and the
  image inside it is `h-full w-full`, so it follows for free — initials are
  type, and type does not. Left at one size, the 64px avatar on musubi's
  settings page rendered its initials at 12px. Two steps, `sm` and `lg`,
  because two is what the call sites actually distinguish.
- `Button` takes a `ghostDanger`. Four quiet destructive actions in list rows
  had been carrying `variant="ghost"` plus a `text-destructive`; folding them
  into `destructive` made them filled red at rest, which reads as an error
  state down a column of rows. `cire/ui`'s own `bareDanger` documents having
  already made and reverted this exact mistake.

`@musubi/landing` gains `--tracking-eyebrow` and `--leading-display` in its own
theme block. The eyebrow letter-spacing was written out at six sites and only
the one `.tsx` is linted, so all six moved or the token would have prevented no
drift. Verified against the built CSS, not assumed: the emitted rules carry the
same computed values, and renaming the utility makes `no-unknown-classes` fire.
