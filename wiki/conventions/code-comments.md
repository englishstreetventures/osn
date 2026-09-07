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

**4. An inline explanation**, when the reason is genuinely local: a bound that
comes from somewhere non-obvious, an ordering that matters, a workaround for a
platform quirk. Keep it to the constraint:

```ts
// D1 caps a compound select's bind parameters at 100, and this list binds
// into two inArray calls.
const MAX_MY_CONNECTIONS_FOR_FOF = 500;
```

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

| Tag | For |
|---|---|
| `@see` | The wiki path or public issue carrying the fuller reasoning |
| `@remarks` | Detail that follows the one-line summary |
| `@example` | A call site worth copying |
| `@defaultValue` | What a value falls back to |
| `@deprecated` | What to use instead, named |
| `@internal` | Exported for another module here, not part of the package's surface |

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

`jsdoc/check-tag-names` is deliberately **off**. Its only three hits are false
positives — a scoped package name (`@simplewebauthn/browser`) wrapped onto the
start of a line inside prose, which the parser reads as a tag. A warning stream
with known-false entries is one nobody reads.

## Reviewing a comment

Three questions, in order:

1. Does it say something the code does not? If not, delete it.
2. Will it still be true in six months if nothing here changes? If not, it is
   history — move it to the commit message.
3. Is it longer than five lines? If so, the wiki probably wants it, with a
   `@see` left behind.
