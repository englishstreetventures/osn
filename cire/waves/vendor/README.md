# Distortion Waves core (vendored)

The framework-free core of Distortion Waves, from
[Jakubantalik/Libraries.dev](https://github.com/Jakubantalik/Libraries.dev),
`packages/distortion-waves`, version 0.1.0,
pinned to commit `371b324a253b8ee71b9ce1bc8a1ecc5a59e1a16a` (2026-11-17).

`@cire/waves`' `DistortionWave` (`src/distortion/DistortionWave.tsx`), a Solid
port of upstream's React wrapper, drives it. The four modules import only each
other: `controller.ts` runs the wave over live DOM, `capture.ts` pictures an
element for the lens, `model.ts` holds the wave's maths and palettes, and
`renderer.ts` draws it with WebGL 2.

## What is here

| Path | Source |
|---|---|
| `capture.ts`, `controller.ts`, `model.ts`, `renderer.ts` | upstream `src/`, verbatim |
| `LICENSE` | upstream `packages/distortion-waves/LICENSE`, verbatim (MIT, Copyright (c) 2026 Jakub Antalik) |
| `README.md`, `SHA256SUMS` | ours |

Not copied: upstream's `src/DistortionWave.tsx` (React; `@cire/waves` ports it
to Solid), `src/index.ts` (the package's own entry replaces it), and the
SwiftUI port, demo and build files.

Nothing upstream is edited. `oxlintrc.json` ignores this directory, and
`.oxfmtrc.json` and `lefthook.yml` keep the formatter off it, so a re-vendor is
a plain overwrite with no formatting noise in the diff. The house rules do not
reach it either: `controller.ts` keeps upstream's one `console.warn`, which
fires when the browser will not picture the element and the wave runs without
its lens.

The code is MIT; the rest of `@cire/waves` is ours and `UNLICENSED`, as its
`package.json` says. A bundle that includes this code carries the notice: the
wrapper imports `LICENSE` as text (`?raw`) and holds it as
`DistortionWave.licence`, a string the chunk keeps while the component ships.
A comment would not do: a minified Vite 8 build keeps no comment, legal ones
included. `tests/hooks.test.ts` builds the package for production and fails if
any line of `LICENSE` is missing from the bundle; a re-vendor that changes
`LICENSE` changes what ships with it.

Distortion Waves is not on npm (`npm view distortion-waves` answered 404 on
2026-11-18), so no scanner keyed on `bun.lock` watches it. Whoever re-vendors
reads the upstream repository's issues and commits since the pin first. A
change to this tree asks the code owner of `cire/waves/vendor/`
(`.github/CODEOWNERS`) for review, and whoever merges it runs the check below
first.

## Checking the tree against upstream

`SHA256SUMS` lists every tracked file here, so CI's checksum half proves only
that the tree matches its own manifest. This command proves the 5 upstream
files are upstream's, byte for byte, at the pinned commit. Run it from the
repository root; it prints `OK` for each of the 5:

```bash
pin=371b324a253b8ee71b9ce1bc8a1ecc5a59e1a16a
d=$(mktemp -d)
base="https://raw.githubusercontent.com/Jakubantalik/Libraries.dev/$pin/packages/distortion-waves"
for f in capture controller model renderer; do
  curl -fsSL "$base/src/$f.ts" -o "$d/$f.ts"
done
curl -fsSL "$base/LICENSE" -o "$d/LICENSE"
grep -v -e '  README.md$' cire/waves/vendor/SHA256SUMS > "$d/SHA256SUMS"
(cd "$d" && shasum -a 256 -c SHA256SUMS)
```

The `grep` drops the one repo-authored file from the list; `SHA256SUMS` does
not list itself. Upstream's repository is over 100 MB, so the command fetches
the files one by one rather than a tarball.

## Re-vendoring

From the repository root, run the fetch lines of the command above, from
`pin=` through the `LICENSE` download, with `pin` set to the new commit. Skip
its last two lines: they check the files against the old manifest, and every
changed file would print `FAILED`. Then:

```bash
v=cire/waves/vendor
cp "$d"/*.ts "$d/LICENSE" "$v/"
# Move the pin line at the top of this file, then:
git add -A "$v"
(cd "$v" && git ls-files | grep -v '^SHA256SUMS$' | LC_ALL=C sort \
  | xargs shasum -a 256 > SHA256SUMS)
git add "$v/SHA256SUMS"
```

Then run `bun run --cwd cire/waves test:browser`, `bun run --cwd cire/waves
test:run` and the `cire-soft-shapes` E2E flow, which holds the invite
builder's wave checks (`tools/e2e/tests/support/cire-preview-wave.ts`; run
`bun run test:e2e --grep cire-soft-shapes`): the wrapper reads the
controller's `debug` and calls `update`, `setRevealedLayer`, `play` and
`reverse` (its crossfade after a throw), `reset` and `destroy`, and a renamed
option breaks it without a type error only where the wrapper passes it
through.

The manifest comes from `git ls-files`, the same list the guard checks it
against, so an untracked file such as a `.DS_Store` never enters it. If
upstream's `src/` gains or loses a module, change the list in the fetch
command too.

`scripts/verify-vendored.sh cire/waves/vendor` is the guard; CI's
`script-tests` job runs it on every tree `scripts/vendored-trees.txt` lists,
this one included. It fails when a file differs from the manifest, the tracked
file set differs from it, a file is anything but `100644` (or `120000` for a
symlink), or, on a pull request, a file other than `README.md` and
`SHA256SUMS` changed while the pin line above did not. A re-vendor moves the
pin; an edit to upstream code never happens here.
