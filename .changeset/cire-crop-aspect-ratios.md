---
"@cire/api": minor
"@cire/organiser": minor
"@cire/web": minor
---

Fix the cropped-invite-image **distortion** bug and add **aspect-ratio presets**
to the crop editor.

**The distortion bug.** The guest-side CSS render scaled the cropped region with
a TWO-value `background-size` (`Wx% Wy%`), which scales width and height
INDEPENDENTLY — so whenever the crop rectangle's aspect ratio differed from the
display box's, the image came out stretched/squashed. The render now uses a
SINGLE-value `background-size` (`W%`, height auto), which scales the image
UNIFORMLY (one factor on both axes, preserving its proportions), and the display
box adopts the crop's **true pixel aspect** so the uniformly-scaled region fills
it exactly — no stretch, no letterbox. The hero stays a full-bleed `cover` focal
point (uniform scale centred on the crop region), so it too never distorts.

**Dimension capture — no DB migration.** Computing the crop's true pixel aspect
needs the source image's natural dimensions, captured in the browser at crop time
and stored in the crop JSON as `natW`/`natH`. These are **optional** and the crop
columns are plain JSON `TEXT`, so the JSON shape was simply widened — **no schema
migration**. A legacy `{x,y,w,h}` crop (saved before this field existed) still
decodes and renders; it falls back to the slot's default display aspect (its
prior fixed shape), now minus the stretch.

**Aspect-ratio presets.** The crop editor exposes a small segmented control —
Original / 16:9 / 3:2 / 4:3 / 1:1 / 4:5 / Free — wired to Cropper.js `aspectRatio`.
`Original` resolves to the slot's sensible default (hero 16:9, story 3:2, event
4:3); `Free` unlocks the box. The chosen shape re-opens when the editor is
re-launched (best-effort, from the captured dims). The guest containers (Our
Story, event cards) honour whatever aspect the organiser picked via
`aspect-ratio` CSS, with no stretch and no empty bars.

- `@cire/api`: `ImageCrop` gains optional `natW`/`natH`; `isValidCrop` /
  `ImageCropBody` / `decodeCrop` accept + validate them when present (reject a
  present-but-bad dim) and tolerate their absence (legacy-tolerant). New
  `cropAspect` helper. The dims round-trip through save + the public invite /
  claim payloads. No migration.
- `@cire/web`: `image-crop.ts` switches to the uniform single-value render +
  `cropAspectRatio`; hero/Our Story/`EventCard` give the crop box the crop's true
  pixel aspect (falling back to the slot default on a legacy crop).
- `@cire/organiser`: the crop modal gains the aspect-preset segmented control and
  captures `natW`/`natH` on save; the editor + thumbnails mirror the uniform
  guest render and per-slot default shapes.
