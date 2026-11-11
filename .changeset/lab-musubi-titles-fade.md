---
"@tools/lab": patch
---

The lab imports Musubi's stylesheet, so its stories now draw shared titles at 14px and 500 and overlays with no scale. Stories that show the contract's default keep it: `BadgeWeights`' unmapped column lends `--ui-weight-title: initial`, `DialogStory` also lends `--ui-text-md: initial`, and `cireStyle()` lends `initial` for the title weight and both scale tokens, which cire leaves unmapped, so cire subtrees draw cire's 600 title and 96% pop. The `MenuItems` and type-scale comments say what the lab draws. `tests/cire-mapping.test.ts` fails when Musubi maps a `--ui-*` token that `cireStyle()` neither maps nor lends `initial`, so a cire column never draws Musubi's value.
