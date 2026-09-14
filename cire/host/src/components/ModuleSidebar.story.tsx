import { createSignal, type JSX } from "solid-js";

import type { Module } from "../lib/dashboard-route";

import "../styles/global.css";
import ModuleSidebar from "./ModuleSidebar";

/**
 * Rendered by the component lab (`bun run dev:lab`) — a story living next to
 * the component it exercises rather than in `tools/lab`. Nothing imports this
 * file at build time; the lab finds it by glob.
 *
 * It exists for the locked rows. The unit tier runs in happy-dom, which applies
 * no stylesheet and computes no layout, so what it can prove about them stops
 * at the DOM: that a timer fired, that a class is on an element, that a handler
 * did not run. What it cannot reach is whether the thing behaves — whether the
 * card lands beside the rail or over it, whether a three-second dwell reads as
 * deliberate intent or as a broken button, and whether toggling an entitlement
 * actually flips the row. The last of those is not hypothetical: it is how the
 * `Show`-instead-of-a-ternary defect in `ModuleSidebar.tsx` was found, having
 * passed every test in the suite.
 *
 * **This bench cannot judge colour.** The lab does not resolve the portal's
 * colour ramp — every row here reports the same computed `color`, `text-gold`
 * included, because the utilities for cire's `@theme` aliases are not emitted
 * into the stylesheet this page ends up using. Layout, placement, timing and
 * interaction are real; the fade is not, and `text-text-faint` looks like
 * `text-text-muted` here while differing in the app. Judge the fade in the
 * portal, at `https://<branch>.host.cire.localhost`.
 *
 * The portal's stylesheet is imported anyway, for the shapes and spacing that
 * do come through. It carries the portal's `:root`, so it re-themes the chrome
 * around the story — open a story with **open** (`?bare`) for the view without
 * it.
 *
 * See `wiki/conventions/component-lab.md` and `wiki/systems/cire-entitlements.md`.
 */
export const meta = { title: "cire/host/ModuleSidebar", layout: "padded" as const };

/**
 * One rule, and it is the lab's problem rather than the portal's.
 *
 * The lab brings its own Tailwind build and so does the portal, so two
 * stylesheets reach the page and the bundler decides their order. The portal's
 * lands first, which means the lab's plain `.hidden` outranks the portal's
 * `@2xl/shell:flex` at equal specificity and the rail never appears — in the
 * app there is one stylesheet and the question does not arise. Re-asserting the
 * rail's own rule inside the story's wrapper restores it without touching the
 * component or leaking past this bench.
 *
 * The sheet needs nothing: its `@2xl/shell:hidden` has no competitor.
 */
const RAIL_IN_LAB = `
  .lab-shell nav[aria-label="Wedding modules"] { display: flex; }
`;

/** What the shell supplies. `@2xl/shell` is what swaps the rail for the sheet,
 *  so a surface with no `@container/shell` ancestor renders neither. */
function Shell(props: { width: string; wide?: boolean; children: JSX.Element }) {
  return (
    <div class={`@container/shell ${props.wide ? "lab-shell" : ""}`} style={{ width: props.width }}>
      {props.wide ? <style>{RAIL_IN_LAB}</style> : null}
      <div class="flex gap-8">{props.children}</div>
    </div>
  );
}

/** A line of what-to-try, so the bench says what it is for without a reader
 *  having to find this file. */
function Guidance(props: { children: JSX.Element }) {
  return (
    <p class="font-body text-text-muted max-w-prose text-[0.8rem] leading-relaxed">
      {props.children}
    </p>
  );
}

interface Args {
  /** Hold the `vendors` entitlement — unlocks that row. */
  vendors: boolean;
  /** Hold the `registry` entitlement — unlocks that row. */
  registry: boolean;
}

function entitlementsFrom(args: Args): string[] {
  const held: string[] = [];
  if (args.vendors) held.push("vendors");
  if (args.registry) held.push("registry");
  return held;
}

/**
 * The wide surface. Both gated rows start locked, which is what a wedding on
 * the free tier sees.
 *
 * Rest a pointer on Vendors or Registry for three seconds, or tab to it and
 * hold focus for the same delay, or click it. All three open the same card;
 * the click path is the only one a touch device has, because the hover card
 * ignores touch pointers outright.
 */
export const Rail = {
  args: { vendors: false, registry: false },
  render: (args: Args) => {
    const [active, setActive] = createSignal<Module>("overview");
    return (
      <div class="flex flex-col gap-5">
        <Guidance>
          Dwell three seconds on Vendors or Registry, or click either. Clicking navigates nowhere
          and clicking again closes the card — that is the whole response. Turn an entitlement on in
          the panel and the row goes back to being an ordinary nav button. The rows will not look
          faded here: the lab does not resolve the portal's colour ramp, so judge the fade in the
          portal itself.
        </Guidance>
        <Shell width="60rem" wide>
          <ModuleSidebar
            active={active()}
            entitlements={entitlementsFrom(args)}
            onSelect={setActive}
          />
          <div class="border-border text-text-muted font-body flex min-h-64 flex-1 items-center justify-center rounded-sm border border-dashed text-[0.8rem] tracking-[0.08em] uppercase">
            {active()}
          </div>
        </Shell>
      </div>
    );
  },
};

/**
 * The narrow surface — the phone. Switch the viewport to **phone** and the
 * container query hands over to the sheet on its own.
 *
 * This is the surface the locked row was nearly dead on: the card's trigger
 * drops every touch pointer, so dwell is unreachable here and the tap has to
 * carry it. The sheet's nav also scrolls, which is why the card is portalled —
 * an in-flow one would be clipped by the row's own container.
 */
export const Sheet = {
  args: { vendors: false, registry: true },
  render: (args: Args) => {
    const [active, setActive] = createSignal<Module>("overview");
    return (
      <div class="flex flex-col gap-5">
        <Guidance>
          Open Modules, then tap the locked Vendors row. With `registry` held for contrast, the two
          rows sit next to each other — one navigates and closes the sheet, the other offers the
          upgrade and leaves it open. Stories are not framed, so the sheet's fixed panel lands over
          the lab's own chrome — use <strong>open</strong> for the clean view.
        </Guidance>
        <Shell width="22rem">
          <ModuleSidebar
            active={active()}
            entitlements={entitlementsFrom(args)}
            onSelect={setActive}
          />
        </Shell>
      </div>
    );
  },
};
