import { Button, buttonVariants } from "@shared/ui/ui/button";
import { createSignal } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";

export const meta = { title: "shared/ui/Button" };

const INLINE = buttonVariants({ variant: "link", size: "inline" });

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

/**
 * A link inside a sentence (`variant="link" size="inline"`), beside a link
 * standing alone. The inline one is underlined at rest and takes the
 * sentence's size, line height and weight; the standalone one underlines on
 * hover. The narrow paragraph wraps an `<a>` wearing the inline classes across
 * lines: Tab onto it to see its focus ring close round each line. The
 * `<Button>` in the first sentence does not wrap, as no `<button>` does, so its
 * label stays a word or two.
 */
export const Inline: Story = {
  layout: "padded",
  render: () => (
    <div class="flex max-w-96 flex-col gap-6">
      <p class="text-meta text-muted-foreground">
        By continuing you accept the{" "}
        <Button variant="link" size="inline">
          terms of service
        </Button>{" "}
        and the{" "}
        <a href="#privacy" class={INLINE}>
          privacy notice
        </a>
        .
      </p>
      <p class="text-body">
        Lost your device? Use a{" "}
        <a href="#recovery" class={INLINE}>
          recovery code
        </a>{" "}
        instead.
      </p>
      <p class="text-body w-40">
        See{" "}
        <a href="#reach" class={INLINE}>
          how to recover an account you can no longer reach
        </a>
        .
      </p>
      <div>
        <Button variant="link">Standalone link</Button>
      </div>
    </div>
  ),
};

/**
 * `busy` on every variant that carries a label, and at each size that does:
 * the 20px orb before the label, dimmed as a disabled button is, keyboard
 * focus kept. The orb moves for five seconds, then holds still. The last
 * button starts a two-second wait when pressed: Tab onto it and press Enter,
 * and it stays at full strength while it waits, so its focus ring keeps its
 * contrast.
 */
export const Busy: Story = {
  layout: "padded",
  render: () => {
    const [busy, setBusy] = createSignal(false);
    const start = () => {
      setBusy(true);
      setTimeout(() => setBusy(false), 2000);
    };
    return (
      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <Button busy>Creating…</Button>
          <Button variant="secondary" busy>
            Saving…
          </Button>
          <Button variant="outline" busy>
            Sending…
          </Button>
          <Button variant="ghost" busy>
            Loading…
          </Button>
          <Button variant="ghostDanger" busy>
            Removing…
          </Button>
          <Button variant="destructive" busy>
            Deleting…
          </Button>
          <Button variant="link" busy>
            Checking…
          </Button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" busy>
            Small
          </Button>
          <Button busy>Default</Button>
          <Button size="lg" busy>
            Large
          </Button>
        </div>
        <div>
          <Button busy={busy()} onClick={start}>
            {busy() ? "Creating…" : "Create profile"}
          </Button>
        </div>
      </div>
    );
  },
};

/**
 * The press: hold the mouse down on a button, or Tab onto one and hold Space,
 * and it scales to 0.97 over 120ms (`--ui-dur-fast` on `--ui-ease-out`), then
 * eases back when let go. Every variant and every size that draws a box
 * presses, and so does a link wearing `buttonVariants`. The second group does
 * not: disabled, busy, `aria-disabled`, and a link inside a sentence. With the
 * system's reduce-motion setting on, nothing scales.
 */
export const Press: Story = {
  layout: "padded",
  render: () => (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-2">
        <p class="text-meta text-muted-foreground">Presses</p>
        <div class="flex flex-wrap items-center gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="ghostDanger">Remove</Button>
          <Button variant="destructive">Delete</Button>
          <Button variant="link">Link</Button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Add">
            +
          </Button>
          <a
            href="#settings"
            class={buttonVariants({ variant: "outline", size: "sm" })}
            onClick={(event) => event.preventDefault()}
          >
            A link styled as a button
          </a>
        </div>
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-meta text-muted-foreground">Does not press</p>
        <div class="flex flex-wrap items-center gap-2">
          <Button disabled>Disabled</Button>
          <Button busy>Creating…</Button>
          <Button aria-disabled="true">aria-disabled</Button>
        </div>
        <p class="text-body">
          By continuing you accept the{" "}
          <Button variant="link" size="inline">
            terms
          </Button>
          .
        </p>
      </div>
    </div>
  ),
};

interface PlaygroundArgs extends StoryArgs {
  label: string;
  variant: "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
  size: "default" | "sm" | "lg" | "icon";
  disabled: boolean;
  busy: boolean;
}

/**
 * The same component with live args. `variant` and `size` get an explicit
 * select; `label`, `disabled` and `busy` are inferred from their initial
 * values. `busy` does nothing at the `icon` size, which has no label for the
 * orb to sit beside and does not take it.
 */
export const Playground: Story<PlaygroundArgs> = {
  args: {
    label: "Continue",
    variant: "default",
    size: "default",
    disabled: false,
    busy: false,
  },
  controls: {
    variant: {
      kind: "select",
      options: ["default", "secondary", "outline", "ghost", "destructive", "link"],
    },
    size: { kind: "select", options: ["default", "sm", "lg", "icon"] },
  },
  render: (args) => {
    const size = args.size;
    return size === "icon" ? (
      <Button variant={args.variant} size={size} disabled={args.disabled}>
        {args.label}
      </Button>
    ) : (
      <Button variant={args.variant} size={size} disabled={args.disabled} busy={args.busy}>
        {args.label}
      </Button>
    );
  },
};
