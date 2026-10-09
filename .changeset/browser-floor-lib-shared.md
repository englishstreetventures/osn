---
"@shared/color": patch
"@shared/design-tokens": patch
"@shared/legal": patch
"@shared/rp-auth": patch
"@shared/toast": patch
"@shared/ui": patch
---

Type-check shipped source at the guest invite site's browser floor. Each package
states `lib` ES2022 in its own `tsconfig.json` (with DOM for `@shared/rp-auth`,
`@shared/toast` and `@shared/ui`), and `@shared/color`, `@shared/design-tokens`
and `@shared/legal` extend `base.json` with no ambient types instead of the Node
preset, whose `bun-types` declare built-ins newer than the floor. An ES2023 or
later library method, such as `toSorted`, now fails `check`. The tests of `@shared/color`, `@shared/design-tokens` and `@shared/ui`
move to `tests/tsconfig.json`, which `check` also runs, so the shipped-source
program loads no `@types/node`; `@shared/color` and `@shared/design-tokens` tests
are type-checked for the first time. No runtime change.
