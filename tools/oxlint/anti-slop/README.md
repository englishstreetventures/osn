# anti-slop (vendored)

Oxlint plugin from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
pinned to commit `446268e5d15baa968eaec669ff65358d36ae6259` (2026-08-14).

Upstream publishes no package — it is meant to be copied in, so this directory
is a verbatim copy of the repo's `src/` with its `*.test.ts` files dropped.
Nothing here is edited: `oxlintrc.json` ignores the directory and `lefthook.yml`
keeps `oxfmt` off it, so a re-vendor is a plain overwrite with no formatting
noise in the diff.

## Re-vendoring

```bash
curl -sL https://github.com/dmmulroy/anti-slop/archive/<sha>.tar.gz | tar xz
rm -rf tools/oxlint/anti-slop/{index.ts,rules,shared}
cp -R anti-slop-<sha>/src/. tools/oxlint/anti-slop/
rm -f tools/oxlint/anti-slop/rules/*.test.ts
curl -sL https://raw.githubusercontent.com/dmmulroy/anti-slop/<sha>/LICENSE \
  -o tools/oxlint/anti-slop/LICENSE
(cd tools/oxlint/anti-slop && find . ! -type d ! -name SHA256SUMS | sed 's|^\./||' | \
  LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS)
```

The `sed` strips `find`'s leading `./` — the committed `SHA256SUMS` lists bare paths
like `index.ts`, not `./index.ts`, so a `find .`-based recipe with no `sed` produces a
file that hashes identically but diffs on every line. `LC_ALL=C` pins the sort order
so the recipe reproduces the same byte order on any machine's locale.

`! -type d`, not `-type f`: the checker compares this list against `git ls-files`,
which lists a symlink like any other tracked path, while `-type f` silently skips
one. Generator and checker have to agree on what counts as a file, or a vendored
symlink shows up as a spurious diff on the next run.

Modes are checked separately, and as an invariant rather than a manifest: every
tracked file here must be `100644`, or `120000` for a symlink. `shasum` hashes
contents and the file-set diff compares names, so a flip from `100644` to
`100755` used to pass both. Nothing in this tree is executed — oxlint imports
the modules — so the bit changes nothing at runtime; what it changed was the
truth of the claim that this directory is byte-for-byte what was reviewed.

Asserting the invariant rather than recording modes in `SHA256SUMS` keeps that
file a plain `shasum -c`-readable manifest and means the recipe above needs no
second column. A re-vendor that genuinely brings an executable file fails the
check — which is the point: it is a thing to look at, not to wave through.

Keep `oxlint` and `@oxlint/plugins` on the same version in `package.json` — the
plugin API is not stable across minors.

Upstream is MIT (`LICENSE`, vendored verbatim). `SHA256SUMS` covers every
tracked file in this directory and must be regenerated on every re-vendor —
CI (`ci.yml`) runs `shasum -c` against it, so a re-vendor that skips this step
fails the next PR that touches anything else in the repo.

## Which rules are on

Severities live in the root `oxlintrc.json`, with the violation counts measured
when the plugin landed. Upstream ships all 15 rules at `error`; doing that here
meant 4686 diagnostics across 541 files, so the config is a ratchet — seven
rules are already `error`, five are `warn`, and three are `off` until someone
schedules the clean-up. Raising a tier is the point; lowering one is a decision
that belongs in a PR description.
