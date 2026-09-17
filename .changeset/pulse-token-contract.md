---
"@pulse/web": minor
---

Map `@pulse/web` onto the `@shared/design-tokens` contract, and fix two
contrast failures the conformance test found.

**`--ring` was below the focus-indicator floor in both themes** — 2.38:1 light
and 2.66:1 dark, against 3:1 (WCAG 2.2 SC 1.4.11). A focus ring is the one
component where failing contrast removes the feature outright: a keyboard user
has no other way to tell where they are. Now L=0.58 light (3.82:1 on the worst
ground) and L=0.62 dark (4.39:1), still reading as a ring rather than a border.

**`--destructive-foreground` in dark mode** was near-white on a lightened red
at 2.77:1, against 4.5:1 — the same defect and the same remedy as
`@musubi/social`'s. Now near-black at 6.62:1.

The mapping itself sends `--ui-accent` to the neutral `--primary`, **not** to
`--pulse-accent`. Pulse carries two accents; the contract means "the ground of
a primary button", which here is the near-black. Mapping the coral would
repaint every shared `<Button>` in the app — a redesign wearing the costume of
a refactor. The coral keeps its own names and stays app-level, which is where
it is used from. For the same reason `--ui-accent-soft` takes `--muted`
rather than `--pulse-accent-soft`: it is a tint of whatever the accent is, and
the accent is ink. A test pins both.

Two tokens shadcn's ramp has no name for are added: `--primary-hover` (shadcn
writes the pressed state as `bg-primary/90` at each call site, so a named role
has nothing to point at) and `--subtle` (pulse had no tertiary ink at all —
`--muted-foreground` is its faintest and carries the 4.5:1 body contract).

`--ui-hairline-strong` is mapped but waived: `--input` measures 1.10–1.31:1
against pulse's own grounds. Same class as `@musubi/social`'s and the same
design decision, tracked.
