import { For } from "solid-js";

import { Icon, type IconName } from "./Icon";

/**
 * Rendered by the component lab (`bun run dev:lab`) — a story living next to
 * the component it exercises rather than in `tools/lab`. Nothing imports this
 * file at build time; the lab finds it by glob.
 *
 * See `wiki/conventions/component-lab.md`.
 */
export const meta = { title: "pulse/Icon", layout: "padded" as const };

const NAMES: IconName[] = [
  "bell",
  "chevron-right",
  "clock",
  "filter",
  "globe",
  "heart",
  "instagram",
  "layers",
  "map-pin",
  "plus",
  "repeat",
  "search",
  "zap",
];

/** Every glyph in the set, at the three sizes Pulse actually draws them. */
export const Glyphs = () => (
  <div class="flex flex-col gap-6">
    <For each={[16, 20, 24]}>
      {(size) => (
        <div class="flex flex-col gap-2">
          <span class="text-meta text-subtle tracking-wide uppercase">{size}px</span>
          <div class="flex flex-wrap gap-4">
            <For each={NAMES}>
              {(name) => (
                <div class="text-muted-foreground flex w-20 flex-col items-center gap-1.5">
                  <Icon name={name} size={size} />
                  <span class="text-meta text-subtle">{name}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </For>
  </div>
);

/**
 * An unrecognised name renders nothing rather than throwing — `name` is a
 * plain string at every call site, so a typo must not take a page down.
 */
export const UnknownName = () => (
  <div class="text-muted-foreground flex items-center gap-3">
    <span class="border-border rounded-md border border-dashed p-3">
      <Icon name="not-a-real-icon" size={24} />
    </span>
    <span class="text-body">Renders nothing. No throw.</span>
  </div>
);
