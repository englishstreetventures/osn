---
"@shared/ui": patch
---

Every browser test now starts on a clean page. One setup file, named in the browser project's `setupFiles`, runs after each test: it unmounts every render, closes any dialog or popover left open, waits until the `aria-hidden` writes Kobalte queues as a menu unmounts have landed, puts back the attributes `<html>` and `<body>` had when the file loaded, scrolls to the top and turns media emulation off. A test that followed one which left a menu open could start while `<body>` was still hidden, so a `getByRole` straight after `render` found nothing. Each file's own copies of these steps are gone, and `button.browser.test.tsx` turns forced colours on before each test rather than once per file. No component changes.
