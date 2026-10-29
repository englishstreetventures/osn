---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of the guest site's consent framework. The branch gates embeds from Pinterest and from Google (the Maps Embed API). Both vendors already have rows in `wiki/compliance/subprocessors.md` on the base branch, outside the diff. Both rows carry `TODO` in the data-processing-agreement cell and `TODO` in the transfer-basis cell, and the Pinterest row notes that the `embeds` category is opt-out, so the embed loads on a first visit for a guest who has not decided. A review claiming the vendors are absent from the register has not opened the file.

PASS if the compliance section treats the embeds the branch gates (Pinterest, Google Maps) as processors whose entry in `wiki/compliance/subprocessors.md` has to be in order, with agreement and transfer-basis status settled, before merge.

FAIL if the compliance section never reaches the subprocessor register, or asserts the vendors are missing from it.

FAIL also if the file is missing or empty.
