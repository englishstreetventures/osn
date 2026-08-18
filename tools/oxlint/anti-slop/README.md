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
```

Keep `oxlint` and `@oxlint/plugins` on the same version in `package.json` — the
plugin API is not stable across minors.

## Which rules are on

Severities live in the root `oxlintrc.json`, with the violation counts measured
when the plugin landed. Upstream ships all 15 rules at `error`; doing that here
meant 4686 diagnostics across 541 files, so the config is a ratchet — seven
rules are already `error`, five are `warn`, and three are `off` until someone
schedules the clean-up. Raising a tier is the point; lowering one is a decision
that belongs in a PR description.
