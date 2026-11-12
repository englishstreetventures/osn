---
"@shared/toast": patch
---

Hover and focus no longer touch a toast's clock once it is leaving: `pause` and `scheduleDismiss` do nothing for a dismissing toast, so its removal always runs. A toast that held focus as it was dismissed no longer leaves a dwell timer behind that `resetToasts()` cannot clear and that ends the next toast raised under the same id, and a pointer or focus that reaches a leaving toast no longer keeps it in the queue.
