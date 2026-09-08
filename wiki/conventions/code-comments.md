---
title: Code Comments
description: What a comment is for here, the four references that rot, and the TSDoc tags to use instead
tags: [convention, comments, lint]
related:
  - "[[review-findings]]"
  - "[[contributing]]"
  - "[[testing-patterns]]"
last-reviewed: 2026-09-07
---

# Code Comments

A comment states **what the code guarantees now**. Not what it does — the
identifiers say that — and not how it came to be this way.

`house/no-tracker-ref-in-comment` (in `tools/oxlint/house`) enforces the four
rules below. It runs at `warn` while the existing references are cleaned up
(`xchromo/osn` issue #924), then goes to `error`.

## The four references that rot

| Shape | Example | Why it goes |
|---|---|---|
| Tracker issue number | `osn-tracker#589` | Stops resolving when the issue closes. This repo is public and the tracker is private, so it is a disclosure as well as a dead link |
| Review finding tag | `S-M3`, `P-C1`, `C-L1`, `T-S2`, `D-H1` | Means nothing to a reader who cannot open the tracker, and nothing at all once the finding is closed |
| Phase or plan code | `O3:`, `Z4:`, `X1:` | The plan ships and the code refers to nothing |
| Bug-history narration | "used to be", "was reported as" | Describes a state the code is no longer in |

The history is not lost by removing it — the commit and the pull request keep it,
and keep it accurately. A comment is the one place it decays silently.

## What to write instead

In order of preference. Reach for the first one that fits.

**1. Nothing.** Rename the thing. `MAX_MY_CONNECTIONS_FOR_FOF` needs no comment
saying it caps fan-out width.

**2. A wiki reference**, when the reasoning is a system's and not this call
site's. Reference by **repo path**, never a `[[wikilink]]` — a wikilink does not
resolve in an editor's hover, in a diff, or on GitHub:

```ts
/** @see wiki/systems/rate-limiting.md — window sizes and the fail-closed rule. */
```

**3. A public issue reference**, when the code is provisional and the issue says
what would replace it. `xchromo/osn` issues only, never the private tracker:

```ts
/** Single Worker by choice, not by constraint — see xchromo/osn#412. */
```

> [!warning]
> Never "fix" an `osn-tracker#589` reference by dropping the repo to `#589`.
> The bare form passes the linter and resolves to an unrelated issue in the
> public repo, so the edit looks clean and quietly invents a wrong
> cross-reference. Replace the reference with the constraint it stood for, or
> delete it.

**4. An inline explanation**, when the reason is genuinely local: a bound that
comes from somewhere non-obvious, an ordering that matters, a workaround for a
platform quirk. Keep it to the constraint:

```ts
// D1 caps a compound select's bind parameters at 100, and this list binds
// into two inArray calls.
const MAX_MY_CONNECTIONS_FOR_FOF = 500;
```

## Known issues and deferrals

**A deferral is an issue with a link, never a paragraph.** If you are choosing
not to do something now — a limitation you are accepting, a rule left at `warn`,
a fix scoped out of this change, a workaround standing in for a real one — open
an issue and let the code carry the link:

```ts
// Bounded to 500 until xchromo/osn#412 removes the per-request rebuild.
```

Not:

```ts
// We cap this at 500 because the layer is rebuilt per request. Ideally the
// runtime would be shared and this could go away, but that is a bigger change
// touching four packages, so for now the cap stays.
```

The second version reads as though someone has it in hand. Nobody does. It has
no owner, appears in no backlog, and is found only by whoever next opens that
file — which is the failure this whole page exists to stop, in the one form that
looks most like diligence.

**A deferral is not a decision.** A settled choice with a reason belongs inline
and needs no issue: `require-param` stays off because it would demand a
restatement of the types, and that is true permanently. The test is whether the
sentence implies future work. "For now", "until", "eventually", "ideally",
"a bigger change" — those are deferrals wearing an explanation.

This applies to **config comments too**, not just code. `oxlintrc.json` says a
rule sits at `warn` until issue #924 clears its backlog; what it must not do is
describe the backlog.

> [!warning]
> A security, performance or compliance finding lives in the private
> `xchromo/osn-tracker` and must **not** be linked from a file in this public
> repo — the link is the disclosure. State the constraint the code is holding to
> and leave the finding unnamed. `house/no-tracker-ref-in-comment` fails the
> build on the reference, which is the backstop, not the rule.

## One block per declaration

Only the **last** doc block in front of a declaration is attached to it. Stack
two and an editor shows the reader the second one, while the first documents
nothing — and whatever it was really describing has silently lost its comment.

```ts
/** Verifies the ARC token and rejects an unsigned caller. */
/** Builds the Elysia plugin. */          // ← only this one is attached
export function arcMiddleware() { … }
```

A blank line between them changes nothing, which is why
`house/no-stacked-doc-block` asks the source code for the comments before a
declaration rather than measuring the gap. It runs at `warn`: 64 sites today,
four of them in auth code, so it goes to `error` once those are clear.

A block **opening the file** is exempt — that one documents the module, not
whatever declaration happens to follow it. Put it above the first `import`.

## Length

Past **four or five lines**, ask whether the content belongs in a wiki page with
a `@see` pointing at it. A long comment is usually a system's documentation that
landed at a call site because that is where it was written.

Two shapes earn the length and are not the exception that swallows the rule:

- a **module docblock** on a file whose whole contract needs stating at the top
- a **threat model** on a public or unauthenticated boundary, where the reason
  the code is defensive is the point (`cire/api/src/routes/csp-report.ts`)

`shared/crypto/src/timing-safe.ts` is the calibration for a dense comment that
earns every line: a runtime quirk (workerd has no `crypto.timingSafeEqual`) and
a subtlety a reader would otherwise get wrong (UTF-8 versus UTF-16 length).

## TSDoc tags

Prose is the default. Where a tag is the clearer form, use the
[TSDoc](https://tsdoc.org) set rather than inventing one:

The tag set is closed, and it is four tags:

| Tag | For |
|---|---|
| `@see` | The wiki path or public issue carrying the fuller reasoning |
| `{@link Name}` | Naming another symbol in this repo, in place of a backticked identifier |
| `@deprecated` | What to use instead, named |
| `@param` | Only what the type cannot say — a unit, a range, a caller obligation |

Anything else is a review rejection, and most of it is a lint error too.
`jsdoc/check-tag-names` runs at `error` and denies every tag it does not
recognise, which covers all the TSDoc-only spellings — `@remarks`,
`@defaultValue`, `@typeParam`, `@inheritDoc`, `@packageDocumentation`, `@alpha`,
`@beta` — and anything invented. The classic-JSDoc spellings it *does* accept
(`@example`, `@throws`, `@internal`, `@since`, `@public`, `@override`) are out
by convention rather than by the linter, so they need a reviewer to catch.

The test for any tag: **name the retrieval or reasoning task it makes possible.**
If the answer is "it documents the code", delete it.

A scoped package name is a trap. `@simplewebauthn/browser` at the start of a
doc-comment line parses as a tag, so backtick it — which is the right style
anyway.

**Do not write `@param` or `@returns` for what the types already say.** That is
the redundant-comment problem in a tag's clothing. Both stay off in
`oxlintrc.json` deliberately: `jsdoc/require-param` and `jsdoc/require-returns`
would add 1624 and 1934 warnings, every one of them asking for a restatement of
the signature. Write `@param` only to say something the type cannot — a unit, a
range, an ownership rule.

The jsdoc rules that **are** on, all at `warn` and all at zero hits when enabled,
so they only ever fire on new drift: `empty-tags`, `require-param-description`,
`require-returns-description`, `no-defaults`, `implements-on-classes`. Together
they say: a tag you write must carry content.

`jsdoc/require-yields` is deliberately **off**. It wants a `@yields` tag on
every generator function, which in this repo means every `Effect.gen`.

## Reviewing a comment

Three questions, in order:

1. Does it say something the code does not? If not, delete it.
2. Will it still be true in six months if nothing here changes? If not, it is
   history — move it to the commit message.
3. Is it longer than five lines? If so, the wiki probably wants it, with a
   `@see` left behind.
