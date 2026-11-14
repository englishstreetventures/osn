---
"@musubi/social": patch
---

Pages read through one cache. Coming back to Connections, Discover, Organisations, an organisation or Settings' Connected apps draws the rows it last had at once and reads them again behind them, so moving between pages no longer flashes placeholders. A first load draws as many placeholder rows as that page last landed, one when nothing is known. Hovering, focusing or touching a link to a page starts its first read. Every entry, row count and read in flight is cleared when the session changes — sign-in, profile switch, profile reset, sign-out or the session ending — so no account or profile sees another's rows. A row action pressed while its list is being read again is busy, waits for the read, and acts only on a row still there; Unblock now takes the row off the list.
