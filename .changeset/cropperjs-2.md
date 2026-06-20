---
"@cire/organiser": patch
---

Migrate the image crop editor from **Cropper.js v1 → v2**.

Cropper.js v2 is a ground-up rewrite. v1 was a single imperative class
(`new Cropper(img, options)` exposing `getData` / `setData` /
`getImageData` / `setAspectRatio` / `getCroppedCanvas` / a `ready` event /
`destroy`); v2 ships a set of native **Web Components**
(`<cropper-canvas>`, `<cropper-image>`, `<cropper-selection>`,
`<cropper-handle>`, `<cropper-shade>`, `<cropper-grid>`,
`<cropper-crosshair>`) driven by a thin `Cropper` wrapper that hides the
source `<img>` and injects a `<cropper-canvas>` template beside it.

What changed in `ImageCropModal.tsx`:

- **No more `cropper.css`.** v2 styles each component inside its own Shadow
  DOM, so the `import "cropperjs/dist/cropper.css"` line is removed (the file
  no longer exists in the package — it was a hard build/import failure).
- **Construction.** Still `new Cropper(imgEl, { template })`, but with an
  explicit template wiring the canvas, image, shade, selection and resize
  handles (mirroring v1's `viewMode`/`autoCropArea: 1`/`dragMode: "move"`
  feel). The live elements are read back via `getCropperImage()` /
  `getCropperSelection()` / `getCropperCanvas()`.
- **`ready` event → `cropperImage.$ready(cb)`** — the promise/callback that
  fires once the image has loaded; used to seed the saved box.
- **`setData` (seed saved crop) → `selection.$change(x, y, w, h)`** in
  canvas-pixel coordinates, projected from the stored 0..1 source fractions
  through the displayed `<cropper-image>` bounding box.
- **`setAspectRatio(r)` → `selection.aspectRatio = r`** (`NaN` = free /
  unlocked) plus a `$change` + `$render` to re-snap the box.
- **`getData(true)` + `getImageData()` (extract crop) → live geometry.** The
  final crop is derived from the `<cropper-selection>` bounding box over the
  `<cropper-image>` bounding box — those ratios are resolution-independent and
  equal the same 0..1 source fractions v1 reported — and
  `cropperImage.$image.naturalWidth/Height` supply `natW`/`natH`.
- **`destroy()`** is unchanged in spirit (removes the canvas, restores the
  `<img>`); still called from `onCleanup`.

**Preserved, unchanged:** the component's external props/contract; the aspect
presets (Original / 16:9 / 3:2 / 4:3 / 1:1 / 4:5 / Free); the no-stretch
uniform-scaling render (the crop JSON still carries `natW`/`natH` so
`image-crop.ts` renders the true pixel aspect); the crop JSON output shape; and
legacy `{x,y,w,h}` (dims-absent) crop tolerance on re-open.

The actual crop interaction cannot be exercised headlessly (the web components
need a real browser layout engine), so the drag/zoom/aspect UX wants a human
eyeball before relying on it in production.
