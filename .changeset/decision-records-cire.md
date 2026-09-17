---
"@cire/invites": patch
"@cire/api": patch
---

Move three more decision records out of cire source files into `wiki/decisions/`.

Comments only — no executable line changes.

| File | Block | Now lives at |
|---|---|---|
| `cire/invites/src/lib/z-index.ts` | 84 → 63 lines | `wiki/decisions/top-layer-over-z-index-stack.md` |
| `cire/invites/src/components/InviteClosing.tsx` | 72 → 64 | `wiki/decisions/closing-band-width-bound-over-height-clip.md` |
| `cire/api/src/db/d1-session.ts` | 79 → 62 | `wiki/decisions/d1-session-first-primary.md` |

Each file keeps the sentences that state what it guarantees now — the layers
table and the `TOAST < CONSENT` bound, the full-width/crop-aspect rule and the
width bound that is never a `max-height` clip, the `first-primary` guarantee and
the inert-until-replicas note — plus a `@see` to its page by repo path.

The D1 page is short on purpose. `wiki/systems/d1-read-replication.md` already
carries that argument with its own measured markers, so the decision page states
the two choices and hands off rather than becoming a second copy that drifts.

Two corrections fall out of the move. `z-index.ts`'s Tailwind note listed
`"z-100"` among the literals spelled out for the scanner; there is no `z-100`,
and a class the scanner cannot see is a utility that is never emitted. And
`Z_LAYER.TOAST`'s own comment was nine lines of history about `solid-toast`, a
library this repo no longer uses, already recorded in `wiki/systems/toast.md`;
the half that states what the code guarantees stays, the history moves.
