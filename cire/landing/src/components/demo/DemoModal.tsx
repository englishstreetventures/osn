import { onCleanup, onMount, type JSX } from "solid-js";

// A slimmed port of cire/web's AnimatedModal: focus trap, Escape-to-close,
// background scroll lock, reduced-motion fallback, and the same enter/exit
// motion. Self-contained so the landing site carries no dependency on cire/web.

interface DemoModalProps {
  onClose: () => void;
  labelledBy?: string;
  children: JSX.Element;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function showInstantly(backdrop: HTMLElement, panel: HTMLElement) {
  backdrop.style.opacity = "1";
  panel.style.opacity = "1";
  panel.style.transform = "none";
}

export function DemoModal(props: DemoModalProps) {
  let backdropRef!: HTMLDivElement;
  let panelRef!: HTMLDivElement;
  let closeButtonRef: HTMLButtonElement | undefined;
  let previouslyFocused: HTMLElement | null = null;

  function focusableElements(): HTMLElement[] {
    if (!panelRef) return [];
    return Array.from(panelRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      void handleClose();
      return;
    }
    if (e.key !== "Tab") return;

    const focusables = focusableElements();
    if (focusables.length === 0) {
      e.preventDefault();
      panelRef?.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !panelRef?.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panelRef?.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  onMount(async () => {
    previouslyFocused = document.activeElement as HTMLElement | null;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = previousBodyOverflow;
    });

    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));

    (closeButtonRef ?? panelRef)?.focus();

    if (prefersReducedMotion()) {
      showInstantly(backdropRef, panelRef);
      return;
    }
    const { modalEnter } = await import("./Modal.motion");
    modalEnter(backdropRef, panelRef);
  });

  onCleanup(() => previouslyFocused?.focus());

  async function handleClose() {
    if (!prefersReducedMotion()) {
      const { modalExit } = await import("./Modal.motion");
      await modalExit(backdropRef, panelRef);
    }
    props.onClose();
  }

  return (
    <div
      ref={backdropRef}
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/70 opacity-0 md:items-center"
      onClick={() => void handleClose()}
    >
      <div
        ref={panelRef}
        class="border-border bg-surface relative max-h-[85dvh] w-full max-w-[480px] overflow-y-auto overscroll-contain rounded-t-[1.75rem] border px-6 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] opacity-0 md:mb-8 md:max-h-[85vh] md:rounded-lg md:pb-10"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        tabindex="-1"
      >
        <button
          ref={closeButtonRef}
          class="text-text-muted hover:text-text focus-visible:ring-gold/60 absolute top-2 right-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-2xl leading-none transition-colors focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => void handleClose()}
          aria-label="Close"
        >
          &times;
        </button>
        {props.children}
      </div>
    </div>
  );
}
