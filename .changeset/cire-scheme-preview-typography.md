---
"@cire/organiser": patch
"@cire/theme": patch
---

Fix: the host dashboard's live previews now reflect the typography settings.

The invite builder's "Look" card holds the five typography options (heading
size / weight / style, body weight / style) and, directly above them, the
colour-scheme **Live preview**. That preview already received the shared token
map — typography variables included — but its sample heading pinned
`font-light italic` at a literal `1.5rem` in Tailwind classes, so it rendered
identically whatever the organiser picked, an inch below the controls. It now
follows `--invite-heading-scale` / `-weight` / `-style` with the guest packs'
literals as fallbacks (`300` / `normal` / ×1), exactly as `HeroSample` and
`SectionSample` do, so a "Default" scheme still renders unchanged.

The body pair moved up a level at the same time. `--invite-body-weight` /
`-style` were declared on the one muted body line in each section sample, so a
"Body weight: Bold" pick moved that single span and left the eyebrow and the
mini event card behind. They now ride the section wrapper — beside the body
face, and inheriting to every line under it — which is how `global.css` applies
them to the guest invite's `<body>`. Headings keep pinning their own weight and
style, so an italic body still never drags them along. The pair is written as
Tailwind arbitrary properties, matching the guest packs' existing
`[font-weight:var(--invite-heading-weight,300)]` idiom.

No wire, schema or storage change: the same closed enum keys resolve through
the same `typographyVars` map in `@cire/theme`.

Also closes the drift underneath it. `@cire/theme` has always been the single
source of truth for what a SET option resolves to, but the UN-set state — the
pack's base look, written as the `var()` fallback — was a literal repeated at
every call site, ~30 references with nothing checking they agreed. A pack that
changed its base heading weight would have left every organiser preview quietly
misrepresenting "Default": this same bug, one level down.

`TYPOGRAPHY_FALLBACKS`, `typographyVar()` and `headingSizeCss()` now name those
values once. The organiser's preview samples call them and hold no literal at
all. The guest packs cannot — their declarations are Tailwind arbitrary-property
classes, and Tailwind generates CSS by scanning source text, so an interpolated
class name emits no rule — so those stay literal and are held to the canonical
values by a lockstep test that scans both packages, failing on a value that
disagrees or a reference that omits its fallback.
