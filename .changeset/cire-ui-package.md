---
"@cire/ui": patch
"@cire/host": patch
"@cire/vendor": patch
---

`@cire/ui` replaces the component sets `cire/host` and `cire/vendor` each kept a copy of

Both portals deleted their `src/components/ui/` directory. Eight of the nine
components were never cire-specific, only cire-*located*, and are `@shared/ui`'s
now: `Field`, `Fieldset`, `Input`, `Textarea`, `Select`, `Notice`, `EmptyState`,
`Chip`, `Stat`, `Meter`, `Table` and `SafeProps`. Three stayed, because the
house style is genuinely the product's — `Button` (four gold variants,
uppercase, tracked), `Card` and `Loading` — plus `UsernameInput`, whose raw-prop
API a combobox needs and whose controlled `@shared/ui` twin cannot provide.

**`@cire/ui` writes `ui-*` like any library.** That is what makes it
renderable in all four cire apps rather than the two that happen to declare
`--gold`: `cire/host`'s Button used `duration-(--dur-fast)`, and `--dur-fast`
exists in neither `cire/invites` nor `cire/landing`. Transitions here are plain
Tailwind durations now, so they no longer follow `--motion-scale` — a fixtures
-page affordance nothing in any app writes, not a user-facing one.

103 import sites across 35 files moved. Four props were renamed with them, all
from a domain word to a contract role: `Notice`'s `error` tone is `danger`,
`Meter`'s `gold` is `accent`, and `Chip`'s `live`/`active`/`quoted` are
`success`/`pending`/`accent`.

The 840 lines of component tests the two portals duplicated moved with the
components rather than being deleted — 14 to `@cire/ui`'s new suite, the rest
into `@shared/ui`'s unit tier, which goes from 224 tests to 261. They were written
class-agnostic, so they ported almost verbatim.

`@cire/ui/package.json` deliberately has no `version` field, so it stays an
ignored package alongside its `@cire/*` siblings.
