import { onMount, type JSX } from "solid-js";

interface AnimatedModalProps {
  onClose: () => void;
  children: JSX.Element;
}

export function AnimatedModal(props: AnimatedModalProps) {
  let backdropRef: HTMLDivElement;
  let panelRef: HTMLDivElement;

  onMount(async () => {
    const { modalEnter } = await import("./Modal.motion");
    modalEnter(backdropRef, panelRef);
  });

  async function handleClose() {
    const { modalExit } = await import("./Modal.motion");
    await modalExit(backdropRef, panelRef);
    props.onClose();
  }

  return (
    <div
      ref={backdropRef}
      class="fixed inset-0 z-100 flex items-end justify-center bg-black/70 opacity-0 md:items-center"
      onClick={() => handleClose()}
    >
      <div
        ref={panelRef}
        class="border-border bg-surface relative max-h-[85vh] w-full max-w-[480px] overflow-y-auto rounded-t-xl border px-6 pt-8 pb-10 opacity-0 md:mb-8 md:rounded-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button
          class="text-text-muted hover:text-text absolute top-4 right-4 cursor-pointer border-none bg-transparent p-1 text-2xl leading-none transition-colors"
          onClick={() => handleClose()}
          aria-label="Close"
        >
          &times;
        </button>
        {props.children}
      </div>
    </div>
  );
}
