---
title: "Decision records"
aliases:
  - decisions
tags:
  - decision
  - index
related:
  - "[[index]]"
  - "[[deferred-decisions]]"
  - "[[code-comments]]"
last-reviewed: 2026-09-17
---

# Decision records

One page per choice that was made between named alternatives, with the
reasoning that decided it. These are the arguments that used to sit at the top
of a source file: too long to read on the way past, and read again by every
future reader of that file whether or not they needed it.

A source file keeps a short comment saying what the code guarantees now, plus a
`@see wiki/decisions/<slug>.md` by repo path — a `[[wikilink]]` resolves in
Obsidian and nowhere else, and an editor cannot follow one.

## What belongs here

- A choice between **named alternatives** — the thing that shipped, and the
  things that did not.
- The **evidence that decided it**, with any measured figure carried over with
  its own marker (the command and the date, or the method, exactly as the source
  recorded it). Never a re-measurement invented to fill the gap.
- **What would make it worth revisiting** — the condition, not a promise.

## What does not

- **A comment stating a current guarantee.** "This binds the id list once, so it
  stays under D1's 100-parameter cap" is what the code does; it belongs beside
  the code and stays there. Moving it to the wiki puts it where nobody editing
  the line will read it.
- **A deferral.** Work you are choosing not to do now is a GitHub issue, and the
  code carries the link and nothing more. See the *Known issues and deferrals*
  row in `CLAUDE.md`.
- **An open question.** Something not yet decided goes in [[deferred-decisions]],
  which has a "Revisit When" column for exactly that.
- **A changelog.** How the code got here is in `git log`. A page here states the
  decision as it stands, and its reasons.

## The pages

| Page | The decision |
|---|---|
| [[native-dialog-over-kobalte]] | `@shared/ui`'s `Modal` is the platform `<dialog>` + `showModal()`, not the Kobalte `Dialog` the same package ships — Kobalte does not fit the cire bundle budgets, and the top layer removes a bug class |
| [[org-comember-fanout-batched-union]] | The org co-member fan-out uses batched `UNION ALL` arms with a per-organisation `ORDER BY … LIMIT`, not a global `LIMIT`, a window function or `json_each()` |
| [[post-rank-connection-recheck-over-d1-batch]] | A bounded re-check after ranking fixes the step-1/step-2 race, rather than a `db.batch()` that would depend on undocumented D1 isolation |
| [[d1-migration-cost-budget-calibration]] | `scripts/guard-d1-migration-cost.ts` prices a chain offline at 27 D1 rows per schema write — the top of a measured 22-27 band |
| [[rsvp-dwell-as-budget-with-announcement-floor]] | The cire RSVP confirmed-state dwell is a budget spent from the click, with a 500ms floor sized by the spoken announcement rather than the visible label swap |
| [[top-layer-over-z-index-stack]] | The cire guest site's stacking scale has no modal layer — what must clear a sheet enters the top layer after it, rather than carrying a bigger number |
| [[closing-band-width-bound-over-height-clip]] | The closing band's height follows the organiser's crop, and the height bound is enforced by constraining the box's width — never by a `max-height` clip |
| [[d1-session-first-primary]] | One D1 session per request, opened `first-primary` for the whole Worker, so read-your-writes never depends on which route was reached |

## Writing one

Name the file for the decision, not the file it came out of:
`native-dialog-over-kobalte.md`, not `modal.md`. Keep the frontmatter every
wiki page carries (`title`, `tags` including `decision`, `related`,
`last-reviewed`), and link the page from the table above and from the
navigation table in [[index]].
