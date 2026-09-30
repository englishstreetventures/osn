---
"@cire/host": patch
---

The Budget tab reads and writes every amount in the wedding currency's own
minor unit. The add-item estimate, the Est, Quote and Actual cells, the payment
amount and the budget total parse with `parseMinor` and open at their stored
figure with `minorToInput`, where they multiplied and divided by a fixed 100: a
JPY wedding stored ¥50,000 as 5,000,000 minor units, and a KWD one was ten times
too small. Every money input takes `step="any"`, so a three-decimal amount no
longer stops the add-item and payment forms submitting. The Overview's budget
card and its agenda's payment rows format through `formatMinor` for the same
reason.

A payment with no amount is refused instead of being saved as zero, and the
payment form keeps what was typed when it is refused.
