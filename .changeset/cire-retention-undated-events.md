---
"@cire/api": patch
---

The guest-data retention sweep deletes a wedding's guest data only when every event's Start, and every End that is set, begins with its date (`YYYY-MM-DDT…`). A wedding with any other value keeps its guest data until a host fixes the event. Each run logs at warning how many such weddings hold guest data with every dated event a year past: a count, with no wedding id and no stored value. The count rides on the sweep's one read of `events`.
