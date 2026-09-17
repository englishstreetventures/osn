import { Button } from "@shared/ui/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@shared/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { InfoPopover } from "@shared/ui/ui/info-popover";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Modal } from "@shared/ui/ui/modal";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/ui/ui/tabs";
import { createSignal } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";

export const meta = { title: "shared/ui/overlays", layout: "padded" as const };

/**
 * Dialog, dropdown and popover content all render through a portal, into
 * `document.body` — so an open one escapes the preview pane and covers the
 * whole lab window. That is the component behaving correctly, and the price of
 * the lab having no iframe. Open the story with `?bare` (the toolbar's "open")
 * to see it against nothing else.
 */
export const DialogStory = () => (
  <Dialog>
    <DialogTrigger as={Button}>Open dialog</DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Leave this event?</DialogTitle>
      </DialogHeader>
      <div class="p-4">
        <DialogDescription>
          Your RSVP is removed and the host is told. You can rejoin while there is room.
        </DialogDescription>
      </div>
      <DialogFooter>
        <DialogClose as={Button} variant="outline">
          Stay
        </DialogClose>
        <DialogClose as={Button} variant="destructive">
          Leave
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const Dropdown = () => {
  const [picked, setPicked] = createSignal("—");
  return (
    <div class="flex flex-col gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="outline">
          Account
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Signed in as ada</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicked("Profile")}>Profile</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPicked("Settings")}>Settings</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicked("Sign out")}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <p class="text-meta text-subtle">last chosen: {picked()}</p>
    </div>
  );
};

export const PopoverStory = () => (
  <Popover>
    <PopoverTrigger as={Button} variant="ghost">
      What is a handle?
    </PopoverTrigger>
    <PopoverContent>
      The name people find you by. It is yours across every app on the network, and you can change
      it later.
    </PopoverContent>
  </Popover>
);

/**
 * The same Popover packaged as a form-field affordance: a circled glyph
 * beside a label. `placement` matters here — the default opens the panel over
 * whatever sits below the trigger, which is usually the field itself.
 */
export const InfoPopoverStory = () => (
  <div class="flex max-w-sm flex-col gap-4">
    <div class="flex flex-col gap-1">
      <div class="flex items-center">
        <Label for="lab-email">Email</Label>
        <InfoPopover
          label="What this address is used for"
          glyph="i"
          placement="top"
          body="We send a six-digit code here to confirm the address — your account is not created until you enter it. It is also how you get back in if you lose every device with a passkey on it. Security notices come here too."
        />
      </div>
      <Input id="lab-email" type="email" placeholder="you@example.com" />
    </div>
    <div class="flex flex-col gap-1">
      <div class="flex items-center">
        <Label>Guest list visibility</Label>
        <InfoPopover
          label="About visibility"
          body="Who can see the list of people coming. The default glyph is a question mark and the panel opens below."
        />
      </div>
    </div>
  </div>
);

export const TabsStory = () => (
  <Tabs defaultValue="going" class="max-w-md">
    <TabsList>
      <TabsTrigger value="going">Going</TabsTrigger>
      <TabsTrigger value="maybe">Maybe</TabsTrigger>
      <TabsTrigger value="invited">Invited</TabsTrigger>
      <TabsTrigger value="blocked" disabled>
        Disabled
      </TabsTrigger>
    </TabsList>
    <TabsContent value="going">
      <p class="text-body text-muted-foreground">Twelve people are going.</p>
    </TabsContent>
    <TabsContent value="maybe">
      <p class="text-body text-muted-foreground">Four are undecided.</p>
    </TabsContent>
    <TabsContent value="invited">
      <p class="text-body text-muted-foreground">Nine have not replied.</p>
    </TabsContent>
  </Tabs>
);

/**
 * `Modal` is the other dialog, and it is not Kobalte.
 *
 * It is the platform's `<dialog>` + `showModal()`, which gives the focus trap,
 * Escape, background inertness and a `::backdrop` for nothing — Kobalte's
 * `Dialog` costs 15.3 KB gzip, against roughly 11.7 KB of headroom in each of
 * the two cire apps that carry no Kobalte at all.
 *
 * The bench below is the part worth seeing. A `showModal()` dialog renders in
 * the **top layer**, so it is above every stacking context in the document by
 * definition — including the deliberately hostile one here, which has a
 * `transform` and the largest `z-index` there is. That ancestor is exactly the
 * shape Motion One leaves behind on anything it animates, and it is what put
 * cire's RSVP toast underneath the sheet it fired beneath. Nine hand-rolled
 * `position: fixed` overlays in this repository are one animated ancestor away
 * from the same bug; this one cannot be captured that way.
 */
