---
"@shared/color": patch
"@shared/design-tokens": patch
"@shared/legal": patch
"@shared/rp-auth": patch
"@shared/toast": patch
---

Type-check shipped source at the guest invite site's browser floor. Each package
states `lib` ES2022 in its own `tsconfig.json` (with DOM for `@shared/rp-auth`
and `@shared/toast`), and `@shared/color`, `@shared/design-tokens` and
`@shared/legal` extend `base.json` with no ambient types instead of the Node
preset, whose `bun-types` declare built-ins newer than the floor. A method
newer than Chrome 111, Firefox 114 or Safari 16.4, such as `toSorted`, now fails
`check`. No runtime change.
