---
"@cire/api": patch
---

An import, editor save or revert checks the wedding's guest cap inside every
D1 batch that adds guests: the batch's last guest insert is written only while
the wedding has room, so a batch that would end past the cap is rolled back,
whatever another writer committed after the check before the write. The apply
and revert routes answer that refusal with the usual 402; the apply's body adds
`reason: "head_moved"`, because the change may have written part of its data
and its preview is spent. The check before the write now runs for every change
that adds a guest, so a wedding already over its cap is refused a change that
would leave it over.
