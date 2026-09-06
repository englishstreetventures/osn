# Checking wikilinks resolve on a branch

Reference for `prep-pr` Step 7.

**Then check the links you just wrote resolve.** A new page whose `related` points at nothing, or a `[[wikilink]]` with a typo, is invisible until someone clicks it. `mcp__obsidian-wiki__find_broken_links` is the right tool but the wrong tree — it indexes `main`, so it cannot see this branch's pages at all. Check locally instead:

```bash
# every wikilink target on the branch, minus every page that exists
# both sides reduced to a bare page name, since links come in both
# `[[arc-tokens]]` and `[[systems/arc-tokens]]` form
comm -23 \
  <(git diff "$BASE"...HEAD --name-only -- 'wiki/**/*.md' \
      | xargs -r grep -oh '\[\[[^]|#]*' | sed 's/^\[\[//; s#.*/##' | sort -u) \
  <(find wiki -name '*.md' | xargs -n1 basename | sed 's/\.md$//' | sort -u)
```

Every line of output is a link that resolves to nothing — fix it or drop it. Two things that look like breaks and aren't: a TOML array header inside a fenced code block (`[[env.<name>.d1_databases]]`) has the same shape as a wikilink and gets picked up, and a link ending in a stray `\` is a typo in the source, not a missing page. Run `find_broken_links` / `find_orphaned_notes` over the MCP **after** the PR merges, when `main` has caught up, to sweep the rot this branch didn't cause.
