---
"@osn/ui": minor
---

Add a shared `UsernameInput` component (`@osn/ui/ui/username-input`) — a text
field with a fixed "@" ahead of the box, wired to an optional debounced
availability `status` (`checking | available | taken | invalid | error`). This
replaces the near-identical hand-rolled "@" + status-message block that had
been duplicated between `Register.tsx` and `CreateProfileForm.tsx`; both now
consume the shared component.
