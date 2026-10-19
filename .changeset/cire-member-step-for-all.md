---
"@cire/api": patch
"@cire/invites": patch
"@tools/e2e": patch
---

The household member step reaches every guest household, not only those with `cire.account-linking` on. After a claim, a household of several is asked "Who are you?", `POST /api/rsvp` answers 409 `member_required` until it says, and every reply records its sender for "Answered by"; a household of one is chosen for. The musubi link box, and the `submitted_via_link` mark, stay behind the flag: with it off, `POST /api/claim/member` answers `accountLink: { enabled: false }`. A wedding listed in the new `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS` secret (comma-separated wedding ids; unset ⇒ none) keeps the step behind the flag. A save from a page showing a member the session no longer holds (another tab chose someone else) now answers 409 `member_changed`, and the page asks "Who are you?" again. While linking is off, unlinking is refused for all but the linked account itself. The guest privacy notice now lists which member sent each reply. A new E2E flow, `cire-member-step`, proves the flag-off household's path end to end.
