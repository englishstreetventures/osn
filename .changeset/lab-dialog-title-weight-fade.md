---
"@tools/lab": patch
---

Two `Dialog` stories in `shared/ui/overlays`: `DialogTitleWeight` sets the title weight token from a control, with an `unmapped` option that shows the 600 fallback, and `DialogFadeOnly` sets both scale tokens to 1, as a card or a sheet. The default `DialogStory` now unsets the title weight and both scale tokens, so it draws the contract's default whatever the lab's stylesheet maps.
