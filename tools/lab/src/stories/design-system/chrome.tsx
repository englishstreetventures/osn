/**
 * The furniture the design-system stories share: a page frame, section
 * headings, a swatch that measures its own paint, and a contrast cell that
 * measures its own ratio.
 *
 * Everything here is painted in `ui-*` utilities rather than in the lab's own
 * (musubi) vocabulary, and that is deliberate: a label inside a subtree that
 * redefines the contract must follow that subtree, or the theming story would
 * show cire's components under musubi's captions.
 *
 * Not a story file — the registry globs `*.story.tsx` only — so exports here
 * do not appear in the sidebar.
 */

import type { Oklch } from "@shared/color";
import { createEffect, createSignal, type JSX, Show } from "solid-js";

import {
  computed,
  type Contrast,
  contrastOf,
  describe,
  paintedColor,
  themeVersion,
} from "./measure.ts";

/** Something the parent can change that should re-measure a child — an arg, a theme name. */
export type Revision = () => string | number | boolean;

export function Gallery(props: { title: string; intro: JSX.Element; children: JSX.Element }) {
  return (
    <div class="max-w-ui-3xl font-ui-body mx-auto flex flex-col pb-16">
      <header class="pb-4">
        <h1 class="text-ui-xl tracking-ui-tight text-ui-ink font-semibold">{props.title}</h1>
        <div class="max-w-ui-lg text-ui-base leading-ui-normal text-ui-ink-secondary mt-2">
          {props.intro}
        </div>
      </header>
      {props.children}
    </div>
  );
}

export function Section(props: { title: string; eyebrow?: string; children: JSX.Element }) {
  return (
    <section class="border-ui-hairline flex flex-col gap-4 border-t py-6">
      <div class="flex flex-col gap-1">
        <Show when={props.eyebrow}>
          <Eyebrow>{props.eyebrow}</Eyebrow>
        </Show>
        <h2 class="text-ui-md text-ui-ink font-semibold">{props.title}</h2>
      </div>
      {props.children}
    </section>
  );
}

/** The rule a token carries, stated next to the thing it governs. */
export function Rule(props: { children: JSX.Element }) {
  return (
    <p class="max-w-ui-lg text-ui-base leading-ui-normal text-ui-ink-secondary">{props.children}</p>
  );
}

export function Eyebrow(props: { children: JSX.Element }) {
  return (
    <span class="text-ui-xs tracking-ui-wider text-ui-ink-secondary uppercase">
      {props.children}
    </span>
  );
}

export function Mono(props: { children: JSX.Element; muted?: boolean }) {
  return (
    <code
      class="font-ui-mono text-ui-xs"
      classList={{ "text-ui-ink": !props.muted, "text-ui-ink-secondary": props.muted === true }}
    >
      {props.children}
    </code>
  );
}

/** A caption row: what it is called, and what it measured. */
export function Caption(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-0.5">
      <div>{props.name}</div>
      <div class="text-ui-xs text-ui-ink-secondary tabular-nums">{props.value}</div>
    </div>
  );
}

/**
 * One computed property of an element, kept current across theme flips. The
 * `of` accessor is read inside the effect, after mount, so a `let el!:` ref
 * assigned during render is safe to hand in.
 */
export function Readout(props: {
  of: () => Element | undefined;
  property: string;
  revision?: Revision;
}) {
  const [value, setValue] = createSignal("");
  createEffect(() => {
    themeVersion();
    props.revision?.();
    const raw = computed(props.of(), props.property);
    setValue(raw === "" ? "unmeasured" : raw);
  });
  return <span class="tabular-nums">{value()}</span>;
}

export type SwatchKind = "fill" | "ink" | "edge";

const KIND_PROPERTY = {
  fill: "background-color",
  ink: "color",
  edge: "border-top-color",
} satisfies Record<SwatchKind, string>;

/**
 * A token, shown as what it is: a fill is a painted box, an ink is a word, an
 * edge is a border. Each measures the property it demonstrates from its own
 * element, so the caption is what the browser painted, not what the CSS says.
 *
 * `on` is the ground behind an ink or edge swatch; it defaults to the page
 * ground, and an on-fill ink (`--ui-on-accent`) is shown on its own fill.
 */
