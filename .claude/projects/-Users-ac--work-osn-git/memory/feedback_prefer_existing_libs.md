---
name: Prefer existing libraries over custom implementations
description: When a well-scoped library exists for a UI pattern, use it instead of building from scratch
type: feedback
---

Prefer battle-tested libraries for common UI patterns rather than building custom implementations.

**Why:** When proposing a custom toast implementation, the user redirected to solid-toast — a lightweight (4 KB) library that already handles animation, auto-dismiss, positioning, and accessibility correctly.

**How to apply:** Before implementing a UI utility from scratch (toasts, modals, tooltips, date pickers, etc.), check if a small, SolidJS-compatible library exists. Propose the library option first.

---

Caret ranges (`^x.y.z`) are normal for regular dependencies. Only use tilde ranges (`~x.y.z`) for high-risk deps or packages that don't follow semver (e.g. TypeScript). Never recommend pinning to exact versions as a general practice.

**Why:** User corrected a security review finding that flagged `^0.5.0` as a risk — caret ranges are the standard npm/bun convention and the lockfile provides determinism at install time.
