import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Badge } from "@osn/ui/ui/badge";
import { Button } from "@osn/ui/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@osn/ui/ui/card";

import type { Story, StoryArgs } from "../../lab/types.ts";

export const meta = { title: "osn/ui/display", layout: "padded" as const };

interface BadgeArgs extends StoryArgs {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
}

export const Badges: Story<BadgeArgs> = {
  args: { label: "Sold out", variant: "default" },
  controls: {
    variant: { kind: "select", options: ["default", "secondary", "destructive", "outline"] },
  },
  render: (args) => (
    <div class="flex flex-col gap-6">
      <div class="flex flex-wrap items-center gap-2">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="outline">Outline</Badge>
      </div>
      <div>
        <p class="text-meta text-subtle mb-2">Playground</p>
        <Badge variant={args.variant}>{args.label}</Badge>
      </div>
    </div>
  ),
};

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

    <Card class="w-80 p-4">
      <p class="text-body text-muted-foreground">
        A bare card. The parts are optional — this one is just the surface.
      </p>
    </Card>
  </div>
);
