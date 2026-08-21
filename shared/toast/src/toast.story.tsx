import { For, onMount } from "solid-js";

import { resetToasts, toast } from "./index";
import { Toaster } from "./Toaster";
import type { ToastPosition, ToastTone } from "./types";

/**
 * Rendered by the component lab (`bun run dev:lab`) — a story living next to
 * the package it exercises rather than in `tools/lab`. Nothing imports this
 * file at build time; the lab finds it by glob.
 *
 * ## Why this bench exists
 *
 * A toast is almost entirely the things a unit test cannot see: how it enters
 * and leaves, whether it reads at a glance, whether the tone is legible on the
 * surface it lands on, and whether the stack behaves when four of them arrive
 * at once. `shared/toast/tests` asserts the queue and the DOM contract; this is
 * where you look at the result.
 *
 * The lab borrows `@osn/social`'s stylesheet, which maps the shadcn ramp onto
 * the `--toast-*` contract — so the lab's **light · dark** toggle re-themes
 * these toasts exactly as it re-themes the app. Use it: the accent colours are
 * per-ramp, and dark is where a too-dark accent hides.
 *
 * See `wiki/systems/toast.md`.
 */
export const meta = { title: "shared/toast", layout: "padded" as const };

const TONES: ToastTone[] = ["success", "error", "warning", "info", "loading"];

/** Realistic copy — a bench that says "this is a error toast" tests nothing about
 *  how a real message wraps, and reads as a placeholder rather than a sample. */
const MESSAGE = {
  success: "Schedule saved",
  error: "Could not save the schedule",
  warning: "Two events share a name",
  info: "Guests are matched to events by name",
  loading: "Saving the schedule…",
} satisfies Record<ToastTone, string>;
const POSITIONS: ToastPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

/**
 * Empty the queue when a bench opens.
 *
 * The store is a module singleton — deliberately, so `toast.success(…)` works
 * from a `catch` block with no provider in scope — which means toasts raised in
 * one story are still queued when you navigate to the next one. Fine in an app,
 * where there is one page; confusing in a bench, where "four toasts" when you
 * raised one is the first thing you'd chase.
 */
function useCleanQueue() {
  onMount(resetToasts);
}

function Button(props: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="border-border bg-card hover:bg-muted focus-visible:ring-ring rounded-md border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
    >
      {props.children}
    </button>
  );
}

function Section(props: {
  title: string;
  hint?: string;
  children: import("solid-js").JSX.Element;
}) {
  return (
    <section class="flex flex-col gap-2">
      <h3 class="text-sm font-medium">{props.title}</h3>
      {props.hint ? <p class="text-muted-foreground max-w-prose text-xs">{props.hint}</p> : null}
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </section>
  );
}

/**
 * Every tone, raised on demand.
 *
 * The thing to check is that tone is never carried by hue alone: each one leads
 * with a differently-*shaped* glyph, because `error` and `warning` are exactly
 * the pair red-green colour blindness collapses. Squint, or switch the lab to
 * dark, and they should still be tellable apart.
 */
export const Tones = () => {
  useCleanQueue();
  return (
    <div class="flex flex-col gap-6">
      <Section
        title="Tones"
        hint="Errors announce assertively (role=alert); everything else waits its turn (role=status)."
      >
        <For each={TONES}>
          {(tone) => <Button onClick={() => toast[tone](MESSAGE[tone])}>{tone}</Button>}
        </For>
      </Section>
      <Toaster position="bottom-right" />
    </div>
  );
};

/**
 * All six positions. Worth walking through on a phone viewport as well as a
 * laptop one — the container is capped at `min(100vw, 26rem)`, and the
 * top/bottom-centre variants are the ones that can collide with app chrome.
 */
export const Positions = () => {
  useCleanQueue();
  let current: ToastPosition = "bottom-right";
  return (
    <div class="flex flex-col gap-6">
      <Section title="Positions" hint="Raises a toast in the chosen corner.">
        <For each={POSITIONS}>
          {(position) => (
            <Button
              onClick={() => {
                current = position;
                toast.info(position, { id: "position" });
              }}
            >
              {position}
            </Button>
          )}
        </For>
      </Section>
      {/* One Toaster per position so the story can show all six without
          remounting — each only ever holds the toast raised into it. */}
      <For each={POSITIONS}>{(position) => <Toaster position={position} limit={1} />}</For>
      <p class="text-muted-foreground text-xs">
        Six Toasters are mounted here, one per corner — a real app mounts exactly one. Current:{" "}
        <code>{current}</code>
      </p>
    </div>
  );
};

