---
title: "Performance Fixes"
tags: [changelog]
related: [[TODO]], [[index]]
last-reviewed: 2026-08-06
---

# Performance Fixes

Archive of completed performance findings, moved here from the Performance Backlog in [[TODO]].

### RSVP success confirmation — review findings (fixed on `claude/cire-rsvp-success-feedback-phnf60`, 2026-08-06)

The animation work reviewed performance-neutral and compositor-correct: the sweep compiles to Tailwind v4's independent `scale` property and `transition-transform` genuinely lists `scale`, so it animates off the main thread with no layout and no paint; the tick's `stroke-dashoffset` is the one non-composited animation (a 16x16px repaint for 340ms, once — there is no composited way to draw a stroke); no `will-change` was added, correctly, since the browser auto-promotes for the transition's duration and drops the layer after. The always-mounted fill layer costs nothing at first paint — `RsvpModal` lives inside `<Show when={rsvpEvent()}>`, so it is not in the first-paint tree until a guest taps Respond, and at `scale: 0% 1` it has zero device area. Measured bundle delta: **+193 B gzip CSS, ~+405 B gzip JS**, absorbed into the existing `RsvpModal` chunk with no new request. Two Info findings were fixed in the same branch.

- [x] **P-I1** (unbatched success-path writes) — the 200 branch wrote three signals as separate statements after an `await`, i.e. outside any batching context, so the reactive graph was walked three times. `locked()` is a plain accessor rather than a memo, so every `disabled={locked()}` site subscribes individually — both toggles per member, the dietary field, the consent box, Cancel, and the submit button's own `disabled` / `aria-disabled` / `classList`. `setLoading(false)` re-enabled all of them and `setSaved(true)` immediately re-locked them: roughly double the attribute writes, plus a transient fully-unlocked state, on the exact frame the 500ms sweep starts. **Fixed:** all three writes wrapped in `batch()`, so the graph is walked once with final values and the intermediate state never materialises. (The ordering inside the batch is also load-bearing — see S-L2 in `[[changelog/security-fixes]]`.)
- [x] **P-I2** (tests slept ~1.8s of real wall-clock per suite run) — two tests waited out the real 900ms dwell via `waitFor(..., { timeout: SAVED_DWELL_MS + 750 })`. Measured: the POST-shape test went 216ms → 1102ms and the preview no-op test 5ms → 920ms, taking `RsvpModal.test.tsx` from 1.91s to 4.16s, on every CI run and every local `bun run test` — and growing by another 900ms for each future test that needs to observe the sheet closing. **Fixed:** both install `vi.useFakeTimers()` before the submit (the dwell is a real `setTimeout`, so the clock must be mocked before it is registered) and drive it with `await vi.advanceTimersByTimeAsync(...)`, which still flushes the fetch promise chain. `vi.useRealTimers()` was added to the suite's `afterEach` — `restoreAllMocks` does not cover the timer mock, and a leaked fake clock would silently freeze later tests. Net effect with 8 new tests added alongside: file 4.16s → 1.90s, package test time 7.8s → 6.3s.
