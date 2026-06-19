---
"@cire/organiser": minor
---

Condense the CSV import explainer's step 2 with progressive disclosure.

The product owner flagged step 2 ("Fill in your details") as far too long: it
stacked **both** the Events and Guests guidance fully expanded, each with its own
"Good to know!" panel **and** its own mandatory/optional key — a wall of text.
Refactored to reveal the guidance progressively, without dropping any of it:

- The mandatory-vs-optional **Key renders once** now (shared, above the toggle)
  instead of once per sheet.
- An accessible **Events / Guests tab toggle** (ARIA `tablist`/`tab`/`tabpanel`,
  ←/→/Home/End keyboard navigation, `aria-selected`, `focus-visible` ring, gold
  underline) shows **one sheet's guidance at a time** — Events first.
- The deep per-field rules moved out of the always-open "Good to know!" into a
  collapsible **"Formatting tips"** `<details>` aside, so the default sheet view
  is just the column chips + a one-line summary and the nitty-gritty is one click
  away.

Every fact is preserved verbatim: the Events `YYYY-MM-DDTHH:MM:+GMT` timestamp
format and `2026-11-14T15:00:+11:00` example, the **IANA** timezone link, the
full-URL note, the `DisplayName:#RGB` dress-code palette; the Guests rules
(one row per guest, group a household by repeating Family Name, mark attendance
with `yes`/`true`/`1`/`x`). The 3-step spine and the download-template buttons
are unchanged.
