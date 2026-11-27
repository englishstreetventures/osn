---
"@cire/api": patch
"@cire/infra": patch
"@cire/host": patch
---

cire-api records each erasure request it accepts outside `cire-db` before writing it: "Remove my Cire data", a wedding's delete and restore, a guest's removal of their own email address, and osn-api's account erasure. The two erasures of an account then write their outcome over the record — the weddings deleted, each seat removed (the clean-up's included, at most 200 below owner a call), a wedding batch that failed or did not answer (left to a person), whether the clean-up ran and whether the erasure finished — also when they fail part way, so a replay after a restore applies no more than they did. A request whose record cannot be written answers 503 and erases nothing; a wedding restore goes ahead and logs the failure. The cire stack declares `cire-deletion-records`, private, each record deleted after 31 days, bound as `DELETION_RECORDS`, and production adopts it. The erasure's clean-up takes at most 200 seats below owner a call and answers not finished past them; an account's erasure ends the person's organiser sessions first, on every call, and a host's removal keeps them until no seat is left. The host portal shows a removal that could not be recorded as "Cire couldn't finish this. Try again." rather than as Musubi out of reach.
