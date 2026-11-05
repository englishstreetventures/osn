#!/usr/bin/env bash
# Make a seal-colour row for the host portal's invite builder, a reviewable
# branch diff.
#
# The base is the pinned commit as it stands. The branch adds one component,
# `cire/host/src/components/invite/SealColourPicker.tsx`, renames the heading
# of `EnvelopePicker.tsx` beside it and adds a changeset. The shared
# components the new file should have used — `Eyebrow`, `Button`'s `choice`
# variant — are on the base, out of the diff, where a reviewer has to go and
# find them. The rename uses `perl -pi`, which behaves the same on GNU and BSD.
#
# The ground truth is in `graders/` and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git c8b1b0d004fb4b697d970d2072bd758fbb793265
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-envelope-seal-colour

perl -pi -e 's{uppercase">Envelope</h3>}{uppercase">Envelope and seal</h3>}' \
  cire/host/src/components/invite/EnvelopePicker.tsx
grep -q 'uppercase">Envelope and seal</h3>' cire/host/src/components/invite/EnvelopePicker.tsx

cat > cire/host/src/components/invite/SealColourPicker.tsx <<'VIEW'
/**
 * The wax seal's colour, under the envelope picker: one swatch per colour in
 * `SEALS`, chosen and saved at once, as an envelope is. A wedding that may not
 * use premium envelopes sees the row and a note saying they come with Crimson.
 */

import { Notice } from "@shared/ui/ui/notice";
import { For, Show } from "solid-js";

/** The colours a seal is pressed in. Each `hex` is the wax itself. */
const SEALS = [
  { id: "crimson", name: "Crimson", hex: "#8b1a1a" },
  { id: "forest", name: "Forest", hex: "#1f4d2b" },
  { id: "midnight", name: "Midnight", hex: "#1b2340" },
  { id: "gold", name: "Gold", hex: "#b08d3c" },
] as const;

export type SealId = (typeof SEALS)[number]["id"];

export default function SealColourPicker(props: {
  /** Whether the wedding may use premium envelopes now (`envelopeEntitled`). */
  entitled: boolean;
  /** The saved seal colour. */
  currentId: SealId;
  saving: boolean;
  onSelect: (sealId: SealId) => void;
}) {
  return (
    <div class="flex flex-col gap-3">
      <h3 class="font-body text-gold-ink text-ui-xs tracking-ui-wider uppercase">Seal colour</h3>
      <p class="font-body text-text-muted text-ui-sm">Choose a colour for the seal.</p>
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Seal colour">
        <For each={SEALS}>
          {(seal) => {
            const checked = () => props.currentId === seal.id;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={checked()}
                aria-label={seal.name}
                aria-disabled={!props.entitled || props.saving ? "true" : undefined}
                onClick={() => {
                  if (!props.entitled) return;
                  props.onSelect(seal.id);
                }}
                class="border-border size-8 rounded-full border transition-colors aria-disabled:opacity-50"
                classList={{ "ring-gold ring-2 ring-offset-2": checked() }}
                style={{ "background-color": seal.hex }}
              />
            );
          }}
        </For>
      </div>
      <Show when={!props.entitled}>
        <Notice tone="accent" size="sm">
          Seal colours come with Crimson.
        </Notice>
      </Show>
    </div>
  );
}
VIEW

cat > .changeset/cire-seal-colour.md <<'CHANGESET'
---
"@cire/host": patch
---

Organisers can choose the colour of the envelope's wax seal, under the envelope
picker in the invite builder. A wedding without Crimson sees the row locked.
CHANGESET

git add -A
git commit -qm "feat(cire-host): let organisers choose the wax seal's colour"

git config branch.feat/cire-envelope-seal-colour.gh-merge-base main
