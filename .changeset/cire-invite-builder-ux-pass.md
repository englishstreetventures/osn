---
"@cire/host": minor
---

Invite builder UX + structure pass — reactive unsaved-changes protection, a
persistent composed preview, per-section error placement, and the split of the
1,650-line `InviteBuilder.tsx` into a `components/invite/` directory
(orchestrator + `model.ts` + `fields.tsx` + `previews.tsx` + `ImageField` +
`DesignPicker` + `PreviewPane`; the old import path survives as a re-export).

- **Unsaved changes are visible and guarded.** The form state moved from ~20
  signals + non-reactive snapshots to one `createStore` draft with memoised
  per-half dirty state: the save button disables when clean, the sticky bar
  shows live "Unsaved changes" / "All changes saved", `beforeunload` warns on
  tab close, and the new `lib/unsaved-guard` lets `OrganiserApp.setRoute`
  confirm before in-app navigation discards a dirty draft.
- **Persistent preview pane.** At wide widths a sticky pane composes the whole
  guest page (hero → story → welcome → events → closing) on its tone surfaces
  with a desktop/phone toggle; inline per-section previews remain the narrow
  layout fallback. Hero previews are now crop-aware (saved rectangles render
  with the guest's background-fraction technique) and the phone frame uses the
  hero's phone rectangle.
- **Mixed persistence models are marked.** Instant-apply controls (image
  upload/crop/remove, design selection) carry an "applies immediately" badge;
  image removal is confirm-gated; upload/remove failures surface inside their
  own section card instead of the distant save bar.
- **Navigation + disclosure.** A sticky section jump list mirrors the
  Shown/Hidden badges as dots; the hero display sliders and fine typography
  options fold into disclosures; the hero preview moved above its controls;
  per-section "Reset section" reverts a card's draft fields.
- **Validation + accessibility.** Copy fields enforce the server caps
  client-side (`maxlength` + live counters mirroring `InviteTextBody`);
  Shown/Hidden badges announce via `role="status"`; locked premium designs use
  `aria-disabled` (perceivable, keyboard-reachable, unselectable) instead of
  `disabled`; sliders carry `aria-valuetext`; the builder is a real
  `<form onSubmit>` so Enter saves; tone pickers render as surface swatches;
  field labels drop the micro-caps treatment for a readable size.
