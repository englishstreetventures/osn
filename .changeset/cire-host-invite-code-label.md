---
"@cire/host": patch
"@cire/db": patch
"@cire/api": patch
---

**The copied invite message says what the code is.** Line 3 was the bare claim
code, so a guest who has never used the product had nothing telling them what
the string was for. It now reads `Your invitation code: <code>`, in the same
words as the guest site's own field. The label is composed around the code
rather than written into the default prose, so a host who replaces line 1 still
sends a labelled code; the message stays three lines. The organiser-facing
`Family Code` column keeps its name — it is read by the person managing the
list, not by the guest.
