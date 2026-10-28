---
"@shared/design-tokens": patch
"@shared/ui": patch
---

The token contract gains a `field` radius role for text inputs: `rounded-ui-field`, mapped through `--ui-radius-field`. `Input`, `Textarea` and `Select` take their corner from it rather than from `control`, so an app can give its buttons pill ends without making its fields pills. It falls back to `--ui-radius-control`, then `--ui-radius-md`, so an app that maps no field radius renders as before.
