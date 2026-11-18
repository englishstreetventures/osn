---
"@cire/api": minor
"@cire/host": minor
"@cire/ui": patch
"@cire/landing": patch
---

A host can remove their Cire data and keep their Musubi account: "Remove my Cire data" in the portal's account menu. The screen lists each wedding they hold a seat on and what removal does to it, offers each wedding they alone own its download and a way to add another owner, takes an answer for each, sends them to Musubi to confirm it is them, and removes everything at once. cire-api adds `POST /api/organiser/account/removal/preview`, `POST /api/organiser/account/removal/confirmation` and `DELETE /api/organiser/account`, which runs the account erasure with a new `host` scope that keeps vendor listing claims and guest account links, ends the person's organiser sessions, and emails the owners who remain. The account deletion's open action now links the wedding's download page, which offers to add another owner. New counter `cire.account_removal.requests` and owner-notice kind `owner_left`. `@cire/ui` exports the sign-in card's frame, header and title classes beside `signInCardClass`, which the removal's done page uses. The hosts' privacy notice says a host can remove their Cire data themselves from the organiser portal's account menu.
