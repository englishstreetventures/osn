---
"@cire/host": patch
---

Stop `ModuleSidebar.story.tsx` re-theming the whole component lab.

It imported `../styles/global.css` for the portal's shapes and spacing. That
stylesheet declares a global `:root` mapping the `--ui-*` contract onto cire's
ramp, and the lab builds its sidebar by importing **every** story module — so
the block landed on the page whatever story was open, and being loaded after the
lab's own stylesheet, it won.

The effect: every `@shared/ui` component in every lab story rendered in cire's
light palette, and `--ui-ink` did not follow the light·dark toggle at all,
because cire's dark ramp keys off `data-theme` rather than the `.dark` class the
lab sets. The story's comment already noted it "re-themes the chrome around the
story"; the reach is the whole lab, permanently.

The import is removed and the rule stated in the file: a story must not import a
stylesheet that declares a global `:root`. What this bench gives up is the
portal's shapes and spacing; what it exists for — layout, placement, timing and
interaction — is unaffected.