export function Swatch(props: {
  token: string;
  kind?: SwatchKind;
  /** The utility spelling shown under the token, e.g. `bg-ui-ground`. */
  utility?: string;
  on?: string;
  revision?: Revision;
}) {
  let box!: HTMLDivElement;
  const kind = () => props.kind ?? "fill";
  const [painted, setPainted] = createSignal<Oklch | null>(null);

  createEffect(() => {
    themeVersion();
    props.revision?.();
    setPainted(paintedColor(box, KIND_PROPERTY[kind()]));
  });

  const style = (): JSX.CSSProperties => {
    const ground = `var(${props.on ?? "--ui-ground"})`;
    switch (kind()) {
      case "fill":
        return { "background-color": `var(${props.token})` };
      case "ink":
        return { color: `var(${props.token})`, "background-color": ground };
      case "edge":
        return { "border-color": `var(${props.token})`, "background-color": ground };
    }
  };

  return (
    <div class="flex w-40 flex-col gap-2">
      <div
        ref={box}
        class="rounded-ui-md border-ui-hairline text-ui-lg flex h-14 items-center justify-center border font-semibold"
        classList={{ "border-2": kind() === "edge" }}
        style={style()}
      >
        <Show when={kind() === "ink"}>Aa</Show>
      </div>
      <Caption
        name={
          <div class="flex flex-col">
            <Mono>{props.token}</Mono>
            <Show when={props.utility}>
              <Mono muted>{props.utility}</Mono>
            </Show>
          </div>
        }
        value={describe(painted())}
      />
    </div>
  );
}

type Verdict =
  | { kind: "ok"; contrast: Contrast }
  | { kind: "translucent" }
  | { kind: "unmeasured" };

/**
 * `fg` painted on `bg`, with the ratio measured from the cell itself and
 * written inside it in the same ink — if the number is hard to read, that is
 * the finding. The verdict below the cell is in page ink so a failing pair is
 * still reported legibly.
 */
export function ContrastCell(props: {
  fg: string;
  bg: string;
  min: number;
  sample?: string;
  revision?: Revision;
}) {
  let cell!: HTMLDivElement;
  const [verdict, setVerdict] = createSignal<Verdict>({ kind: "unmeasured" });

  createEffect(() => {
    themeVersion();
    props.revision?.();
    const fg = paintedColor(cell, "color");
    const bg = paintedColor(cell, "background-color");
    if (!fg || !bg) {
      setVerdict({ kind: "unmeasured" });
      return;
    }
    const contrast = contrastOf(fg, bg);
    setVerdict(contrast ? { kind: "ok", contrast } : { kind: "translucent" });
  });

  const measured = (): Contrast | undefined => {
    const v = verdict();
    return v.kind === "ok" ? v.contrast : undefined;
  };
  const passes = () => {
    const c = measured();
    return c !== undefined && c.ratio >= props.min;
  };

  return (
    <div class="flex flex-col gap-1">
      <div
        ref={cell}
        class="rounded-ui-sm border-ui-hairline flex h-16 flex-col justify-between border px-3 py-2"
        style={{ color: `var(${props.fg})`, "background-color": `var(${props.bg})` }}
      >
        <span class="text-ui-md leading-ui-none font-semibold">{props.sample ?? "Aa"}</span>
        <span class="text-ui-xs tabular-nums">
          <Show when={measured()}>{(c) => `${c().ratio.toFixed(2)}:1`}</Show>
        </span>
      </div>
      <div
        class="text-ui-xs tabular-nums"
        classList={{
          "text-ui-ink-secondary": measured() === undefined || passes(),
          "text-ui-danger": measured() !== undefined && !passes(),
        }}
      >
        <Show when={measured()}>
          {(c) => (
            <>
              <span aria-hidden="true">{passes() ? "✓" : "✕"}</span> {passes() ? "clears" : "fails"}{" "}
              {props.min}:1
              <Show when={c().composited}> · composited</Show>
            </>
          )}
        </Show>
        <Show when={verdict().kind === "translucent"}>translucent ground — not measurable</Show>
        <Show when={verdict().kind === "unmeasured"}>unmeasured</Show>
      </div>
    </div>
  );
}
