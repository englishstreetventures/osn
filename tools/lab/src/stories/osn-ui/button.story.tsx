import { Button } from "@osn/ui/ui/button";

import type { Story, StoryArgs } from "../../lab/types.ts";

export const meta = { title: "osn/ui/Button" };

/**
 * The shortest thing a story can be: a bare component, no args, no config.
 */
export const Variants = () => (
  <div class="flex flex-wrap items-center gap-2">
    <Button>Default</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="destructive">Destructive</Button>
    <Button variant="link">Link</Button>
  </div>
);

interface PlaygroundArgs extends StoryArgs {
  label: string;
  variant: "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
  size: "default" | "sm" | "lg" | "icon";
  disabled: boolean;
}

/**
 * The same component with live args. `variant` and `size` get an explicit
 * select; `label` and `disabled` are inferred from their initial values.
 */
export const Playground: Story<PlaygroundArgs> = {
  args: { label: "Continue", variant: "default", size: "default", disabled: false },
  controls: {
    variant: {
      kind: "select",
      options: ["default", "secondary", "outline", "ghost", "destructive", "link"],
    },
    size: { kind: "select", options: ["default", "sm", "lg", "icon"] },
  },
  render: (args) => (
    <Button variant={args.variant} size={args.size} disabled={args.disabled}>
      {args.label}
    </Button>
  ),
};
