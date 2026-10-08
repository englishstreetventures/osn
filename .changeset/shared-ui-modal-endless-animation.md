---
"@shared/ui": patch
---

`Modal` closes past an endless animation inside it, such as a loading spinner. It used to wait on every running animation before calling `close()`, and an endless one never finishes, so the dialog stayed invisible but modal, with the page behind it inert.
