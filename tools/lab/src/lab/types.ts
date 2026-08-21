import type { JSX } from "solid-js";

/**
 * What a live control can edit, and therefore what an arg is allowed to be.
 * Keeping this to primitives is the whole reason the args panel can be
 * generated without a schema — anything richer (a callback, a data fixture)
 * belongs in the story's own closure, where it is plain code rather than a
 * value the panel has to guess an editor for.
 */
export type ArgValue = string | number | boolean;

export type StoryArgs = Record<string, ArgValue>;

/**
 * How a control renders in the args panel. Anything not given an explicit
 * spec is inferred from the initial value in `args` — see `inferControl`.
 */
export type ControlSpec =
  | { kind: "text" }
  | { kind: "textarea" }
  | { kind: "number"; min?: number; max?: number; step?: number }
  | { kind: "range"; min: number; max: number; step?: number }
  | { kind: "boolean" }
  | { kind: "color" }
  | { kind: "select"; options: readonly (string | number)[] };

export type Controls<A extends StoryArgs> = { [K in keyof A]?: ControlSpec };

/**
 * `centered`  — the default. One component, parked in the middle.
 * `padded`    — flows from the top-left with breathing room. Layout work.
 * `fullscreen`— no chrome, no padding. Canvases and whole screens.
 */
export type StoryLayout = "centered" | "padded" | "fullscreen";

export interface Story<A extends StoryArgs = StoryArgs> {
  /** Overrides the export name in the sidebar. */
  name?: string;
  layout?: StoryLayout;
  /** Initial values. Each key becomes a live control in the right-hand panel. */
  args?: A;
  /** Override the inferred control for any arg. */
  controls?: Controls<A>;
  render: (args: A) => JSX.Element;
}

/**
 * A story file exports either full `Story` objects or bare components, so the
 * quickest possible spike is `export const Thing = () => <div />`.
 */
export type StoryExport = Story | (() => JSX.Element);

/** Optional per-file defaults, as `export const meta = { ... }`. */
export interface StoryMeta {
  /** Overrides the path-derived sidebar title, e.g. `"osn/ui/Button"`. */
  title?: string;
  layout?: StoryLayout;
}

/**
 * A loaded story file. Every export other than `meta` is read as a story,
 * which is what makes the zero-config case work — and is worth knowing before
 * you export a helper from a story file.
 */
export type StoryModule = { meta?: StoryMeta } & {
  [exportName: string]: StoryExport | StoryMeta | undefined;
};

/** One selectable entry in the sidebar: a single export of a single file. */
export interface StoryEntry {
  id: string;
  /** Everything before the last segment — the sidebar grouping. */
  title: string;
  /** The leaf label. */
  name: string;
  file: string;
  story: Story;
  layout: StoryLayout;
}