export const NativeModal = () => {
  const [open, setOpen] = createSignal(false);
  const [guarded, setGuarded] = createSignal(false);

  return (
    <div class="flex flex-col gap-8">
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open modal
        </Button>
        <Button variant="outline" onClick={() => setGuarded(true)}>
          Open one with unsaved input
        </Button>
      </div>

      {/* The hostile ancestor: transformed, `position: relative`, and at the
          top of the z-index range. Anything `position: fixed` inside it is
          trapped; the dialog is not. */}
      <div
        class="border-border relative rounded-lg border border-dashed p-6"
        style={{ transform: "translateZ(0)", "z-index": 2147483647 }}
      >
        <p class="text-meta text-subtle">
          Transformed, stacking-context-creating ancestor. The modal opens from in here.
        </p>
      </div>

      <Modal open={open()} onClose={() => setOpen(false)} label="Leave this event?">
        <h2 class="text-title font-semibold">Leave this event?</h2>
        <p class="text-body text-muted-foreground mt-2">
          Your RSVP is removed and the host is told. Press Escape, click the backdrop, or use the
          button — all three close it, and all three report the close.
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Stay
          </Button>
          <Button variant="destructive" onClick={() => setOpen(false)}>
            Leave
          </Button>
        </div>
      </Modal>

      {/* `dismissable={false}`: the backdrop stops closing it, Escape still
          does. That asymmetry is the platform's, and it is the right one —
          Escape is a deliberate act, a backdrop click is usually a near-miss. */}
      <Modal
        open={guarded()}
        onClose={() => setGuarded(false)}
        dismissable={false}
        label="Unsaved changes"
      >
        <h2 class="text-title font-semibold">Unsaved changes</h2>
        <p class="text-body text-muted-foreground mt-2">
          Clicking the backdrop does nothing here. Escape still closes it, from the platform.
        </p>
        <div class="mt-6 flex justify-end">
          <Button variant="outline" onClick={() => setGuarded(false)}>
            Discard
          </Button>
        </div>
      </Modal>
    </div>
  );
};

/**
 * The modal's motion, which is the part no test tier can judge.
 *
 * `shared/ui`'s browser suite asserts that the exit is *running* and that the
 * dialog stays in the top layer until it finishes. Whether 350ms of
 * `cubic-bezier(0.22, 1, 0.36, 1)` rising 24px looks right is a question for
 * eyes, and this is where they go.
 *
 * Two things worth doing here rather than reading about:
 *
 * **Watch the close, not the open.** Entry is `@starting-style` — pure CSS, no
 * JavaScript. Exit cannot be: `close()` drops a dialog out of the top layer
 * immediately, and the platform's fix for that (`overlay` with
 * `transition-behavior: allow-discrete`) is Chrome and Edge only. `Modal`
 * defers the `close()` call instead, which is why the sheet fades out here the
 * same way it would in Safari.
 *
 * **Drag the durations to zero** and the close still works — that is the
 * reduced-motion path, which each app reaches through its own global clamp.
 */
export const ModalMotion: Story<{ enter: number; exit: number } & StoryArgs> = {
  args: { enter: 350, exit: 200 },
  controls: {
    enter: { kind: "range", min: 0, max: 1200 },
    exit: { kind: "range", min: 0, max: 1200 },
  },
  render: (args) => {
    const [open, setOpen] = createSignal(false);
    return (
      <div
        class="flex flex-col gap-4"
        style={{
          "--ui-modal-enter": `${args.enter}ms`,
          "--ui-modal-exit": `${args.exit}ms`,
        }}
      >
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open
        </Button>
        <p class="text-meta text-subtle max-w-sm">
          Enter {args.enter}ms · exit {args.exit}ms. The custom properties are set on the wrapper,
          so they reach the dialog through the cascade rather than through a prop.
        </p>

        <Modal open={open()} onClose={() => setOpen(false)} label="Motion bench">
          <h2 class="text-title font-semibold">Motion bench</h2>
          <p class="text-body text-muted-foreground mt-2">
            Escape, the backdrop and the button below all take the same exit.
          </p>
          <div class="mt-6 flex justify-end">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </Modal>
      </div>
    );
  },
};
