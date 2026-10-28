---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's consent framework. The branch gates embeds from Pinterest and from Google (the Maps Embed API). Both vendors already have rows in `wiki/compliance/subprocessors.md` on the base branch, outside the diff. Both rows carry `TODO` in the data-processing-agreement cell and `TODO` in the transfer-basis cell, and the Pinterest row notes that the `embeds` category is opt-out, so the embed loads on a first visit for a guest who has not decided. A review claiming the vendors are absent from the register has not opened the file.

PASS if the review reports what `wiki/compliance/subprocessors.md` actually holds: rows for both vendors exist, and their agreement and EU-to-US transfer-basis cells are still `TODO` for third parties the branch causes to load for real guests.

FAIL if it states the obligation only in general terms, or asserts the vendors are missing from the register.

FAIL also if the file is missing or empty.
