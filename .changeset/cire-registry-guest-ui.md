---
"@cire/invites": patch
---

Gift registry — the guest surface

Adds the gift list to the invite: `lib/gift-registry.ts` (a typed client over the three guest routes) and `components/gift-registry/`, mounted in both design packs as its own island between the invite page and the footer. It is a separate island on purpose — the public list read needs no session, while the invite page's whole body is claim-gated, so a section inside it could not render for someone who has not yet entered their code. A signed-out guest sees the gifts and a line telling them where to enter that code, not a button that can only fail.

A guest sees counts and never names: "1 of 2 left", "All reserved", and for a taken item "Another guest has this one covered." The only name on the page is the household's own display name, read from the credentialed household route and handed back to the people who typed it. A gift note is written for the couple and is never rendered here at all.

Nothing is optimistic. Every count a guest reads came from a read the server had just answered, which is what makes the ordinary race honest: two households tapping the last copper pan at the same moment means the second one gets a 409, and the section refetches both reads, says plainly that another guest was a moment faster and that the list below is now current, and leaves the claim form open with everything they typed still in it. Keeping that form is why the list iterates item ids rather than the item objects — Solid's `<For>` reconciles by reference, and every refetch parses new objects, so iterating the items threw away each row exactly when the 409 path re-read in order to show the new counts beside those words.

A household may raise its own reservation up to `remaining` plus what it already holds, because the server's claim is an upsert whose availability guard skips the caller's own row; a household holding both of two copies still gets a Change control rather than a dead card. A shop link is re-parsed for `https:` at the render site and renders no link at all otherwise, and carries `rel="noopener noreferrer"` — a render site that trusts its input because of what the server promised is one API change away from being wrong. The household read only fires when the `cire_claimed` hint cookie is present: this section is public and every visitor scrolls past it, so an unconditional call would spend a guaranteed 401 per page view rather than per guest.

Three states that look alike are kept apart: an unpublished or unentitled registry renders no section at all, a published empty one renders its heading and says the couple have not added any gifts yet, and the couple's shipping address appears only when the API actually sent it — absent covers both "they set none" and "you may not see it", so there is nothing honest to print in its place.

Left out on purpose: contributions. `kind: "cash_fund"` renders like any other item, because a contribute flow over a backend that cannot yet take a charge would be an interface standing in for something that does not exist.
