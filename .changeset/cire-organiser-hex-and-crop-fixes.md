---
"@cire/organiser": patch
---

Fix two invite-builder bugs: the eager hex colour commit and the broken crop
editor.

**ColorPicker** committed 3/4-digit shorthand hex on every keystroke —
`parseColor` accepts `#d4a` as valid shorthand, so an organiser typing
"#d4af37" saw the swatch, trigger and live preview yank to `#DD44AA` after the
third digit. The hex field now only commits a complete 6-digit value while
typing; shorthand still works on blur, where Kobalte's ColorField normalises it
to the full hex before it re-enters the commit path.

**ImageCropModal** regressed in the cropperjs v1→v2 migration: v2's
`initial-coverage` covers the whole canvas (not the displayed image, unlike
v1's `autoCropArea: 1`), and v2 dropped v1's built-in containment of the crop
box within the image. On any letterboxed photo the box opened overflowing onto
the background and could be dragged there freely; saving clamped the
out-of-image area away — an untouched box degenerated to the full-frame rect,
which renders as "no crop", so saves appeared to do nothing. The modal now fits
the opening selection to the displayed image (honouring the active aspect
preset), vetoes out-of-image drags/resizes via the selection's cancellable
`change` event, refits within the image on preset switches, and restores saved
crops to their exact stored rectangle. Geometry helper (`fitAspectBox`) is unit
tested; the interactive behaviour was verified against real cropperjs v2 in
headless Chromium.
