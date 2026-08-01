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
 */

import { createSignal, Show } from "solid-js";

import type { ImageCrop } from "../../lib/image-crop";
import { DEFAULTS, sampleCopy, type ThemeSection } from "./model";
import { DeviceToggle, HeroSample, type PreviewDevice, SectionSample } from "./previews";

export interface PreviewPaneProps {
  tokens: Record<string, string>;
  toneSurface: (section: ThemeSection) => string;
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
            class={device() === "phone" ? "h-64" : "h-36"}
          />
        </Show>
        <Show when={props.story.shown} fallback={hiddenStrip("Our Story")}>
          <SectionSample
            surface={props.toneSurface("story")}
            eyebrow={sampleCopy(props.story.eyebrow, DEFAULTS.storyEyebrow, 40)}
            heading={sampleCopy(props.story.heading, DEFAULTS.storyHeading, 60)}
            body={sampleCopy(props.story.body, DEFAULTS.storyBody)}
          />
        </Show>
        <SectionSample
          surface={props.toneSurface("welcome")}
          eyebrow="Your Invitation"
          heading="Enter Your Code"
          body={sampleCopy(props.welcome.message, DEFAULTS.welcomeMessage)}
        />
        <SectionSample
          surface={props.toneSurface("details")}
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
