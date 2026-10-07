import { createSignal, type JSX } from "solid-js";

import type { Module } from "../lib/dashboard-route";
import { type Tier, TIERS } from "../lib/tiers";
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
 * deliberate intent or as a broken button, and whether changing the tier
 * actually flips the rows. The last of those is not hypothetical: it is how the
 * `Show`-instead-of-a-ternary defect in `ModuleSidebar.tsx` was found, having
 * passed every test in the suite.
 *
 * **This bench cannot judge colour.** The lab does not resolve the portal's
 * colour ramp — every row here reports the same computed `color`, `text-gold-ink`
 * included, because the utilities for cire's `@theme` aliases are not emitted
 * into the stylesheet this page ends up using. Layout, placement, timing and
 * interaction are real; the fade is not, and `text-text-faint` looks like
 * `text-text-muted` here while differing in the app. Judge the fade in the
 * portal, at `https://<branch>.host.cire.localhost`.
 *
 * **The portal's stylesheet is deliberately NOT imported here.** A story file
 * must not import a stylesheet that declares a global `:root`, because the lab
 * imports every story module to build its sidebar — so such a block lands on
 * the page whatever story is open, and the last one loaded re-themes the whole
 * lab rather than this one bench. `cire/host`'s ramp maps the `--ui-*` contract
 * onto the portal's colours, so importing it here left every other story
 * rendering `@shared/ui` in cire's light palette, deaf to the light · dark
 * toggle. What this bench gives up by not importing it is the portal's shapes
 * and spacing; what it keeps is layout, placement, timing and interaction,
 * which is what it exists for.
 *
 * See `wiki/conventions/component-lab.md` and `wiki/cire/cire-entitlements.md`.
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
    <p class="font-body text-text-muted text-ui-sm max-w-prose leading-relaxed">{props.children}</p>
  );
}

interface Args {
  /** The wedding's plan tier. Gold unlocks Checklist, Budget and Registry;
   *  Crimson unlocks Vendors as well. */
  tier: Tier;
}

/** A select rather than free text: a tier the portal does not know is not a
 *  state the sidebar can be in. */
const controls = { tier: { kind: "select", options: TIERS } } as const;

/**
 * The wide surface. Every gated row starts locked, which is what a wedding on
 * Ivory, the free tier, sees.
 *
 * Rest a pointer on a locked row for three seconds, or tab to it and hold
 * focus for the same delay, or click it. All three open the same card, which
 * names the tier that includes the module; the click path is the only one a
 * touch device has, because the hover card ignores touch pointers outright.
 */
export const Rail = {
  args: { tier: "ivory" } satisfies Args,
  controls,
  render: (args: Args) => {
    const [active, setActive] = createSignal<Module>("overview");
    return (
      <div class="flex flex-col gap-5">
        <Guidance>
          Dwell three seconds on a locked row, or click it. Clicking navigates nowhere and clicking
          again closes the card — that is the whole response. Raise the tier in the panel and the
          rows it includes go back to being ordinary nav buttons. The rows will not look faded here:
          the lab does not resolve the portal's colour ramp, so judge the fade in the portal itself.
        </Guidance>
        <Shell width="60rem" wide>
          <ModuleSidebar
            weddingId="wed_test"
            weddingSlug="test-wedding"
            canManage={false}
            active={active()}
            tier={args.tier}
            onSelect={setActive}
          />
          <div class="border-border text-text-muted font-body text-ui-sm tracking-ui-wider flex min-h-64 flex-1 items-center justify-center rounded-sm border border-dashed uppercase">
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
  args: { tier: "gold" } satisfies Args,
  controls,
  render: (args: Args) => {
    const [active, setActive] = createSignal<Module>("overview");
    return (
      <div class="flex flex-col gap-5">
        <Guidance>
          Open Modules, then tap the locked Vendors row. On Gold, Registry beside it is open for
          contrast — one navigates and closes the sheet, the other offers Crimson and leaves it
          open. Stories are not framed, so the sheet's fixed panel lands over the lab's own chrome —
          use <strong>open</strong> for the clean view.
        </Guidance>
        <Shell width="22rem">
          <ModuleSidebar
            weddingId="wed_test"
            weddingSlug="test-wedding"
            canManage={false}
            active={active()}
            tier={args.tier}
            onSelect={setActive}
          />
        </Shell>
      </div>
    );
  },
};
