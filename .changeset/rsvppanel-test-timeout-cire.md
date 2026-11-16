---
"@cire/invites": patch
---

Two `RsvpPanel` unit tests find each consent box, and the Save button, once and reuse them, rather than repeating a lookup by accessible name after every step. Each such lookup reads the name of every checkbox in the sheet, 34 of them for a household with a plus-one, so the refusal test spent most of its time looking up the same two boxes twelve times. Both tests keep every assertion they made; after the failed send, the refusal test looks both boxes up once more and requires the nodes it held. No runtime change.
