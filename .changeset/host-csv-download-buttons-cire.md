---
"@cire/host": patch
"@cire/ui": patch
"@tools/e2e": patch
---

Every page download in the host portal is now one button: the download icon
and "Download <what> CSV", the events page's outlined 28px pill, from one
component, `CsvExportButton.tsx`. Events, the Households tab, RSVPs and the
gift log fetch their file through it, so each one reads "Exporting <what>…"
and is `aria-disabled` while the file is fetched, keeping the keyboard focus
on it, and reports through a toast; the seating chart takes the same look and
now ignores a second press while its file is fetched.

The Households tab offers the guest list alone; its RSVP download, an
unlabelled icon beside an identical one, is gone, and the RSVP sheet stays on
the RSVPs tab. There the download ends the view bar's first row, where its
words fit, and on a phone ends the search row as the bar's icon button, named
by its hidden words.

`@cire/ui`: the `bar` variant's doc comment lists the controls that draw it.
`@tools/e2e`: the `cire-seating` flow clicks the RSVP download by its new name.
