import { AuthHeader, type AuthHeaderProps, type PageHostHeader } from "@osn/auth-ui/AuthHeader";
import { Button } from "@shared/ui/ui/button";
import { Dialog, DialogContent } from "@shared/ui/ui/dialog";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";

/**
 * The title row of the sign-in and create-account views, and of every dialog
 * `@osn/auth-ui` draws, in both hosts it has. A dialog story opens the real
 * sheet, `@shared/ui`'s `Dialog`, which portals to `<body>` and covers the
 * lab: press Escape to close it, and the story's button to open it again. In
 * a dialog the header holds the title alone, centred; the dialog's Cancel is
 * its footer's, which the views' own stories draw. Below 768px it is a bottom
 * sheet; narrow the window, or open `Phone`. A page story draws the header in
 * the column `/authorize` gives it, under a stand-in for the app's name.
 *
 * The colours and type steps are musubi's, the lab's own mapping, so the
 * **light · dark** toggle is the theme check. No view is mounted: the sheet's
 * body says what the dialog is named, read from the page.
 */
export const meta = { title: "osn/auth-ui/AuthHeader", layout: "padded" as const };

/**
 * A page story's header: `cancel` gives it a Cancel, which does nothing here.
 * A dialog's header takes the title alone.
 */
type PageProps = Omit<PageHostHeader, "host" | "onCancel"> & { cancel?: boolean };

/** `props` as `AuthHeader` takes them on a page, with a Cancel that does nothing. */
function PageHeader(props: PageProps) {
  return (
    <AuthHeader
      host="page"
      title={props.title}
      cancelLabel={props.cancelLabel}
      cancelDisabled={props.cancelDisabled}
      onCancel={props.cancel ? () => {} : undefined}
    />
  );
}

/** The dialog's accessible name, as a screen reader hears it: the text of the element its `aria-labelledby` names. */
function DialogName() {
  const [name, setName] = createSignal<string>();
  let line: HTMLParagraphElement | undefined;
  onMount(() => {
    const dialog = line?.closest('[role="dialog"]');
    const read = () => {
      const id = dialog?.getAttribute("aria-labelledby");
      setName((id && document.getElementById(id)?.textContent) || undefined);
    };
    read();
    // The dialog takes its `aria-labelledby` a tick after it mounts, and the
    // title can change while it is open (the playground's text box). The
    // dialog as a whole is watched, not its title, which is replaced when one
    // header replaces another. This line's own text changing is skipped.
    const observer = new MutationObserver((records) => {
      if (records.every((record) => line?.contains(record.target))) return;
      read();
    });
    if (dialog) {
      observer.observe(dialog, {
        subtree: true,
        characterData: true,
        childList: true,
        attributeFilter: ["aria-labelledby"],
      });
    }
    onCleanup(() => observer.disconnect());
  });
  return (
    <p ref={line} class="text-ui-ink-secondary text-ui-sm">
      <Show when={name()} fallback="This dialog has no accessible name.">
        {(text) => <>This dialog is named “{text()}”.</>}
      </Show>
    </p>
  );
}

/**
 * The opener, and the sheet open over it, sized as musubi's auth dialogs are:
 * a bottom sheet below `md`, a 384px card from it. Escape closes it.
 */
