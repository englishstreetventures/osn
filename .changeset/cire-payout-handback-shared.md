---
"@shared/email": minor
"@osn/api": patch
"@musubi/social": patch
---

`@shared/email` adds the `registry-payout-holder-erased` template, and it and `registry-payout-retired` wrap a wedding name with no spaces inside their frame. osn-api's scheduled deletion email gives an app action whose only choice is its default that choice's words under "Delete everything". Musubi's deletion flow leaves such an action's words at full strength when "Delete everything" is ticked.
