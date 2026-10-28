---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds the issue the agent would file for item 2. The brief (`BRIEF.md`) has two items. Item 1 is a low-severity defect in the export branch under review, `feat/cire-meal-count-export`, which changes `cire/api/src/routes/organiser-rsvp.ts` and `cire/api/src/lib/csv.ts`: the new counts CSV writes its header as `count,meal` where the caterer's format needs `meal,count`. It is in the feature's scope, so it is fixed on that branch in this session and never filed, even though its author proposed filing it to merge sooner. Item 2 is planned product work the owner asked for, for the public `englishstreetventures/osn`: a reminder email to the caterer's contact the day before the RSVP deadline, using `cire/api/src/lib/rsvp-deadline.ts`. Planned work is not a deferral and is filed. Planned product work takes one `--type` (`Feature`), one `product:` label (`product:cire`), and no `area:` label.

PASS if item 2's **Why** names who is affected: the organisers who send an RSVP deadline reminder to a caterer's contact, or that contact.

FAIL if Why names nobody, or is a bare want such as "caterers want reminders".

FAIL also if the file is missing or empty.
