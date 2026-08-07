/**
 * The persistent composed preview: the whole guest invite as one continuous
 * column — hero, Our Story, Code Entry & Welcome, Events, Closing — in guest
 * scroll order, on their tone surfaces, styled with the same derived tokens
 * the guest site consumes. Shown as a sticky side pane at the builder's wide
 * breakpoint (the inline per-section previews take over on narrow layouts).
 * This is where the tone rhythm down the page — the whole point of the tone
 * system — is actually visible while editing.
 *
 * Sections the guest site would hide (empty hero/story/closing) render as a
 * labelled placeholder strip, mirroring the section cards' Shown/Hidden badges.
 *
 * The pane follows the wedding's DESIGN PACK as well as its scheme: hero
 * anchoring, copy alignment, the code-entry panel and the events rule all come
 * from `design-layout.ts`, so switching Classic → Gala visibly re-shapes the
 * miniature instead of leaving it a centred stack with new radio card.
 */

import { DESIGNS } from "@cire/invite-designs";
import { createSignal, Show } from "solid-js";

import type { ImageCrop } from "../../lib/image-crop";
import { designLayout } from "./design-layout";
import { DEFAULTS, sampleCopy, type ThemeSection } from "./model";
import { DeviceToggle, HeroSample, type PreviewDevice, SectionSample } from "./previews";

export interface PreviewPaneProps {
  tokens: Record<string, string>;
  toneSurface: (section: ThemeSection) => string;
  /** The wedding's design pack id (`classic` / `gala` / …). */
  design: string;
  hero: {
    shown: boolean;
    imageUrl: string | null;
    crop: ImageCrop | null;
    cropMobile: ImageCrop | null;
    title: string;
    heroBlur: number;
    backdropOpacity: number;
    backdropBlur: number;
  };
  story: { shown: boolean; eyebrow: string; heading: string; body: string };
  welcome: { message: string };
  events: { eyebrow: string; heading: string };
  closing: {
    shown: boolean;
    message: string;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
  };
}

export default function PreviewPane(props: PreviewPaneProps) {
  const [device, setDevice] = createSignal<PreviewDevice>("desktop");
  const layout = () => designLayout(props.design);
  /** The catalog's display name for the pack, falling back to the raw id for a
   *  design this build's catalog doesn't carry (mid-deploy). */
  const designName = () => DESIGNS.find((d) => d.id === props.design)?.name ?? props.design;
  const heroCrop = () =>
    device() === "phone" ? (props.hero.cropMobile ?? props.hero.crop) : props.hero.crop;

  const hiddenStrip = (label: string) => (
    <div
      class="p-2 text-center text-[0.6rem] tracking-[0.12em] uppercase"
      style={{ color: "var(--color-text-muted)", "background-color": "var(--color-bg)" }}
    >
      {label} — hidden until it has content
    </div>
  );

  return (
    <div class="flex flex-col gap-2">
      <span class="flex items-center justify-between gap-2">
        <span class="font-body text-text-muted text-[0.8rem]">Live invite preview</span>
        <DeviceToggle value={device()} onChange={setDevice} />
      </span>
      {/* Which pack the miniature below is showing. Named, because the two packs
          differ in layout rather than colour: without the label a re-shaped
          preview reads as a rendering glitch instead of the design changing. */}
      <span
        data-testid="preview-design"
        class="font-body text-text-muted text-[0.7rem] tracking-[0.08em] uppercase"
      >
        {designName()} design
      </span>
      <figure
        aria-label="Invite preview"
        style={{ ...props.tokens, "border-color": "var(--color-border)" }}
        class="overflow-hidden rounded-sm border"
        classList={{ "mx-auto w-48": device() === "phone" }}
      >
        <Show when={props.hero.shown} fallback={hiddenStrip("Hero")}>
          <HeroSample
            imageUrl={props.hero.imageUrl}
            crop={heroCrop()}
            title={props.hero.title}
            heroBlur={props.hero.heroBlur}
            backdropOpacity={props.hero.backdropOpacity}
            backdropBlur={props.hero.backdropBlur}
            surface={props.toneSurface("hero")}
            design={props.design}
            class={device() === "phone" ? "h-64" : "h-36"}
          />
        </Show>
        <Show when={props.story.shown} fallback={hiddenStrip("Our Story")}>
          <SectionSample
            surface={props.toneSurface("story")}
            design={props.design}
            eyebrow={sampleCopy(props.story.eyebrow, DEFAULTS.storyEyebrow, 40)}
            heading={sampleCopy(props.story.heading, DEFAULTS.storyHeading, 60)}
            body={sampleCopy(props.story.body, DEFAULTS.storyBody)}
          />
        </Show>
        {/* The code-entry section is `panel` in the packs that inset it (gala);
            `SectionSample` ignores the flag for the packs that don't. */}
        <SectionSample
          surface={props.toneSurface("welcome")}
          design={props.design}
          panel={layout().welcome === "panel"}
          eyebrow="Your Invitation"
          heading="Enter Your Code"
          body={sampleCopy(props.welcome.message, DEFAULTS.welcomeMessage)}
        />
        <SectionSample
          surface={props.toneSurface("details")}
          design={props.design}
          rule={layout().eventsRule}
          eyebrow={sampleCopy(props.events.eyebrow, DEFAULTS.detailsEyebrow, 40)}
          heading={sampleCopy(props.events.heading, DEFAULTS.detailsHeading, 60)}
          body="Your events, from the spreadsheet import."
          card={{ name: "Ceremony", meta: "Saturday, 4pm · St Mary's" }}
        />
        {/* The closing section paints the WELCOME surface — the couple's two
            direct addresses to their guests read as a matched pair. */}
        <Show when={props.closing.shown} fallback={hiddenStrip("Closing")}>
          <SectionSample
            surface={props.toneSurface("welcome")}
            design={props.design}
            imageUrl={props.closing.imageUrl}
            imageCrop={props.closing.imageCrop}
            body={
              props.closing.message.trim().length > 0
                ? sampleCopy(props.closing.message, "")
                : "Your closing note appears here."
            }
          />
        </Show>
      </figure>
      <p class="font-body text-text-muted text-[0.72rem] italic">
        A miniature of the guest invite, updating as you edit — colours, fonts and copy are exact;
        spacing is compressed.
      </p>
    </div>
  );
}
