---
---

fix(cire/web): always show a mood-board link on the guest invite Details view, even when the Pinterest embed is blocked, slow, or the board URL isn't directly embeddable. Splits the single Pinterest URL gate into a loose "safe link" check (gates the always-visible outbound link, accepts pin.it short links + section sub-paths) and a strict "embeddable board" check (gates the embed script + widget anchor).
