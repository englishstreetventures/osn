---
"@cire/organiser": minor
---

Organiser dashboard UX + structure pass — make it intuitive, well-explained, and
fun to use, without regressing the live previews or status indicators.

- **Getting-started checklist** (new `GettingStarted.tsx`): a four-step progress
  guide — Add events → Add guests → Customise invite → Share codes — whose
  done-state is derived from the wedding's real data (event/household counts, the
  invite emptiness predicates, codes-sent count). It shows a progress rail + the
  single next action for a first-timer, collapses to a calm "all set" summary
  once complete, and each step jumps straight to the matching tab.
- **Clearer wedding context header**: the selected wedding's name is now the page
  `<h1>` with its slug eyebrow and an Owner/Co-host badge (was a small italic
  line). Preview stays top-right.
- **Workflow-ordered tabs with icons**: reordered to Events → Guests → Invite →
  Codes → Hosts (was Guests-first), each with a small leading glyph and a
  hover-tooltip describing it. Hash-routing is preserved and now also reacts to
  external `hashchange` (the checklist jumps + browser back/forward).
- **Per-tab intros + empty states** via a new shared `SectionIntro` (eyebrow +
  serif heading + description + optional actions slot), adopted by Guests,
  Events, Codes, and Hosts so every panel reads as one family. Guests and Events
  gained guided empty states; the Codes copy now explains what a guest code is;
  the Hosts copy explains owner vs co-host.
- **Spreadsheet Import is now collapsible** so it leads a new wedding but doesn't
  crowd an established one. The 3-step CSV format guide is unchanged.

No API calls or flows changed: the theme/hero WYSIWYG previews, per-event image
upload, RSVP CSV download, host-by-handle autocomplete, re-mint codes, and the
security/passkey panel all behave exactly as before.
