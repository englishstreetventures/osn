---
"@cire/host": patch
"@cire/api": patch
---

Fade out and no-op the nav rows of locked modules instead of giving them upsell pages.

A module the wedding is not entitled to no longer has a page. `isModuleLocked` derives the lock from the wedding's own entitlement set, `ModuleShell` coerces a locked module back to Overview, and the row stays in the rail and the sheet — faded, `aria-disabled`, navigating nowhere. Resting a pointer on it for three seconds, holding keyboard focus on it for the same delay, or clicking it opens a popover naming the module and offering an Upgrade button that is inert until checkout exists. The click path matters: the hover card ignores touch pointers, so a hover-only row would be dead on a phone.

The command palette and the Overview vendors card drop a locked module rather than offering a route that lands somewhere else, and Overview no longer fetches vendors for a wedding that cannot open them. `UpsellPanel` and its two dedicated pages are gone. Server enforcement is unchanged: the 402 `payment_required` gate stays where it was.

The vendors module's three panels join the registry in arriving as their own chunks rather than in the first load. That split was already argued for the registry on the grounds that an organiser without the entitlement never reaches the module; making the coercion real is what makes the same argument true of vendors.
