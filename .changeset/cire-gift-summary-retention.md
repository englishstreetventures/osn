---
"@cire/api": patch
---

Retention sweep and parting gift summary:

- The gift-summary email prints its total with the currency's own minor unit
  (`formatMinor` in `lib/money.ts`): none for yen, three decimals for the
  Kuwaiti, Bahraini and Jordanian dinars.
- The sweep writes the gift summaries before it reads anything to delete, and
  holds back from that run's delete any wedding whose gifts could not be counted
  or whose summary batch did not commit, logging an error each run it is held.
  A summary written but not mailed because the owners could not be read logs
  its own line. Both are counted in `cire.gift_summary.written` and
  `cire.gift_summary.unmailed`.
- The email sender takes the organiser address lookup that keeps osn-api's
  answer status, so an osn-api that fails, rejects or hangs is logged with
  counts only; the status-dropping resolver is removed.
- The cohort selects only weddings that still hold a household or an import,
  and a wedding that comes back with new gifts has them added to its stored
  summary.
