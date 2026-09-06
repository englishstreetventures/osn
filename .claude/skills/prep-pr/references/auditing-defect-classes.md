# Auditing a defect class

Reference for `prep-pr` Step 7.

### Auditing a defect class

When a finding turns out to be an instance of a class — "this query does X, and
X is wrong" — the audit that follows has to enumerate the **shapes** X can take,
not just re-grep the form you happened to find first. Ask what other syntax has
the same property, and check each: a helper call, a raw `sql` template, a
different builder method, an implicit form.

This is not theoretical. An audit for one D1 bind-cap bug grepped `inArray` and
declared four siblings. It missed the two worst instances in the codebase —
both multi-row `INSERT`s, which bind one parameter *per column per row* and so
break an order of magnitude sooner than the id-list form that was searched for.
One of them was a GDPR erasure path that could never complete. See
`[[wiki/systems/d1-limits]]`.

Report the shapes you enumerated and the verdict on each, so the next reader
knows what was searched for and what was not.
