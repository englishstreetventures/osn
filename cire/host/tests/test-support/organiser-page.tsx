import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Mock } from "vitest";

import type { WeddingSummary } from "../../src/components/CreateWeddingForm";
import ModuleShell from "../../src/components/ModuleShell";
import TopBar from "../../src/components/TopBar";
import type { Module } from "../../src/lib/dashboard-route";

/**
 * The organiser page as the browser tier draws it: the `frame` container, the
 * real `TopBar` and the page measure, both inside `.chrome-scope` as
 * `OrganiserApp` puts them, and the real `ModuleShell`. The top bar is the
 * real one so that every layer measured under it is measured against the bar
 * a host sees, not a copy that takes its height from the same token.
 *
 * The module and sub-tab are signals the shell's own `onModule` and `onSub`
 * write, so a click on a sub-tab navigates as it does in the app. Requests are
 * answered by URL from `routes`; a route may be a function, so a test can hold
 * one back (a deferred promise) and release it by hand, or answer with a
 * `Response` of its own to fail it.
 *
 * The `vi.mock` blocks stay in each test file — a factory there cannot import
 * from here in the browser project — and the file hands its `authFetch` mock
 * in.
 */

type Body = unknown | (() => unknown | Promise<unknown>);

export interface PageRoutes {
  rsvps?: Body;
  guests?: Body;
  events?: Body;
  households?: Body;
  /** `GET …/invite` — Households reads the invite message from it. */
  invite?: Body;
  /** `GET …/invite?include=faqs` — the invite builder's customisation. */
  customisation?: Body;
  /** `GET …/changes/head`. */
  head?: string;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** A route's answer: its body as JSON, or a `Response` it built itself — a
 *  failure, say. */
async function answer(body: Body): Promise<Response> {
  const value = typeof body === "function" ? await (body as () => unknown)() : body;
  return value instanceof Response ? value : json(value);
}

/** Answer every request by its path. Anything unrouted gets `{}`. */
export function routeFetch(authFetch: Mock, routes: PageRoutes): void {
  authFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    if (url.includes("/invite?include=faqs")) return answer(routes.customisation ?? {});
    if (path.endsWith("/rsvps")) return answer(routes.rsvps ?? { events: [] });
    if (path.endsWith("/guests")) return answer(routes.guests ?? []);
    if (path.endsWith("/events")) return answer(routes.events ?? []);
    if (path.endsWith("/households")) return answer(routes.households ?? []);
    if (path.endsWith("/invite")) return answer(routes.invite ?? { inviteMessage: null });
    if (path.endsWith("/changes/head")) return json({ revision: routes.head ?? "rev_1" });
    return json({});
  });
}

export interface PageOptions {
  module: Module;
  sub: string;
  canEdit?: boolean;
  canManage?: boolean;
  rsvpEvent?: string;
  onRsvpEvent?: (eventId: string) => void;
}

const WEDDING: WeddingSummary = {
  id: "wed_1",
  slug: "rosa-and-viktor",
  displayName: "Rosa & Viktor",
  role: "owner",
  entitlements: [],
  guestCap: 1000,
};

const SESSION = {
  osnProfileId: "usr_1",
  email: "rosa@example.com",
  handle: "rosa",
  displayName: "Rosa Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

/** The page's top bar: the real one, the first child of `.chrome-scope`. */
export const topBar = () => document.querySelector<HTMLElement>(".chrome-scope > header")!;

export interface OrganiserPage {
  unmount: () => void;
  container: HTMLElement;
  module: () => Module;
  sub: () => string;
  setModule: (module: Module) => void;
  setSub: (sub: string) => void;
}

/** Draw the page. Returns the route, its setters and the unmount. */
export function renderOrganiserPage(opts: PageOptions): OrganiserPage {
  const [module, setModule] = createSignal<Module>(opts.module);
  const [sub, setSub] = createSignal(opts.sub);
  const [rsvpEvent, setRsvpEvent] = createSignal(opts.rsvpEvent);
  const result = render(() => (
    <div class="@container/frame">
      <div class="chrome-scope contents">
        <TopBar
          session={SESSION}
          wedding={WEDDING}
          weddings={[WEDDING]}
          sectionLabel="All weddings"
          onWedding={() => {}}
          onAll={() => {}}
          onSecurity={() => {}}
          onSignOut={() => {}}
          onOpenPalette={() => {}}
        />
        <main class="page-frame @container/page flex flex-col gap-8 py-8 @2xl/frame:py-10">
          <ModuleShell
            weddingId="wed_1"
            weddingName="Rosa & Viktor"
            weddingSlug="rosa-and-viktor"
            callerRole={opts.canManage === false ? "editor" : "owner"}
            canManage={opts.canManage ?? true}
            canEdit={opts.canEdit ?? true}
            module={module()}
            sub={sub()}
            onModule={(next, nextSub) => {
              setModule(next);
              setSub(nextSub ?? "");
            }}
            onSub={setSub}
            rsvpEvent={rsvpEvent()}
            onRsvpEvent={(id) => {
              setRsvpEvent(id);
              opts.onRsvpEvent?.(id);
            }}
            tier="crimson"
            entitlements={[]}
            guestCap={1000}
          />
        </main>
      </div>
    </div>
  ));
  return {
    unmount: result.unmount,
    container: result.container,
    module,
    sub,
    setModule: (next) => setModule(next),
    setSub: (next) => setSub(next),
  };
}
