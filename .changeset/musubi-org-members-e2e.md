---
"@tools/e2e": patch
---

New flow `musubi-org-detail`: the dev profile signs in to Musubi (`signInToMusubiAsDev`), creates an organisation, adds a seeded member through the API, opens, renames and empties it, opens an organisation it does not belong to from the search box, deletes its own and follows the stale link back. The seed adds that member profile and the organisation it owns, and `flows.test.ts` counts Musubi dev sign-ins against the ten dev logins a minute.
