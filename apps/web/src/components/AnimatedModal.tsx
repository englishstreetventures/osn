import { onMount, type JSX } from "solid-js"

interface AnimatedModalProps {
  onClose: () => void
  children: JSX.Element
}

export function AnimatedModal(props: AnimatedModalProps) {
  let backdropRef: HTMLDivElement
  let panelRef: HTMLDivElement

  onMount(async () => {
    const { modalEnter } = await import("./Modal.motion")
    modalEnter(backdropRef, panelRef)
  })

  async function handleClose() {
    const { modalExit } = await import("./Modal.motion")
    await modalExit(backdropRef, panelRef)
    props.onClose()
  }

  return (
    <div
      ref={backdropRef}
      class="fixed inset-0 z-100 flex items-end justify-center bg-black/70 opacity-0 md:items-center"
      onClick={() => handleClose()}
    >
      <div
        ref={panelRef}
        class="relative w-full max-w-[480px] max-h-[85vh] overflow-y-auto rounded-t-xl border border-border bg-surface px-6 pb-10 pt-8 opacity-0 md:rounded-lg md:mb-8"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button
          class="absolute right-4 top-4 border-none bg-transparent p-1 text-2xl leading-none text-text-muted transition-colors hover:text-text cursor-pointer"
          onClick={() => handleClose()}
          aria-label="Close"
        >
          &times;
        </button>
        {props.children}
      </div>
    </div>
  )
}
