#!/usr/bin/env bash
# Every Vitest config that loads `vite-plugin-solid` must also name jest-dom.
#
# The plugin prepends `@testing-library/jest-dom/vitest` to `setupFiles` unless
# some entry's path already matches /jest-dom/ (`getJestDomExport` in its
# `dist/esm/index.mjs`). `shared/test-config/no-jest-dom.ts` exists to be that
# entry. Delete the setup line and the injection comes back silently — every
# gate stays green and every Solid package pays for the matchers again.
#
# A grep, not a resolver: this job installs nothing, so the config is text. It
# matches the import statement rather than the plugin's bare name, so a config
# that only mentions the plugin in prose is not asked for a marker it does not
# need. Naming jest-dom in a comment and nowhere else would still satisfy the
# second grep, which is the price of not running a bundler here. It catches the
# deletion, which is the way this actually regresses.
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel)}"
checked=0
failed=0

while IFS= read -r config; do
  if ! grep -qE 'from ["'"'"']vite-plugin-solid["'"'"']' "$config"; then
    continue
  fi
  checked=$((checked + 1))
  if ! grep -q "jest-dom" "$config"; then
    printf '%s: imports vite-plugin-solid but never names jest-dom.\n' "${config#"$root"/}" >&2
    printf '  Add `setupFiles: ["<relative path>/shared/test-config/no-jest-dom.ts"]` to the test config.\n' >&2
    failed=$((failed + 1))
  fi
done < <(find "$root" -name "vitest.config.ts" -not -path "*/node_modules/*" -not -path "*/.git/*" | sort)

if [ "$failed" -gt 0 ]; then
  printf '\n%d of %d Solid vitest configs would take the injected jest-dom setup.\n' "$failed" "$checked" >&2
  exit 1
fi

printf '%d Solid vitest configs checked, jest-dom suppression intact.\n' "$checked"