function DialogBench(props: { title: string; body?: JSX.Element }) {
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open the dialog
      </Button>
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent presentation="sheet" class="md:max-w-sm">
          <AuthHeader host="dialog" title={props.title} />
          <div class="flex flex-col gap-4 p-4">
            {props.body}
            <DialogName />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * `/authorize`'s column, with no frame round the panel, under a stand-in for the
 * client card's name. The page pads it 24px a side (`max-w-md px-6`); below
 * `md` the lab's own 32px stands in for that, so a 320px frame gives the
 * header 256px against the page's 272px.
 */
function PageColumn(props: { children: JSX.Element }) {
  return (
    <div class="w-full max-w-md py-6 md:px-6">
      {/* Stands in for the client card's `h1` at `text-display`, which the host
          draws; a `p` so the lab page keeps one `h1`. */}
      <div class="flex flex-col items-center text-center">
        <p class="text-ui-ink text-ui-xl font-medium">Pulse</p>
        <p class="text-ui-ink-secondary text-ui-sm mt-1">wants to use your Musubi account</p>
      </div>
      <div class="mt-6">{props.children}</div>
    </div>
  );
}

function inDialog(title: string, intro: JSX.Element, header: string): Story {
  return {
    render: () => (
      <Gallery title={`osn/auth-ui AuthHeader — ${title}`} intro={intro}>
        <DialogBench title={header} />
      </Gallery>
    ),
  };
}

function onPage(title: string, intro: JSX.Element, props: PageProps): Story {
  return {
    render: () => (
      <Gallery title={`osn/auth-ui AuthHeader — ${title}`} intro={intro}>
        <PageColumn>
          <PageHeader {...props} />
        </PageColumn>
      </Gallery>
    ),
  };
}

export const InDialog = inDialog(
  "sign in, in a dialog",
  <>
    What opens on "Sign in": the title alone, centred, which names the dialog. The dialog's Cancel
    is its footer's, first beside the step's action (the <Mono>SignIn</Mono> story).
  </>,
  "Sign in to Musubi",
);

export const InDialogRegister = inDialog(
  "create an account, in a dialog",
  <>What opens on "Create account".</>,
  "Create your Musubi account",
);

export const LongTitle = inDialog(
  "a long title",
  <>A host whose product name is long: the title wraps, each line centred in the sheet.</>,
  "Create your Musubi for Organisations and Communities account",
);

export const CancelDisabled = onPage(
  "while a call runs, on /authorize",
  <>
    The view's call under way (<Mono>cancelDisabled</Mono>): Cancel is disabled, so nothing leaves
    the view meanwhile.
  </>,
  {
    title: "Create your Musubi account",
    cancel: true,
    cancelLabel: "Sign in instead",
    cancelDisabled: true,
  },
);

export const OnPage = onPage(
  "sign in, on /authorize",
  <>
    The sign-in view on <Mono>/authorize</Mono>: a plain heading in the dialog title's type, under
    the app's name, with no padding, rule or Cancel of its own. The app's name is the host's; the
    one here stands in for it.
  </>,
  { title: "Sign in to Musubi" },
);

export const OnPageWithCancel = onPage(
  "create an account, on /authorize",
  <>
    The create-account view on <Mono>/authorize</Mono>, where going back means signing in instead,
    so the host names Cancel with <Mono>cancelLabel</Mono>. On a page it is <Mono>ghost</Mono>: it
    switches views and dismisses nothing.
  </>,
  { title: "Create your Musubi account", cancel: true, cancelLabel: "Sign in instead" },
);

export const BothHosts: Story = {
  render: () => (
    <Gallery
      title="osn/auth-ui AuthHeader — both hosts"
      intro={
        <>
          The dialog host's header at the top of the sheet, and the page host's under it with the
          same title. The two titles should match in size, weight and colour: the page's{" "}
          <Mono>h2</Mono> copies <Mono>DialogTitle</Mono>'s classes, so a difference here means one
          changed without the other.
        </>
      }
    >
      <DialogBench
        title="Sign in to Musubi"
        body={
          <>
            <p class="text-ui-ink-secondary text-ui-sm">
              Above: <Mono>host="dialog"</Mono>. Below: <Mono>host="page"</Mono>.
            </p>
            <AuthHeader host="page" title="Sign in to Musubi" onCancel={() => {}} />
          </>
        }
      />
    </Gallery>
  ),
};

const PHONE_STORIES = ["InDialog", "LongTitle", "OnPage", "OnPageWithCancel"] as const;

/**
 * The sheet face shows only on a screen narrower than 768px, so each frame
 * here is the lab itself, bare, in a 320px window. Frames load when asked:
 * each is a second copy of the lab.
 */
export const Phone: Story = {
  render: () => {
    const [shown, setShown] = createSignal(false);
    return (
      <Gallery
        title="osn/auth-ui AuthHeader — a 320px phone"
        intro={
          <>
            The narrowest supported phone: the sign-in sheet, a long title, and both page views,
            each the story of that name in a 320 × 640 frame. A page's Cancel is 40px tall below{" "}
            <Mono>md</Mono>.
          </>
        }
      >
        <Show
          when={shown()}
          fallback={
            <Button variant="outline" onClick={() => setShown(true)}>
              Load the four frames
            </Button>
          }
        >
          <div class="flex flex-wrap gap-4">
            <For each={PHONE_STORIES}>
              {(name) => (
                <iframe
                  title={`AuthHeader ${name} at 320px`}
                  src={`?bare#/osn/auth-ui/AuthHeader/${name}`}
                  width="320"
                  height="640"
                  class="border-ui-hairline rounded-ui-md border"
                />
              )}
            </For>
          </div>
        </Show>
      </Gallery>
    );
  },
};

type PlaygroundArgs = {
  host: AuthHeaderProps["host"];
  title: string;
  cancel: boolean;
  cancelLabel: string;
  cancelDisabled: boolean;
};

export const Playground: Story<PlaygroundArgs> = {
  args: {
    host: "dialog",
    title: "Sign in to Musubi",
    cancel: true,
    cancelLabel: "",
    cancelDisabled: false,
  },
  controls: {
    host: { kind: "select", options: ["dialog", "page"] },
  },
  render: (args) => {
    const props = (): PageProps => ({
      title: args.title,
      cancel: args.cancel,
      cancelLabel: args.cancelLabel,
      cancelDisabled: args.cancelDisabled,
    });
    return (
      <Gallery
        title="osn/auth-ui AuthHeader — playground"
        intro={
          <>
            The host and the title; on a page, Cancel, its words, and Cancel disabled. A dialog
            header holds the title alone and renders only inside its sheet; a page header only
            outside one.
          </>
        }
      >
        <Show
          when={args.host === "dialog"}
          fallback={
            <PageColumn>
              <PageHeader {...props()} />
            </PageColumn>
          }
        >
          <DialogBench title={args.title} />
        </Show>
      </Gallery>
    );
  },
};
