import { createContext, createSignal, lazy, Show, useContext, type JSX } from "solid-js";

/**
 * The shell's dialogs — sign in, create account, switch profile — mounted once,
 * above the desktop/phone shell switch, so crossing 768px with one open keeps
 * it open, and what was typed in it.
 *
 * This module is in the entry chunk, which `/authorize` downloads before it can
 * paint; the dialogs reach `@osn/auth-ui`'s `SignIn` and `Register`, so they are
 * named only in a dynamic import, of one chunk that holds all three.
 */
const ShellDialogSet = lazy(() =>
  import("./ShellDialogSet").then((m) => ({ default: m.ShellDialogSet })),
);

/**
 * A dialog the shell opens. Each shell marks the control focus returns to when
 * that dialog closes with `data-dialog-return="<dialog>"`.
 */
export type ShellDialog = "sign-in" | "register" | "switcher";

type ShellDialogs = {
  /** Opens a dialog, closing any other. */
  open: (dialog: ShellDialog) => void;
  /**
   * Fetches the dialogs' chunk and mounts the dialogs once it is in. `App.tsx`
   * draws a shell only once this has resolved, so no Sign in button shows
   * before its dialog can open. A rejection is the shell's to report; calling
   * this again tries the chunk again, and mounts the dialogs if it arrives.
   */
  load: () => Promise<void>;
  /**
   * True once a load has mounted the dialogs. A Sign in drawn outside the
   * shell (a page's `SignedOutNote`) holds itself back until then, for the
   * same reason the shell does.
   */
  ready: () => boolean;
};

const ShellDialogsContext = createContext<ShellDialogs>();

/** The shell's dialogs. Throws outside `ShellDialogsProvider`. */
export function useShellDialogs(): ShellDialogs {
  const value = useContext(ShellDialogsContext);
  if (!value) throw new Error("useShellDialogs needs a ShellDialogsProvider above it");
  return value;
}

/**
 * Holds which dialog is open — one at a time — and mounts the dialogs once
 * their chunk has loaded.
 *
 * Focus goes back where it came from. No dialog here has a `Dialog.Trigger`,
 * so Kobalte has nothing to return focus to and leaves it on `<body>`. The
 * element that had focus when a dialog opened takes it back when it closes; if
 * that element is gone — the shell switched while the dialog was open — the
 * current shell's control for that dialog does. After a sign-in succeeds,
 * neither exists, and focus stays where Kobalte leaves it.
 */
export function ShellDialogsProvider(props: { children?: JSX.Element }) {
  const [current, setCurrent] = createSignal<ShellDialog | null>(null);
  // The dialogs mount when any load succeeds, so a shell that draws after a
  // retried load always has dialogs to open. `lazy` keeps no failed load, so
  // each call after a failure fetches the chunk again.
  const [ready, setReady] = createSignal(false);
  const load = () =>
    ShellDialogSet.preload().then(() => {
      setReady(true);
    });
  // Started here as well as by the shell: a failure is the shell's to report.
  load().catch(() => {});

  let opener: { element: HTMLElement | null; dialog: ShellDialog } | null = null;

  function open(dialog: ShellDialog) {
    const active = document.activeElement;
    opener = {
      element: active instanceof HTMLElement && active !== document.body ? active : null,
      dialog,
    };
    setCurrent(dialog);
  }

  function onOpenChange(dialog: ShellDialog, isOpen: boolean) {
    if (isOpen) open(dialog);
    else if (current() === dialog) setCurrent(null);
  }

  function returnFocus(event: Event) {
    const record = opener;
    opener = null;
    if (!record) return;
    const target = record.element?.isConnected
      ? record.element
      : document.querySelector<HTMLElement>(`[data-dialog-return="${record.dialog}"]`);
    if (!target) return;
    event.preventDefault();
    target.focus();
  }

  return (
    <ShellDialogsContext.Provider value={{ open, load, ready }}>
      {props.children}
      <Show when={ready()}>
        <ShellDialogSet
          open={current()}
          onOpenChange={onOpenChange}
          onCloseAutoFocus={returnFocus}
        />
      </Show>
    </ShellDialogsContext.Provider>
  );
}
