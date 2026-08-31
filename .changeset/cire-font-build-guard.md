---
"@cire/vendor": patch
"@cire/host": patch
"@cire/landing": patch
---

Five findings from a self-hosted-fonts follow-up (xchromo/osn-tracker#128,
#129, #130, #131, #132):

- `bun run build` now fails loudly instead of shipping a fontless site when
  Astro's build-time Google Fonts fetch silently drops every font
  (`scripts/check-astro-fonts.ts`, run after `astro build` in all three
  packages). CI also caches Astro's font-metadata directory
  (`node_modules/.astro`) so most runs never call `fonts.google.com` at all.
- `<Font preload>` on `@cire/host`'s two page shells and `@cire/landing`'s two
  layouts now names `subset: "latin"`, matching `@cire/vendor` — a bare
  `preload` bypasses `unicode-range` and fetches every subset unconditionally.
- `/_astro/*` gets `Cache-Control: public, max-age=31536000, immutable` in
  `@cire/vendor` and `@cire/host`'s `_headers` (content-hashed paths, so a
  year-long cache is safe; `@cire/landing` already had it).
- `Textarea` (`@cire/host` and `@cire/vendor` `components/ui/Field.tsx`) takes
  a `resize` prop, defaulting to the existing `resize-y` behaviour. Set to
  `"none"` at the call sites inside an auto-sized `ModuleShell`/vendor-portal
  frame (`ListingEditor`, `EnquiryThread`, `EventsEditor`, the invite
  builder's `TextAreaField`) — dragging a `resize-y` grip at a fixed width
  was tripping `createAutoSize()`'s reflow guard on every delivery.
  `RegistryView.tsx` has the same bug and is deliberately left unfixed here
  (locked against a separate open PR).
- A stale comment on `ListingEditor.tsx`'s category-checked signal is
  corrected: toggling one category recomputes all 14 rows, not just the
  toggled one — cheap enough that it isn't worth a per-key signal split.
