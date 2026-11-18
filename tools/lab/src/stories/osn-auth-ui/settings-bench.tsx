import type { StepUpClient } from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Dialog, DialogContent } from "@shared/ui/ui/dialog";
import { createSignal, type JSX } from "solid-js";

// What the Settings panels' and the auth views' stories share: the frames
// musubi draws them in, and clients whose calls answer from fixed data or
// never. Nothing here reaches an issuer.

/** A request that never settles. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** A request that fails, as a list read does when the issuer is down. */
export function failed<T>(): Promise<T> {
  return Promise.reject(new Error("The lab answers no request."));
}

/** Every step-up call waits for ever, so a sheet opened from a story holds its factors. */
export const stepUpClient: StepUpClient = {
  passkeyBegin: () => never(),
  passkeyComplete: () => never(),
  emailBegin: () => never(),
  emailStatus: () => never(),
  emailResend: () => never(),
  totpComplete: () => never(),
};

/** 14 Nov 2023, so the rows' dates read the same on every run. */
export const ADDED = 1_700_000_000;

/**
 * Settings → Security's card in musubi: `Card padding="md"`, which a panel's
 * rows nest inside, so they take a nested row's 8px corner. `phone` narrows it to
 * a 320px screen's column after `main`'s 16px each side.
 */
export function SettingsCard(props: { children: JSX.Element; phone?: boolean }) {
  return (
    <div class={props.phone ? "w-72" : "w-full max-w-2xl"}>
      <Card padding="md" class="flex flex-col gap-3">
        {props.children}
      </Card>
    </div>
  );
}

/**
 * A sheet open over the story, sized as musubi's auth dialogs are: a bottom
 * sheet below `md`, a 384px card from it. Escape closes it; the button opens
 * it again.
 */
export function DialogBench(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open the dialog
      </Button>
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent presentation="sheet" class="md:max-w-sm">
          {props.children}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * `/authorize`'s column, with no frame round the panel, under a stand-in for
 * the client card. The page pads it 24px a side (`max-w-md px-6`); below `md`
 * the lab's own 32px stands in for that, so at a 320px frame the panel is
 * 256px wide against the page's 272px, and never wider than the page draws it.
 */
export function AuthorizeColumn(props: { children: JSX.Element }) {
  return (
    <div class="w-full max-w-md py-6 md:px-6">
      {/* Stands in for the client card's `h1` at `text-display`, which the
          host draws; a `p` so the lab page keeps one `h1`. */}
      <div class="flex flex-col items-center text-center">
        <p class="text-ui-ink text-ui-xl font-medium">Pulse</p>
        <p class="text-ui-ink-secondary text-ui-sm mt-1">wants to use your Musubi account</p>
      </div>
      <div class="mt-6">{props.children}</div>
    </div>
  );
}
