import { TurnstileWidget } from "@osn/auth-ui/TurnstileWidget";
import { Card } from "@shared/ui/ui/card";
import { createSignal, type JSX, onCleanup } from "solid-js";

import type { Story } from "../../lab/types.ts";
import { Gallery, Mono } from "../design-system/chrome.tsx";

export const meta = { title: "osn/auth-ui/TurnstileWidget", layout: "padded" as const };

/**
 * The verification challenge on the sign-up, sign-in and recovery forms, when
 * it cannot load. The lab loads nothing from Cloudflare: each story stands in
 * a `window.turnstile` whose challenge reports an error, as Cloudflare's does
 * when a content blocker or a network filter stops it, and puts the real one
 * back, or none, when the story goes. Press Try again: the stand-in's next
 * challenge passes, drawn as a plain box, and the line goes.
 */

type StandIn = {
  render: (
    el: HTMLElement,
    opts: { callback?: (token: string) => void; "error-callback"?: () => void },
  ) => string;
  reset: () => void;
  remove: () => void;
};

/** A challenge that fails `failures` times, then passes and draws a box. */
function standIn(failures: number): StandIn {
  let left = failures;
  return {
    render(el, opts) {
      if (left > 0) {
        left -= 1;
        queueMicrotask(() => opts["error-callback"]?.());
        return `story-failed-${left}`;
      }
      el.replaceChildren();
      const box = document.createElement("div");
      box.textContent = "Challenge passed (lab stand-in)";
      box.className =
        "rounded-ui-md border border-ui-hairline px-3 py-2 text-ui-sm text-ui-ink-secondary";
      el.append(box);
      queueMicrotask(() => opts.callback?.("lab-token"));
      return "story-ok";
    },
    reset() {},
    remove() {},
  };
}

/** Stands `api` in as `window.turnstile` while the story is up. */
function WithStandIn(props: { api: StandIn; children: JSX.Element }) {
  const host = globalThis as { turnstile?: unknown };
  const before = host.turnstile;
  host.turnstile = props.api;
  onCleanup(() => {
    host.turnstile = before;
  });
  return props.children;
}

/** The form's column, as the auth dialog draws it, with the token a host would hold. */
function Form(props: { alternative?: string }) {
  const [token, setToken] = createSignal<string | null>(null);
  return (
    <Card padding="lg" class="w-full max-w-sm">
      <div class="flex flex-col gap-4">
        <TurnstileWidget siteKey="lab-sitekey" onToken={setToken} alternative={props.alternative} />
        <p class="text-ui-xs text-ui-ink-secondary">
          Token: <Mono>{token() ?? "none, so the form's submit stays disabled"}</Mono>
        </p>
      </div>
    </Card>
  );
}

function state(title: string, intro: JSX.Element, view: () => JSX.Element): Story {
  return {
    name: title,
    render: () => (
      <Gallery title={`osn/auth-ui TurnstileWidget — ${title}`} intro={intro}>
        {view()}
      </Gallery>
    ),
  };
}

export const FailedToLoad = state(
  "failed to load",
  <>
    Register's line, with no other way on: the causes a person can act on, a content blocker, an
    extension or a network that blocks <Mono>challenges.cloudflare.com</Mono>, then Try again, the
    underlined action that ends the line. It is an alert, read once. Press Try again: focus moves to
    the challenge, the line goes, and the stand-in passes.
  </>,
  () => (
    <WithStandIn api={standIn(1)}>
      <Form />
    </WithStandIn>
  ),
);

export const FailedWithAlternative = state(
  "failed, with a way on",
  <>
    Sign-in's line adds the way on that needs no challenge, which the host passes as{" "}
    <Mono>alternative</Mono>. This stand-in fails twice, so a second failure brings the line back
    and it is read out again.
  </>,
  () => (
    <WithStandIn api={standIn(2)}>
      <Form alternative="Signing in with a recovery code doesn't need this challenge: choose “Lost your passkey?”." />
    </WithStandIn>
  ),
);
