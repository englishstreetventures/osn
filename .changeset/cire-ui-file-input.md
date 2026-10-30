---
"@cire/ui": patch
"@cire/host": patch
---

`@cire/ui` gains `FileInput` (`@cire/ui/file-input`): a native file input whose button is `Button`'s `quiet` pill at `md` and the 34px form-field height, the file name in body ink beside it, the house focus outline on the input and the whole picker at 40% when disabled. The button's classes are `FILE_BUTTON`, beside the component, held to `quiet` and `md` through `button.tsx`'s new `buttonLook`, so a site with no picker can leave the file out of its Tailwind sources. The host's `DESIGN.md` lists it; its four pickers move onto it with the stack's feature pull request.
