---
"@cire/web": patch
---

Dep-audit cleanup: drop two now-dead `--ignore` suppressions from the
pre-push `bun audit` gate (`lefthook.yml`) and refresh the cire security
backlog to match the actual `bun audit` state.

- `GHSA-77vg-94rm-hx3p` (devalue sparse-array DoS) — the root
  `overrides.devalue = "^5.8.1"` now resolves `devalue@5.8.1` and the advisory
  no longer appears in `bun audit` at any level. The `--ignore` was a dead
  suppression; **removed**. (`bunfig.toml`'s `minimumReleaseAge` is 3 days —
  the lefthook comment that read "14 days" was stale and is gone with the entry.)
- `GHSA-gv7w-rqvm-qjhr` (esbuild Deno-module binary-integrity RCE) — cleared by
  `esbuild@0.25.12` (resolved via `overrides.esbuild`), not the ≥0.28.1 the old
  note assumed. Absent from `bun audit` entirely; the `--ignore` was dead and is
  **removed**.

The two surviving ignores stay (still load-bearing, both **high**, both
dev/build-only with no Worker/production path): `GHSA-96hv-2xvq-fx4p` (ws DoS via
miniflare/happy-dom) and `GHSA-fx2h-pf6j-xcff` (vite `server.fs.deny` Windows
bypass, pinned below the patched line by the `overrides.vite ^7.3.2` Astro-Vite-7
constraint). The transitive `smol-toml`/`postcss`/`esbuild` moderate advisories
are also confirmed fully cleared via the existing overrides.

No source change. `bun install` re-resolves with zero lockfile drift; build,
test, typecheck, lint, fmt all green; the pre-push `bun audit --audit-level=high`
gate still exits 0 with the two remaining ignores.
