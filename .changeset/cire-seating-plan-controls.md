---
"@cire/host": minor
"@cire/api": patch
"@cire/db": patch
---

Couples can keep several seating plans for an event, copy one to try an idea, and choose which one is in use

- **Plans in the portal** (`@cire/host`): a plan picker sits under the event picker in the Seating module. An editor can duplicate the plan on screen (its tables, their order and every seat), start a blank plan, rename a plan, put another plan in use and delete a plan that is not in use; changing one plan changes no other. Each plan lists, in a "Needs review" notice, the guests seated who declined, the guests seated whose invitation was withdrawn and the guests who said yes with no seat; a reply never moves a seat. The print sheet names the plan. A copy past the wedding's daily copy ceiling says so. A chart from an API before plans, or for an event with no plan yet, is read and written through the event's own addresses.
- **Taking seating back below Gold** (`@cire/api`, `@cire/host`): `GET …/seating.csv?plans=all` prints every plan, each event's plan in use first, with `Plan` and `In use` columns, up to 4,000 rows; the locked Seating card offers that file, counts every plan's seats and says when the file holds fewer. The venue download in the module still prints only each event's plan in use.
- **E2E seed** (`@cire/api`): `CIRE_E2E_ORGANISER=1` adds `wed_e2e_seating_locked`, a wedding on Ivory that kept two seating plans.
- **Dev seed** (`@cire/db`): the sample wedding's Reception gets a second seating plan, "Long table", with Ada, Bo and Eli at one table.
