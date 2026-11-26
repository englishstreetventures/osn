# tools/deletion-laws

The account-deletion rules as a Bend 2 model, the laws proved about it, and the
model compiled to `model.mjs` for the agreement tests in `osn/api/tests/laws` and
`cire/api/tests/laws`. What each law says, the code that keeps it, what the
proofs do not show and how to run them: `wiki/osn/account-deletion-laws.md`.

```bash
bash tools/deletion-laws/bend.sh install     # the Bend release bend.env pins, SHA-256 checked
bash tools/deletion-laws/bend.sh guide       # how to write Bend 2 (never run bend bare: it pings bend-lang.com)
bun run --cwd tools/deletion-laws prove      # bend PROOF.bend
bun run --cwd tools/deletion-laws check      # prove, and check model.mjs is what model.bend builds
bun run --cwd tools/deletion-laws build      # rebuild model.mjs after changing a .bend file
```

Not a Bun workspace: it installs nothing, and adding it to the root workspaces
would redeploy every surface.
