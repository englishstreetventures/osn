# thinking-orbs engine (vendored)

The drawing engine of [thinking-orbs](https://libraries.dev/orbs), from
[Jakubantalik/Libraries.dev](https://github.com/Jakubantalik/Libraries.dev),
`packages/thinking-orbs`, release 0.3.2,
pinned to commit `5e7afad5fc8f3661e0bf0b4cd3f87de482ffcf16` (2026-09-22).

`@shared/ui`'s `Orb` (`src/ui/orb.tsx`) draws with it. The engine is a painter
only: pure geometry over `(size, t, opts)` plus 2D-context calls. It imports
no package and touches no browser global; the wrapper owns the canvas, the
clock, the pauses and reduced motion.

## What is here

| Path | Source |
|---|---|
| `engine/*.ts` (11 files) | upstream `src/engine/`, verbatim |
| `presets.ts` | upstream `src/presets.ts`, verbatim; `engine/index.ts` and `engine/registry.ts` import it |
| `LICENSE` | upstream `packages/thinking-orbs/LICENSE`, verbatim (MIT) |
| `types.ts` | ours: the two aliases the engine and presets import, `OrbState` and `OrbSize`, copied verbatim from upstream `src/types.ts`. Upstream's file also imports `react`, which this repository does not carry |
| `README.md`, `SHA256SUMS` | ours |

Nothing upstream is edited. `oxlintrc.json` ignores this directory, and
`.oxfmtrc.json` and `lefthook.yml` keep the formatter off it, so a re-vendor is
a plain overwrite with no formatting noise in the diff. `types.ts` keeps
upstream's `OrbSize = 64 | 32 | 20`; `Orb` itself takes only `20 | 64`, the
two sizes upstream tuned by hand.

`engine/core.ts` declares a parameter it never reads (`rMin` in `paint()`),
which fails the type check of any consumer that sets `noUnusedParameters`. So
no consumer reads this tree: `@shared/ui`'s `./ui/orb` export points
TypeScript at `src/ui/orb-api.ts`, a types-only module, and only the bundler
follows `src/ui/orb.tsx` in here.

thinking-orbs is also published on npm. Vendoring takes it out of reach of any
scanner keyed on `bun.lock`, so whoever re-vendors checks the upstream
repository's issues and the npm package's advisories first.

## Checking the tree against upstream

`SHA256SUMS` lists every tracked file here, so CI's checksum half proves only
that the tree matches its own manifest. This command proves the 13 upstream
files are upstream's, byte for byte, at the pinned commit. Run it from the
repository root; it prints `OK` for each of the 13:

```bash
pin=5e7afad5fc8f3661e0bf0b4cd3f87de482ffcf16
d=$(mktemp -d) && mkdir -p "$d/engine"
base="https://raw.githubusercontent.com/Jakubantalik/Libraries.dev/$pin/packages/thinking-orbs"
for f in braid core index lattice morph orbits profiles registry ribbon types web; do
  curl -fsSL "$base/src/engine/$f.ts" -o "$d/engine/$f.ts"
done
curl -fsSL "$base/src/presets.ts" -o "$d/presets.ts"
curl -fsSL "$base/LICENSE" -o "$d/LICENSE"
grep -v -e '  README.md$' -e '  types.ts$' shared/ui/vendor/thinking-orbs/SHA256SUMS > "$d/SHA256SUMS"
(cd "$d" && shasum -a 256 -c SHA256SUMS)
```

The `grep` drops the two repo-authored files from the list; `SHA256SUMS` does
not list itself. Upstream's repository is over 100 MB, so the command fetches
the files one by one rather than a tarball.

## Re-vendoring

From the repository root, with `$d` filled by the command above at the new
commit:

```bash
v=shared/ui/vendor/thinking-orbs
rm -rf "$v/engine" && mkdir "$v/engine"
cp "$d"/engine/*.ts "$v/engine/"
cp "$d/presets.ts" "$d/LICENSE" "$v/"
# Update types.ts if upstream's OrbState or OrbSize changed, and move the pin
# line at the top of this file.
git add -A "$v"
(cd "$v" && git ls-files | grep -v '^SHA256SUMS$' | LC_ALL=C sort \
  | xargs shasum -a 256 > SHA256SUMS)
git add "$v/SHA256SUMS"
```

The manifest comes from `git ls-files`, the same list the guard checks it
against, so an untracked file such as a `.DS_Store` never enters it. If
upstream's `src/engine/` gains or loses a file, change the list in the fetch
command too.

`scripts/verify-vendored.sh shared/ui/vendor/thinking-orbs` is the guard; CI's
`script-tests` job runs it on every tree that has a `SHA256SUMS`. It fails when
a file differs from the manifest, the tracked file set differs from it, a file
is anything but `100644` (or `120000` for a symlink), or, on a pull request, a
file other than `README.md` and `SHA256SUMS` changed while the pin line above
did not. A re-vendor moves the pin; an edit to upstream code never happens
here.
