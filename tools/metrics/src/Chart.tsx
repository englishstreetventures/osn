import * as Plot from "@observablehq/plot";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

/**
 * The page's colour tokens, read off the container so a plot uses the same
 * dark values as the chrome around it rather than Plot's black-on-white
 * defaults. Plot takes colour strings, not `var()` references, which is why
 * they are resolved here.
 */
export interface ChartTheme {
  /** `--foreground`: text, axes, the median line. */
  ink: string;
  /** `--muted-foreground`: secondary strokes such as a box outline. */
  mutedInk: string;
  /** `--border`: grid lines. */
  border: string;
  /** `--card`: what the chart is drawn on; halos around marks use it. */
  surface: string;
}

interface ChartProps {
  /** Called with the container's width and theme every time the chart is (re)drawn. */
  options: (width: number, theme: ChartTheme) => Plot.PlotOptions;
}

function readTheme(element: Element): ChartTheme {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    ink: token("--foreground"),
    mutedInk: token("--muted-foreground"),
    border: token("--border"),
    surface: token("--card"),
  };
}

/**
 * Plot renders to a detached SVG, so this is a `ref` + `createEffect` wrapper:
 * the effect draws into the container and the cleanup removes the previous
 * node, so a redraw never stacks two figures. Width is read from the
 * container and tracked with a `ResizeObserver`, which is what makes a redraw
 * happen at all — the data behind every chart is static.
 */
export function Chart(props: ChartProps) {
  const [width, setWidth] = createSignal(0);
  let host!: HTMLDivElement;

  onMount(() => {
    setWidth(host.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const w = width();
    if (w === 0) return;
    const theme = readTheme(host);
    const node = Plot.plot({
      width: w,
      // Explicit, not inherited: Plot's own default is a white figure with
      // black text, and it sets both inline.
      style: { background: "transparent", color: theme.ink },
      ...props.options(w, theme),
    });
    host.replaceChildren(node);
    onCleanup(() => node.remove());
  });

  // `min-w-0` lets the host shrink inside a flex/grid parent, so the observed
  // width is the real one and the figure is drawn to fit rather than overflow.
  // `overflow-x-auto` is the repo's rule for anything wide: it scrolls in its
  // own box, never the page.
  return <div ref={host} class="w-full min-w-0 overflow-x-auto" />;
}
