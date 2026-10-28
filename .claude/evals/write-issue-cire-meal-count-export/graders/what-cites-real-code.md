---
type: llm
weight: 1
focus: { source: file, path: ISSUE-REPORT.md }
---

The file holds an issue the agent would file. The brief (`BRIEF.md`) is planned product work for the Cire organiser's meal-choice export, for the public repository `englishstreetventures/osn`; it is not a security, performance or compliance finding. Organisers copy meal choices and dietary notes out of free text by hand, which takes most of an evening and can send the caterer a wrong count. The owner wants one CSV from the guest list with counts per meal option and per named restriction, beside the existing guest CSV. The export lives in `cire/api/src/routes/organiser-rsvp.ts`, which exists at this commit. The brief writes the role as `owner/editor`. Planned product work takes one `--type` (`Feature`, since it is new capability), one `product:` label (`product:cire`), and no `area:` label.

PASS if the **What** cites a real file in the repository, such as `cire/api/src/routes/organiser-rsvp.ts`, and no path that is not in the checkout.

FAIL if no file is cited, or a cited path does not exist.

FAIL also if the file is missing or empty.
