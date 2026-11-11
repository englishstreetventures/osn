import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Badge, type BadgeProps } from "@shared/ui/ui/badge";
import { Button } from "@shared/ui/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shared/ui/ui/card";
import { For, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { Caption, Mono, Readout, Rule } from "../design-system/chrome.tsx";

export const meta = { title: "shared/ui/display", layout: "padded" as const };

const BADGE_VARIANTS = [
  "default",
  "secondary",
  "destructive",
  "outline",
] as const satisfies readonly NonNullable<BadgeProps["variant"]>[];
const BADGE_TREATMENTS = ["default", "eyebrow"] as const satisfies readonly NonNullable<
  BadgeProps["treatment"]
>[];

interface BadgeArgs extends StoryArgs {
  label: string;
  variant: (typeof BADGE_VARIANTS)[number];
  treatment: (typeof BADGE_TREATMENTS)[number];
}

/** Every variant in one treatment, labelled with its own name. */
function BadgeRow(props: { treatment: (typeof BADGE_TREATMENTS)[number] }) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <For each={BADGE_VARIANTS}>
        {(variant) => (
          <Badge variant={variant} treatment={props.treatment}>
            {variant}
          </Badge>
        )}
      </For>
    </div>
  );
}

/**
 * The four variants in both treatments. `eyebrow` is the small-caps label
 * pulse's category pills take.
 */
export const Badges: Story<BadgeArgs> = {
  args: { label: "Sold out", variant: "default", treatment: "default" },
  controls: {
    variant: { kind: "select", options: BADGE_VARIANTS },
    treatment: { kind: "select", options: BADGE_TREATMENTS },
  },
  render: (args) => (
    <div class="flex flex-col gap-6">
      <BadgeRow treatment="default" />
      <BadgeRow treatment="eyebrow" />
      <div>
        <p class="text-meta text-subtle mb-2">Playground</p>
        <Badge variant={args.variant} treatment={args.treatment}>
          {args.label}
        </Badge>
      </div>
    </div>
  ),
};

/** Every badge, captioned with the weight the browser computed for the first. */
function WeightColumn(props: { title: JSX.Element; style?: string }) {
  let rows: HTMLDivElement | undefined;
  return (
    <div class="flex flex-col gap-3" style={props.style}>
      <Caption
        name={props.title}
        value={
          <>
            font-weight{" "}
            <Readout
              of={() => rows?.querySelector(":scope > * > *") ?? undefined}
              property="font-weight"
            />
          </>
        }
      />
      <div ref={rows} class="flex flex-col gap-2">
        <BadgeRow treatment="default" />
        <BadgeRow treatment="eyebrow" />
      </div>
    </div>
  );
}

/**
 * `Badge` sets its label at the contract's title weight, `--ui-weight-title`,
 * and at 600 where an app does not map it. The left column maps nothing, as
 * pulse does and as the lab's own stylesheet does; the right sets the token to
 * 500 on its wrapper, and every badge inside follows.
 */
export const BadgeWeights = () => (
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-start gap-10">
      <WeightColumn title="No token set" />
      <WeightColumn title={<Mono>--ui-weight-title: 500</Mono>} style="--ui-weight-title: 500" />
    </div>
    <Rule>
      An app maps <Mono>--ui-weight-title</Mono> once, in its own stylesheet, and every shared part
      that reads it follows. Each caption is what the browser computed, not what the stylesheet
      says.
    </Rule>
  </div>
);

/**
 * `AvatarImage` and `AvatarFallback` are siblings, not a fallback chain — the
 * image sits on top and the fallback shows through whenever it fails to load
 * or is absent. The broken-source row below is the load-failure case, not a
 * mistake.
 */
export const Avatars = () => (
  <div class="flex items-end gap-4">
    <Avatar class="size-8">
      <AvatarFallback>AC</AvatarFallback>
    </Avatar>
    <Avatar class="size-10">
      <AvatarFallback>MB</AvatarFallback>
    </Avatar>
    <Avatar class="size-14">
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
    <Avatar class="size-14">
      {/* Deliberately unresolvable: shows what a failed load looks like. */}
      <AvatarImage src="/does-not-exist.png" alt="" />
      <AvatarFallback>404</AvatarFallback>
    </Avatar>
  </div>
);

export const Cards = () => (
  <div class="flex flex-wrap items-start gap-4">
    <Card class="w-80">
      <CardHeader>
        <CardTitle>Rooftop, Friday</CardTitle>
        <CardDescription>Carlton North · 7:00pm</CardDescription>
      </CardHeader>
      <CardContent>
        <p class="text-body text-muted-foreground">
          Header, content and footer are separate parts, so a card with no footer simply leaves it
          out.
        </p>
      </CardContent>
      <CardFooter class="gap-2">
        <Button size="sm">Going</Button>
        <Button size="sm" variant="outline">
          Maybe
        </Button>
      </CardFooter>
    </Card>

    <Card class="w-80">
      <CardHeader>
        <CardTitle>Header only</CardTitle>
        <CardDescription>No content, no footer.</CardDescription>
      </CardHeader>
    </Card>

    <Card class="w-80" padding="sm">
      <p class="text-body text-muted-foreground">
        A bare card. The parts are optional — this one is just the surface.
      </p>
    </Card>
  </div>
);

/** One card under a wrapper that sets the title weight, captioned with what the browser computed. */
function TitleWeightCard(props: { weight: string; title: string; detail: string }) {
  let title: HTMLHeadingElement | undefined;
  return (
    <div class="flex flex-col gap-3" style={{ "--ui-weight-title": props.weight }}>
      <Caption
        name={<Mono>--ui-weight-title: {props.weight}</Mono>}
        value={
          <>
            font-weight <Readout of={() => title} property="font-weight" />
          </>
        }
      />
      <Card class="w-80">
        <CardHeader>
          <CardTitle ref={(el) => (title = el)}>{props.title}</CardTitle>
          <CardDescription>{props.detail}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

/**
 * `CardTitle` sets its title at the contract's title weight,
 * `--ui-weight-title`, and at 600 where an app does not map it. The left card
 * lends `initial`, the guaranteed-invalid value, so it draws what an app that
 * maps nothing draws whatever the lab's own stylesheet maps; the right sets the
 * token to 500 on its wrapper. A card is not portalled, so a wrapper's style
 * reaches the title.
 */
export const CardTitleWeights = () => (
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-start gap-4">
      <TitleWeightCard weight="initial" title="Rooftop, Friday" detail="Carlton North · 7:00pm" />
      <TitleWeightCard weight="500" title="Garden, Saturday" detail="Brunswick · 2:00pm" />
    </div>
    <Rule>
      An app maps <Mono>--ui-weight-title</Mono> once, in its own stylesheet, and every shared part
      that reads it follows. Each caption is what the browser computed, not what the stylesheet
      says.
    </Rule>
  </div>
);
