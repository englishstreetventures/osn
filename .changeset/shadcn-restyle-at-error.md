---
"@shared/ui": patch
---

Take `shadcn/no-restyle` and `shadcn/no-arbitrary-values` to `error`.

Both were at zero across every surface before the severity moved, so this locks
in the migration rather than announcing one. `no-restyle` carries
`allow: ["layout"]` — where a component sits is the caller's business, its
colour, shape, typography and elevation are not — plus a contract letting
`gap-*` through on the nine containers whose children are the caller's, since a
Card or a Modal cannot know how far apart the things put inside it should be.
That is the same configuration `.oxlintrc.restyle.json` was measuring against,
now promoted into the real config; the measuring file is no longer needed.

Both rules were proved to fire on a deliberate violation before their zero was
trusted, as `no-unknown-classes` was: a probe component carrying `bg-red-500`,
`rounded-full` and `text-lg` on a `<Button>` plus `p-[13px]` and
`text-[0.9rem]` on a `<span>` produced five errors and a non-zero exit, and was
then removed.
