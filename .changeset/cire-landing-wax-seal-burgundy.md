---
"@cire/landing": patch
---

Rebuild the hero's 3D wax seal look, motion, and fallback behaviour.

Robustness: the poster fallback previously hid the moment the island committed
to loading Three.js — if the deferred import, WebGL context, or first frame
then failed, the hero showed nothing. The poster now stays visible until the
3D scene's first frame has actually painted, and any load failure keeps it.
Reduced-motion visitors now get the 3D seal as a still life (single frame, no
animation) instead of the flat CSS poster — previously `prefers-reduced-motion`
skipped 3D entirely, which left e.g. macOS "Reduce motion" desktops with only
the poster.

Motion: the seal no longer rotates on its own. It rests in a fixed pose and
leans slightly toward the pointer; the only load animation is the brief settle.

Look: the seal is rebuilt as a stamping — a flat pressed field, a shoulder
groove, one smooth proud rim, and a near-circular silhouette with restrained
per-mount randomness (harmonics, one or two run-out tongues), so every visitor
gets a subtly unique seal. The die now carries a laurel wreath (vine, opposed
leaf pairs, berries) around an italic "C" matching the poster, with a deeper
emboss, and a roughness map that renders the pressed design burnished-glossy
against the matte cooled-wax field. Verified visually via headless-Chrome
screenshots at desktop and mobile sizes, including hi-DPI close-ups.
