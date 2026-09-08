---
"@osn/api": patch
"@osn/social": patch
"@pulse/api": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/observability": patch
"@shared/osn-auth-client": patch
---

Fix every `house/no-stacked-doc-block` site in these packages (xchromo/osn#926).

A declaration with two or more leading doc blocks only has its last block attached — the earlier one silently documents nothing, and an editor hovering the declaration never shows it. Two shapes accounted for all 26 sites across these packages: a genuine module doc that had been placed after the file's `import` line rather than at line 1, which the rule's module-block exemption checks literally, and so read as stacked in front of whatever the doc block happened to precede — moved to line 1, restoring both blocks to their correct attachment; and two doc blocks that were both actually describing the same declaration, split apart for no good reason — merged into one, with content preserved and no duplication.

No prose was rewritten and no behavior changed. Every fix was spot-checked by an independent adversarial pass against the real diff before being applied, confirming no content was lost and every surviving block attaches to the declaration it actually describes.
