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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { InfoPopover } from "@shared/ui/ui/info-popover";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Modal } from "@shared/ui/ui/modal";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/ui/ui/tabs";
import { Tooltip } from "@shared/ui/ui/tooltip";
import { createEffect, createSignal, type JSX, onCleanup } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { type CireTheme, cireStyle } from "../cire-ui/cire-mapping.ts";

export const meta = { title: "shared/ui/overlays", layout: "padded" as const };

/**
 * Dialog, dropdown and popover content all render through a portal, into
 * `document.body` — so an open one escapes the preview pane and covers the
 * whole lab window. That is the component behaving correctly, and the price of
 * the lab having no iframe. Open the story with `?bare` (the toolbar's "open")
 * to see it against nothing else.
 *
 * The contract's default: it lends `initial` for the title's size and weight
 * and both scale tokens, so it draws what an app that maps none of them draws
 * (a 1.05rem title at 600, in from 96% and out to 98%) whatever the lab's
 * stylesheet maps.
 */
export const DialogStory = () => {
  lend(() => ({
    "--ui-text-md": "initial",
    "--ui-weight-title": "initial",
    "--ui-scale-enter": "initial",
    "--ui-scale-exit": "initial",
  }));
  return <LeaveDialog />;
};

/** The dialog every Dialog story opens: a title, a sentence and two buttons. */
function LeaveDialog(props: {
  presentation?: "centred" | "sheet";
  title?: (el: HTMLHeadingElement) => void;
  children?: JSX.Element;
}) {
  return (
    <Dialog>
      <DialogTrigger as={Button}>Open dialog</DialogTrigger>
      <DialogContent presentation={props.presentation}>
        <DialogHeader>
          <DialogTitle ref={props.title}>Leave this event?</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-2 p-4">
          <DialogDescription>
            Your RSVP is removed and the host is told. You can rejoin while there is room.
          </DialogDescription>
          {props.children}
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
}

/**
 * Lend contract tokens to `<body>` while the story is up, following its
 * controls. The panel portals to `<body>`, so a wrapper's style never reaches
 * it. `initial` is the guaranteed-invalid value, which makes each
 * `var(--ui-x, fallback)` take its fallback: what an app that maps nothing
 * draws, whatever the lab's own stylesheet maps.
 */
function lend(tokens: () => Record<string, string>) {
  createEffect(() => {
    const lent = Object.entries(tokens());
    for (const [name, value] of lent) document.body.style.setProperty(name, value);
    onCleanup(() => {
      for (const [name] of lent) document.body.style.removeProperty(name);
    });
  });
}

/**
 * The title's weight, read back from the page once the dialog has opened and
 * again each time `weight` changes. It reads one frame later, because `lend`
 * may set the token after this runs.
 */
function ReadBack(props: { title: () => HTMLHeadingElement | undefined; weight: () => string }) {
  const [read, setRead] = createSignal("");
  createEffect(() => {
    props.weight();
    const frame = requestAnimationFrame(() => {
      const title = props.title();
      if (title) setRead(getComputedStyle(title).fontWeight);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  return <p class="text-ui-sm text-ui-ink-secondary">Title weight, read back: {read()}</p>;
}

/**
 * `DialogTitle`'s weight comes from the contract's title weight,
 * `--ui-weight-title`, never from a class at the call site. `unmapped` is what
 * an app that maps nothing draws, pulse among them: 600, the semibold the
 * title always had. Open the dialog and change the weight; it reads the
 * weight back from the page each time.
 */
export const DialogTitleWeight: Story<{ weight: string } & StoryArgs> = {
  args: { weight: "500" },
  controls: { weight: { kind: "select", options: ["unmapped", "400", "500", "600"] } },
  render: (args) => {
    lend(() => ({ "--ui-weight-title": args.weight === "unmapped" ? "initial" : args.weight }));
    let title: HTMLHeadingElement | undefined;
    return (
      <LeaveDialog title={(el) => (title = el)}>
        <ReadBack title={() => title} weight={() => args.weight} />
      </LeaveDialog>
    );
  },
};

/**
 * The fade with no scale an app opts into: `--ui-scale-enter` and
 * `--ui-scale-exit` at 1, so `Dialog` as a card (and every Kobalte overlay
 * but a sheet) changes only its opacity as it opens and closes. `unmapped` is
 * the contract's default, which pulse draws: in from 96%, out to 98%. The run
 * is 120ms in and 80ms out, so slow it in the browser's animation tools to
 * judge it. As a sheet it fades like this only at `md` and up; at a phone
 * width it slides whatever the scale tokens hold (`DialogSheetSlide`).
 */
export const DialogFadeOnly: Story<{ motion: string; presentation: string } & StoryArgs> = {
  args: { motion: "fade only", presentation: "centred" },
  controls: {
    motion: { kind: "select", options: ["fade only", "unmapped"] },
    presentation: { kind: "select", options: ["centred", "sheet"] },
  },
  render: (args) => {
    lend(() => {
      const scale = args.motion === "fade only" ? "1" : "initial";
      return { "--ui-scale-enter": scale, "--ui-scale-exit": scale };
    });
    return <LeaveDialog presentation={args.presentation === "sheet" ? "sheet" : "centred"} />;
  },
};

/**
 * `Dialog` as a sheet, the shape Musubi's dialogs, `@osn/auth-ui`'s and
 * pulse's share dialog take. Below `md` it slides up from its own height
 * below the bottom edge over `--ui-dur-slow` (320ms) and back down over
 * `--ui-dur-base` (200ms), both on `--ui-ease-sheet`, with its scrim fading
 * on the same pace; at `md` and up it is the card. Narrow the lab window, or
 * open it with `?bare` in a phone-sized window, to see the slide; close it
 * part-way up to see it turn round. Turn on the system's reduce-motion
 * setting, or emulate `prefers-reduced-motion: reduce` in DevTools, and it
 * fades in and out in place with its scrim instead.
 */
export const DialogSheetSlide = () => <LeaveDialog presentation="sheet" />;

export const Dropdown = () => {
  const [picked, setPicked] = createSignal("—");
  return (
    <div class="flex flex-col gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="outline">
          Account
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {/* Kobalte names a label by its group, and throws on one outside it. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Signed in as ada</DropdownMenuLabel>
          </DropdownMenuGroup>
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

/**
 * One menu holding every kind of row: a group label, a radio group, a check
 * row, a switch row, a link and a disabled row. Open on load, and not modal,
 * so the panel is there to look at; it still closes on Escape or a click
 * outside, and the trigger opens it again.
 *
 * `variant` is set once, on the panel, and every row inside follows it.
 */
function EveryRow(props: { variant?: "default" | "accent"; theme?: CireTheme }) {
  const [theme, setTheme] = createSignal("system");
  const [past, setPast] = createSignal(true);
  const [haptics, setHaptics] = createSignal(false);
  const style = () => (props.theme ? cireStyle(props.theme) : undefined);
  return (
    <div
      class="bg-ui-ground text-ui-ink rounded-ui-lg flex min-h-96 items-start p-5"
      style={style()}
    >
      <DropdownMenu defaultOpen modal={false} placement="bottom-start">
        <DropdownMenuTrigger as={Button} variant="outline">
          Account
        </DropdownMenuTrigger>
        {/* The panel portals out of the wrapper above, so it takes the
            mapping itself. */}
        <DropdownMenuContent variant={props.variant} style={style()} class="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel tone="eyebrow">Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme()} onChange={setTheme}>
              <DropdownMenuRadioItem value="system" closeOnSelect={false}>
                Match system
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light" closeOnSelect={false}>
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" closeOnSelect={false}>
                Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={past()} onChange={setPast}>
            Show past events
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={haptics()} onChange={setHaptics} indicator="switch">
            Haptics
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem as="a" href="#account" target="_blank">
            Account settings
          </DropdownMenuItem>
          <DropdownMenuItem>Security and passkeys</DropdownMenuItem>
          <DropdownMenuItem disabled>Export guest list</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Every row kind in the shared default look, the look musubi's and pulse's
 * menus take. The lab maps Musubi's motion, so here the panel fades in and out
 * with no scale, as in Musubi; pulse maps no scale, so its menus grow
 * from 96% as they open and shrink to 98% as they close.
 */
export const MenuItems = () => <EveryRow />;

/**
 * The `accent` variant under cire's mapping, dark: the raised panel at the
 * 10px corner with the floating shadow, rows in full ink, the highlighted row
 * a 10% accent wash in readable gold, a check in readable gold on the chosen
 * rows, the shared `Switch` itself in the switch row, and a muted
 * small-caps group label. Arrow down to see the highlight.
 */
export const MenuItemsCireDark = () => <EveryRow variant="accent" theme="dark" />;

/** The same, on cire's light ramp. */
export const MenuItemsCireLight = () => <EveryRow variant="accent" theme="light" />;

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

/**
 * A short label that explains itself on hover. The panel is for the eye only:
 * a screen reader gets the same words once, as hidden text inside the trigger,
 * and the panel is `aria-hidden`. Hover only — the badge adds no tab stop, so
 * keyboard and touch users see the label alone. The second badge wraps, which
 * is why the trigger is `inline-block`: the panel sits above both lines.
 */
export const TooltipStory = () => (
  <div class="text-body flex max-w-xs flex-wrap items-center gap-3">
    Ada Lovelace
    <Tooltip text="Recorded by a host (phone/paper RSVP)">
      <span class="border-border text-meta rounded border px-1.5 py-0.5 uppercase">
        Host-entered
      </span>
    </Tooltip>
    <Tooltip text="Given by the household that brought them, not by the plus-one. A host may have changed the status since; the dietary requirements are the household's.">
      <span class="border-border text-meta inline-block w-24 rounded border px-1.5 py-0.5 uppercase">
        Household-entered
      </span>
    </Tooltip>
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
  args: { enter: 350, exit: 150 },
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
