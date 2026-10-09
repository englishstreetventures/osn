---
"@cire/api": patch
---

Retention sweep and parting gift summary:

- The gift-summary email prints its total with the currency's own minor unit
  (`formatMinor` in `lib/money.ts`): none for yen, three decimals for the
  Kuwaiti, Bahraini and Jordanian dinars.
- The sweep counts the gift summaries before it reads anything to delete and
  writes them in the same D1 batch as the delete, so a summary and the deletion
  of what it counts commit together or not at all. If the gifts cannot be
  counted or the batch does not commit, nothing is deleted that run and an error
  is logged, for at most 30 days past a wedding's retention date; past that it
  is deleted without its summary and the loss is logged; a summary written but not mailed because the owners could not be
  read logs its own line. Both are counted in `cire.gift_summary.written` and
  `cire.gift_summary.unmailed`.
- The email sender takes the organiser address lookup that keeps osn-api's
  answer status, so an osn-api that fails, rejects or hangs is logged with
  counts only; the status-dropping resolver is removed. Where the transport
  takes batches, the cohort's emails go in one batch call.
- The cohort selects only weddings that still hold a household or an import,
  and a wedding that comes back with new gifts has them added to its stored
  summary.
