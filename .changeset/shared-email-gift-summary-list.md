---
"@shared/email": minor
---

`registry-gift-summary` takes a total per currency (`giftTotals`, each with
its count), the couple's currency (`giftCurrency`), each money gift
(`gifts`) and how many are not listed (`giftsUnlisted`), in place of the
single `giftTotal`. The money line puts each count beside its own total,
the list shows every gift by its day, and a gift in another currency is
marked as outside the couple's total in smaller text.
