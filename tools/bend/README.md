# tools/bend

The Bend toolchain every law set in the repository shares: the pinned release
(`bend.env`), its installer (`install-bend.sh`), the pinned Lean toolchain that
builds Bend's BendTT kernel and that kernel's hash (`lean.env`), Lean's
installer for CI (`install-lean.sh`), the proof kit every set's proofs import
(`kit.bend`), and `bend.sh`, the only way to run Bend here. A law set lives
beside the code it is about, in `<workspace>/laws/<topic>/`, with its own
`LAWS.bend` and `PROOF.bend`; `wiki/osn/account-deletion-laws.md` describes
the account-deletion sets and how to add one.

```bash
bash tools/bend/bend.sh install    # the Bend release bend.env pins, SHA-256 checked
bash tools/bend/bend.sh guide      # how to write Bend 2 (never run bend bare: it pings bend-lang.com)
bun run --cwd tools/bend sets      # every law set
bun run --cwd tools/bend check     # prove every set, and check each model.mjs is what its model.bend builds
bun run --cwd tools/bend build     # rebuild every model.mjs after changing a .bend file
bun run --cwd tools/bend verdict   # recheck every set with the BendTT kernel (needs Lean 4.34.0 or $BENDTT)
bash tools/bend/bend.sh prove osn/api/laws/account-deletion   # one set
```

`prove` and `check` also run `bend PROOF.bend --verdict` after each set when
this machine has Lean 4.34.0 (elan's toolchain for it, or `lean` on the PATH)
or `$BENDTT`; the first run builds the kernel, which takes minutes, and a
kernel built here is not checked against a pin. Without Lean they say once
that they skipped it. CI's `Bend proofs` job always runs it, with a kernel
whose SHA-256 `lean.env` pins. The pre-commit hook never runs it.

Not a Bun workspace: it installs nothing, and adding it to the root workspaces
would redeploy every surface.
