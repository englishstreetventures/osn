---
"@cire/organiser": minor
---

Overhaul the CSV import explainer in `ImportPanel.tsx` so a non-technical couple
can fill the Events and Guests sheets without guessing.

**Step reorder** — the three-step guide now follows the natural flow:

- **Step 1 — New here?** Download a starter template (the download prompt that
  used to be buried at the bottom of step 3).
- **Step 2 — Fill in your details** — the Events + Guests guidance, each with a
  labelled mandatory-vs-optional key and a "Good to know!" panel of format rules.
- **Step 3 — Upload & preview** — upload events first, preview the diff, apply.

(Product-owner note: "the third part where it says 'New here?' is strange for
step 3, should be step 1 if anything.")

**New "Good to know!" guidance.** Each sheet gets a gold-accented aside with:

- a **Key** legend tying the gold/muted column chips to "mandatory" vs
  "optional" fields;
- (Events) **Timestamps** in `YYYY-MM-DDTHH:MM:+GMT` for Start/End, an **IANA**
  Timezone (the word _IANA_ links to the tz-database list, new tab,
  `rel="noreferrer"`), full http(s) Pinterest/Maps **URLs**, and the
  `DisplayName:#RGB` dress-code **palette** format (swatches separated by `|`);
- (Guests) one row per guest, group a household by repeating the same Family
  Name, and mark an event column with `yes`/`true`/`1`/`x` (blank ⇒ not invited).

The required/optional key and every format rule mirror the cire-api parser
(`cire/api/src/services/spreadsheet.ts`) — `REQUIRED_EVENT_COLUMNS` /
`REQUIRED_GUEST_COLUMNS`, the truthy-cell set, the `|`-delimited palette. The
download-template buttons and the native `<details>`/`<summary>` (keyboard +
screen-reader accessible, no JS) are unchanged.
