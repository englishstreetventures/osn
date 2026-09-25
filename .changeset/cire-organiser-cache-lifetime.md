---
"@cire/host": patch
---

The host portal now holds a wedding's cached rows only while that wedding's
dashboard is open. Guest names, vendor contact details, budget figures and the
gift log are dropped the moment the organiser moves to another wedding, back to
the list, to Security, or signs out. A request that was still in flight when
they left cannot bring the rows back.

The dashboard is now keyed on the wedding id, so switching weddings mounts a
fresh dashboard. Before, the Overview kept showing the previous wedding's date
and replies after a switch.

When the API refuses a wedding request with 403, or the tab comes back into
view after a minute, the portal reads the wedding list again. A wedding the
organiser was removed from closes and its rows are dropped. So does a wedding
where their role no longer includes the dashboard.

Two requests are gone. Replying to a vendor enquiry no longer reads the whole
thread again, and adding a vendor from the directory puts the returned row
straight into the vendors list.
