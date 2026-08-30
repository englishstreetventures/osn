---
"@tools/oxlint-house": patch
---

Check file modes in the vendored anti-slop tree.

`SHA256SUMS` hashes contents and the guard's file-set diff compares names, so flipping a vendored file from `100644` to `100755` passed both halves and landed with nothing firing. Nothing in that tree is executed — oxlint imports the modules — so the bit changes nothing at runtime; what it changed was the truth of the claim the tree makes, which is byte-for-byte fidelity to a reviewed copy, and which `wiki/compliance/soc2.md` cites as an integrity control.

Asserted as an invariant — every tracked file is `100644`, or `120000` for a symlink — rather than recorded as a second column in the manifest. That keeps `SHA256SUMS` a plain `shasum -c`-readable file, leaves the re-vendor recipe unchanged, and means a re-vendor that genuinely brings an executable fails the check rather than passing quietly.