/**
 * The stack. `limit` caps what is on screen and drops the oldest, so a burst
 * cannot bury the page.
 *
 * Raise "five at once" and watch them enter staggered by their own animation
 * rather than all at once; then hover the stack — the dwell pauses while the
 * pointer is on it, so a toast can't expire mid-sentence.
 */
export const Stacking = () => {
  useCleanQueue();
  return (
    <div class="flex flex-col gap-6">
      <Section
        title="Stacking"
        hint="Hover the stack to pause every dwell. Limit is 3 here, so the fourth pushes the first out."
      >
        <Button
          onClick={() => {
            for (const [i, tone] of (
              ["success", "error", "info", "warning", "success"] as const
            ).entries()) {
              toast[tone](`Message ${i + 1}`);
            }
          }}
        >
          five at once
        </Button>
        <Button onClick={() => toast.success("One more")}>one more</Button>
        <Button onClick={() => toast.dismiss()}>dismiss all</Button>
      </Section>
      <Toaster position="bottom-right" limit={3} />
    </div>
  );
};

/**
 * The richer surface: a pinned toast with an action, a dismissible one, and
 * `toast.promise` turning one spinner into one result **in place** — the id
 * stays the same, so you should see the toast change rather than one vanish and
 * another appear somewhere else in the stack.
 */
export const Interactive = () => {
  useCleanQueue();
  return (
    <div class="flex flex-col gap-6">
      <Section title="Actions and promises">
        <Button
          onClick={() =>
            toast.error("Could not save the schedule", {
              duration: Number.POSITIVE_INFINITY,
              action: { label: "Retry", onClick: () => toast.success("Saved") },
            })
          }
        >
          with an action
        </Button>
        <Button
          onClick={() =>
            toast.info("A standing note", { duration: Number.POSITIVE_INFINITY, dismissible: true })
          }
        >
          dismissible
        </Button>
        <Button
          onClick={() => {
            void toast.promise(new Promise((r) => setTimeout(r, 1800)), {
              loading: "Saving the schedule…",
              success: "Schedule saved",
              error: "Could not save",
            });
          }}
        >
          promise — resolves
        </Button>
        <Button
          onClick={() => {
            void toast
              .promise(
                new Promise((_, reject) => setTimeout(() => reject(new Error("503")), 1800)),
                {
                  loading: "Saving the schedule…",
                  success: "Schedule saved",
                  error: (e) => `Could not save: ${(e as Error).message}`,
                },
              )
              // `toast.promise` re-throws — the toast reports on the promise, it
              // does not handle it. Swallow it here so the lab console stays clean.
              .catch(() => {});
          }}
        >
          promise — rejects
        </Button>
      </Section>
      <Toaster position="bottom-right" />
    </div>
  );
};

/**
 * A long message and a short one, side by side.
 *
 * The message wraps inside a capped container and the glyph stays pinned to the
 * first line — `align-items: flex-start`, not `center`, which is the difference
 * between a tidy three-line toast and one with a glyph floating in the middle
 * of it.
 */
export const Overflow = () => {
  useCleanQueue();
  return (
    <div class="flex flex-col gap-6">
      <Section title="Long content">
        <Button onClick={() => toast.success("Saved")}>short</Button>
        <Button
          onClick={() =>
            toast.error(
              "We couldn't save the schedule because two events now claim the same name, and the invite resolves events by name when it matches guests to them.",
            )
          }
        >
          long
        </Button>
        <Button
          onClick={() =>
            toast.info(
              "supercalifragilisticexpialidocious-and-then-some-unbroken-token-that-cannot-wrap",
            )
          }
        >
          unbreakable token
        </Button>
      </Section>
      <Toaster position="bottom-right" />
    </div>
  );
};
