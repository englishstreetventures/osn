---
"@cire/invites": patch
"@cire/landing": patch
---

Rewrite the guest legal pages so they describe the product that exists.

`cire/invites`'s privacy notice and terms were written for one wedding run by two
people: they named that couple, gave a personal email as the privacy contact, and
claimed the Privacy Act's personal/family/household exemption. Every guest of
every other wedding has been reading them since. The household exemption covers a
couple running their own event; it has never covered the platform underneath them.

Both pages are now tenant-neutral and describe the split the code actually
implements — hosts decide what to ask and what to do with the answers, we hold the
data for them, and we alone decide how long guest data survives the wedding, how
the site is secured and what telemetry it emits. The last of those is a controller
decision, so the notice says so rather than claiming a pure-processor role that
`RETENTION_AFTER_FINAL_EVENT_MS` contradicts.

Also: a lawful basis per purpose; the dietary field cited under both APP 3.3 and
GDPR Art. 9(2)(a); a statement that guest data is stored in Australia, which
replaces `cire/landing`'s claim that data may go "outside Australia" — the
direction was backwards; and the three "Note for the site owner" blocks are gone
from the public page, engineering file paths and all.

`cire/landing`'s terms now state governing law at country level rather than naming
a state.
