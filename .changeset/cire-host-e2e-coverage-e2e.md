---
"@tools/e2e": patch
---

Three cire organiser flows cover more of the portal on the sign-ins they already make. `cire-registry-money` drives the Budget module (a line, its actual cost, a total it runs over, a paid deposit, a delete whose Undo toast runs out) and the vendor directory and Enquiries (an enquiry to a listing with no vendor profile on it, which waits on the listing and mints no claim link, and a seeded quote added to the budget). `cire-seating` reverts a household-adding sheet from Change history. `cire-checklist-holders` redeems unlock codes on its own wedding (refused unknown, refused for the tier held, accepted to Crimson), re-mints its family codes, and deletes and restores it. Each step ends in checks against cire's database.
