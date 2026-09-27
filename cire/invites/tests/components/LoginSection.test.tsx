import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM_SESSION_EVENT } from "../../src/components/claim-session";
import { LoginSection, type LoginSectionLayout } from "../../src/components/LoginSection";
import type { RsvpDeadlineState } from "../../src/components/rsvp-deadline";
import type {
  AccountLinkState,
  ClaimResult,
  FamilyMember,
  RsvpDeadline,
} from "../../src/components/types";

// The account-link panel is stubbed file-wide. Its own behaviour is covered in
// PulseAccountLink.test.tsx; what this file asserts is where the panel puts it,
// when, and what it hands it.
vi.mock("../../src/components/PulseAccountLink", () => ({
  PulseAccountLink: (props: {
    apiUrl: string;
    members: FamilyMember[];
    state: AccountLinkState;
    class?: string;
  }) => (
    <div
      data-testid="pulse-account-link-stub"
      class={props.class}
      data-api-url={props.apiUrl}
      data-members={props.members.map((m) => m.guestId).join(",")}
      data-signed-in={String(props.state.signedIn)}
      data-linked={props.state.linkedGuestIds.join(",")}
    />
  ),
}));

// Turnstile off by default, which is what the real widget reports with no
// sitekey configured. A test that needs the challenge turns it on and drives
// the token by hand.
const turnstile = vi.hoisted(() => ({
  enabled: false,
  reset: vi.fn(),
  onToken: undefined as ((token: string | null) => void) | undefined,
}));

vi.mock("../../src/components/TurnstileWidget", () => ({
  turnstileEnabled: () => turnstile.enabled,
  TurnstileWidget: (props: {
    onToken: (token: string | null) => void;
    controls?: (handle: { reset: () => void }) => void;
  }) => {
    turnstile.onToken = props.onToken;
    props.controls?.({ reset: turnstile.reset });
    return null;
  },
}));

/** Answers every request with an empty 204 unless a test installs its own. */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  turnstile.enabled = false;
  turnstile.reset.mockClear();
  turnstile.onToken = undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The claim and sign-out paths write the restore hint; keep it from leaking
  // into the next case.
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
});

function member(firstName: string, nickname: string | null = null): FamilyMember {
  return { guestId: `g-${firstName}`, firstName, lastName: "Okafor", nickname, eventIds: [] };
}

function result(members: FamilyMember[], familyName = "Okafor"): ClaimResult {
  return { publicId: "OKAFOR-LILY-AB12CD", familyName, members, events: [], rsvps: [] };
}

/** A claim payload that offers this household account linking. */
function offeringLink(
  claim: ClaimResult,
  state: { signedIn: boolean; linkedGuestIds: string[] } = { signedIn: false, linkedGuestIds: [] },
): ClaimResult {
  return { ...claim, accountLink: { enabled: true, ...state } };
}

const noop = () => {};

/** Let a `lazy()` import and its Suspense boundary settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("LoginSection greeting", () => {
  it("greets a multi-guest code as a family", () => {
    const { container } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={result([member("Chidi"), member("Ada")])}
        onClaimed={noop}
      />
    ));
    const text = container.textContent ?? "";
    expect(text).toContain("Welcome, the Okafor Family");
    // The household members are listed and the individual "Dear" greeting is absent.
    expect(text).toContain("Chidi");
    expect(text).toContain("Ada");
    expect(text).not.toContain("Dear");
  });

  it("greets a single-guest code as an individual by first name", () => {
    const { container } = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi")])} onClaimed={noop} />
    ));
    const text = container.textContent ?? "";
    expect(text).toContain("Dear");
    expect(text).toContain("Chidi");
    // A lone guest is never greeted as a "Family".
    expect(text).not.toContain("Family");
  });

  it("greets a single guest by nickname when one is set", () => {
    const { container } = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi", "Chi")])} onClaimed={noop} />
    ));
    const text = container.textContent ?? "";
    expect(text).toContain("Dear");
    expect(text).toContain("Chi");
    // The nickname replaces the first name in the individual greeting.
    expect(text).not.toContain("Chidi");
    expect(text).not.toContain("Family");
  });

  it("falls back to the first name when the nickname is blank/whitespace", () => {
    const { container } = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi", "   ")])} onClaimed={noop} />
    ));
    const text = container.textContent ?? "";
    expect(text).toContain("Dear");
    expect(text).toContain("Chidi");
  });

  it("shows the built-in greeting line when no override is set", () => {
    const { container } = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi")])} onClaimed={noop} />
    ));
    expect(container.textContent).toContain("We are delighted to invite you to celebrate with us.");
  });

  it("renders the organiser's welcome greeting override for both family and individual codes", () => {
    const greeting = "Nau mai, haere mai — we can't wait to see you!";
    const family = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={result([member("Chidi"), member("Ada")])}
        onClaimed={noop}
        welcomeMessage={greeting}
      />
    ));
    expect(family.container.textContent).toContain(greeting);
    expect(family.container.textContent).not.toContain("We are delighted to invite you");
    cleanup();

    const individual = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={result([member("Chidi")])}
        onClaimed={noop}
        welcomeMessage={greeting}
      />
    ));
    expect(individual.container.textContent).toContain(greeting);
    expect(individual.container.textContent).not.toContain("We are delighted to invite you");
  });
});

describe("LoginSection form/welcome swap", () => {
  // Anchored to content, not to sibling order: a positional
  // `section > div > div` lookup silently re-points at the wrong element the
  // day a wrapper or a third sibling is added, and an assertion on the wrong
  // element passes for the wrong reason instead of failing.
  const panels = (container: HTMLElement) => {
    const form = container.querySelector("form")?.closest("div") as HTMLElement;
    const welcome = form.nextElementSibling as HTMLElement;
    return { form, welcome };
  };

  it("follows `revealed` in BOTH directions", () => {
    // The point of the prop. `display` has exactly one owner, so the swap is
    // reversible — the failure it replaced was an imperative
    // `style.display = "none"` from the unlock animation, which desynchronised
    // Solid's binding: Solid went on believing `display` was `""`, so every
    // later attempt to show the form again was a diff it skipped, and the code
    // form could never come back for the life of the page.
    const [revealed, setRevealed] = createSignal(false);
    const { container } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={result([member("Chidi")])}
        revealed={revealed()}
        onClaimed={noop}
      />
    ));

    expect(panels(container).form.style.display).toBe("");
    expect(panels(container).welcome.style.display).toBe("none");

    setRevealed(true);
    expect(panels(container).form.style.display).toBe("none");
    expect(panels(container).welcome.style.display).toBe("");

    // Back again — a sign-out, or a claim rolled back after a failed follow-up.
    setRevealed(false);
    expect(panels(container).form.style.display).toBe("");
    expect(panels(container).welcome.style.display).toBe("none");
  });

  it("falls back to `result` when no `revealed` is passed", () => {
    // Callers that don't choreograph the unlock (and every greeting test above)
    // get the plain instant swap.
    const claimed = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi")])} onClaimed={noop} />
    ));
    expect(panels(claimed.container).form.style.display).toBe("none");
    expect(panels(claimed.container).welcome.style.display).toBe("");
    cleanup();

    const unclaimed = render(() => (
      <LoginSection apiUrl="http://x" result={null} onClaimed={noop} />
    ));
    expect(panels(unclaimed.container).form.style.display).toBe("");
    expect(panels(unclaimed.container).welcome.style.display).toBe("none");
  });
});

describe("LoginSection sign-out control", () => {
  it("is absent without a handler", () => {
    const { queryByText } = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi")])} onClaimed={noop} />
    ));
    expect(queryByText(/Sign out/)).toBeNull();
  });

  it("clears the code field and calls the sign-out handler on click", () => {
    const onSignOut = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={result([member("Chidi")])}
        onClaimed={noop}
        onSignOut={onSignOut}
      />
    ));

    const input = getByLabelText("Invitation code") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "OKAFOR-LILY-AB12CD" } });

    fireEvent.click(getByText(/Sign out/));

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
  });

  it("revokes the household session itself, so no design pack can forget to", async () => {
    // `cire_session` is HttpOnly and host-scoped to the API origin: only this
    // request can end it. The panel sends it, rather than trusting each pack's
    // handler to, so a pack that renders the control cannot ship one that only
    // resets the screen and leaves a live credential behind.
    document.cookie = "cire_claimed=1; Path=/";
    const { getByText } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={result([member("Chidi")])}
        onClaimed={noop}
        onSignOut={noop}
      />
    ));

    fireEvent.click(getByText(/Sign out/));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) => url === "https://api.test/api/claim/signout",
      );
      expect(call, "no sign-out request was sent").toBeTruthy();
      expect((call![1] as RequestInit).method).toBe("POST");
      expect((call![1] as RequestInit).credentials).toBe("include");
    });
    // The restore hint goes with it, so the next visit shows the code form.
    expect(document.cookie).not.toContain("cire_claimed=1");
  });

  it("ends the account-linking sign-in too, so the next household starts signed out", async () => {
    // The Pulse link beside this control signs in to cire-api's OSN session,
    // which the household cookie does not cover. Left in place on a shared
    // device, the next household to claim would find it still signed in and
    // could bind one of its seats to the previous guest's account.
    const { getByText } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={result([member("Chidi")])}
        onClaimed={noop}
        onSignOut={noop}
      />
    ));

    fireEvent.click(getByText(/Sign out/));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) => url === "https://api.test/api/auth/signout",
      );
      expect(call, "the OSN sign-in was left in place").toBeTruthy();
      expect((call![1] as RequestInit).method).toBe("POST");
      expect((call![1] as RequestInit).credentials).toBe("include");
    });
  });

  it("leaves an organiser previewing their own invite signed in to the portal", async () => {
    // Host preview never shows the account link, and the same OSN session is
    // the organiser's sign-in to the host portal.
    const { getByText } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={{ ...result([member("Chidi")]), preview: true }}
        onClaimed={noop}
        onSignOut={noop}
      />
    ));

    fireEvent.click(getByText(/Sign out/));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "https://api.test/api/claim/signout"),
      ).toBe(true),
    );
    await settle();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/"))).toBe(false);
  });

  it("clears what the unlock animation left on the form, so it comes back painted", () => {
    // The packs' unlock sequence fades the form out and leaves its end state
    // inline (`opacity: 0` plus a `translateY`). Solid's binding on the element
    // owns only `display`, so without this the form returns to the layout
    // fully transparent. Measured for real in InvitePage.browser.test.tsx.
    let formEl: HTMLDivElement | undefined;
    const { getByText } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={result([member("Chidi")])}
        onClaimed={noop}
        onSignOut={noop}
        formRef={(el) => (formEl = el)}
      />
    ));
    formEl!.style.opacity = "0";
    formEl!.style.transform = "translateY(-8px)";

    fireEvent.click(getByText(/Sign out/));

    expect(formEl!.style.opacity).toBe("");
    expect(formEl!.style.transform).toBe("");
  });

  it("moves focus to the code field once the page has swapped the form back", () => {
    // The click removes the focused button from the accessibility tree; without
    // this, focus falls to <body>. The page resets its own state inside
    // `onSignOut`, so the field is displayed by the time focus moves.
    const [claimed, setClaimed] = createSignal<ClaimResult | null>(result([member("Chidi")]));
    const { getByText, getByLabelText } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={claimed()}
        onClaimed={noop}
        onSignOut={() => setClaimed(null)}
      />
    ));

    fireEvent.click(getByText(/Sign out/));

    expect(document.activeElement).toBe(getByLabelText("Invitation code"));
  });

  it("asks Turnstile for a fresh challenge, so a second code can be claimed", () => {
    // Turnstile tokens are single use and the claim that just succeeded spent
    // this one. Without a new challenge the submit stays disabled for good, and
    // a guest on a shared device cannot open another household's invite
    // without reloading the page.
    turnstile.enabled = true;
    const [claimed, setClaimed] = createSignal<ClaimResult | null>(result([member("Chidi")]));
    const { getByText, getByLabelText } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={claimed()}
        onClaimed={noop}
        onSignOut={() => setClaimed(null)}
      />
    ));
    turnstile.onToken?.("spent-token");

    fireEvent.click(getByText(/Sign out/));

    expect(turnstile.reset).toHaveBeenCalledTimes(1);
    fireEvent.input(getByLabelText("Invitation code"), { target: { value: "PATEL-JOY-RK97" } });
    const submit = getByText("Open Invitation") as HTMLButtonElement;
    // The spent token is gone with the old claim…
    expect(submit.disabled).toBe(true);
    // …and the fresh challenge is what lets the guest submit again.
    turnstile.onToken?.("fresh-token");
    expect(submit.disabled).toBe(false);
  });
});

describe("LoginSection claim", () => {
  it("records the household session hint when a code is claimed", async () => {
    // The page's restore reads this hint to decide whether a returning visitor
    // is worth a request. The panel writes it, beside the claim it stands for,
    // so a design pack cannot open the invite without leaving it.
    const claimed = result([member("Chidi")]);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(claimed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onClaimed = vi.fn();
    // Other islands (the gift-list band) re-read the session when this fires.
    // It must come after the page's handler, so the page has its result
    // before anything else hears of the claim.
    const claimedBeforeAnnounce: number[] = [];
    const listener = () => claimedBeforeAnnounce.push(onClaimed.mock.calls.length);
    window.addEventListener(CLAIM_SESSION_EVENT, listener);
    const { getByLabelText, getByText } = render(() => (
      <LoginSection apiUrl="https://api.test" result={null} onClaimed={onClaimed} />
    ));

    fireEvent.input(getByLabelText("Invitation code"), {
      target: { value: "OKAFOR-LILY-AB12CD" },
    });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
    window.removeEventListener(CLAIM_SESSION_EVENT, listener);
    expect(onClaimed.mock.calls[0]![0]).toEqual(claimed);
    expect(document.cookie).toContain("cire_claimed=1");
    expect(claimedBeforeAnnounce).toEqual([1]);
  });

  it("writes no hint when the claim fails", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const onClaimed = vi.fn();
    const { getByLabelText, getByText, findByRole } = render(() => (
      <LoginSection apiUrl="https://api.test" result={null} onClaimed={onClaimed} />
    ));

    fireEvent.input(getByLabelText("Invitation code"), { target: { value: "WRONG-CODE" } });
    fireEvent.click(getByText("Open Invitation"));

    await findByRole("alert");
    expect(onClaimed).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("cire_claimed=1");
  });
});

describe("LoginSection layout", () => {
  const surface = { "--invite-section-bg": "var(--color-surface)" };

  /** The element that paints the welcome tone. */
  function painted(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("[style]")].filter(
      (el) => el.style.getPropertyValue("background-color") === "var(--invite-section-bg)",
    );
  }

  it("band: paints the tone across the whole section, on a centred column", () => {
    // Classic's shape, and the default — a pack that passes no layout gets a
    // working panel with no markup of its own.
    const { container, getByText } = render(() => (
      <LoginSection apiUrl="http://x" result={null} onClaimed={noop} themeVars={surface} />
    ));
    const section = getByText("Enter Your Code").closest("section") as HTMLElement;

    expect(painted(container)).toEqual([section]);
    expect(section.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-surface)");
    expect(section.className).toContain("border-b");
    expect(getByText("Enter Your Code").closest(".text-center")).not.toBeNull();
    // No inset card inside the band (the field and the preview chip draw their
    // own borders; neither is a `div`).
    expect(section.querySelector("div.rounded-sm.border")).toBeNull();
  });

  it("panel: paints only a bordered card, centred on phones and flush left from md", () => {
    // Gala's shape. The tone belongs to the card, not the section around it:
    // painting the section would turn the inset card back into a band.
    const { container, getByText } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={null}
        onClaimed={noop}
        themeVars={surface}
        layout="panel"
      />
    ));
    const section = getByText("Enter Your Code").closest("section") as HTMLElement;
    const [card] = painted(container);

    expect(painted(container)).toHaveLength(1);
    expect(card).not.toBe(section);
    expect(section.contains(card!)).toBe(true);
    expect(card!.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-surface)");
    const classes = card!.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["border", "max-w-column-xs", "md:mx-0"]));
    // Left-aligned copy, against the band's centred column.
    expect(getByText("Enter Your Code").closest(".text-center")).toBeNull();
  });

  it.each<LoginSectionLayout>(["band", "panel"])(
    "%s: every heading follows the organiser's heading typography",
    (layout) => {
      const { container } = render(() => (
        <LoginSection apiUrl="http://x" result={null} onClaimed={noop} layout={layout} />
      ));
      const headings = [...container.querySelectorAll("h2")];
      // The code-entry heading plus both greetings (only one is displayed at a
      // time, but a claim with no result renders the fallback greeting).
      expect(headings.length).toBeGreaterThanOrEqual(2);
      for (const h of headings) {
        expect(h.className).toContain("*var(--invite-heading-scale,1))]");
        expect(h.className).toContain("[font-weight:var(--invite-heading-weight,300)]");
        expect(h.className).toContain("[font-style:var(--invite-heading-style,normal)]");
        expect(h.className).not.toContain("font-light");
      }
    },
  );

  it("greets in the metal gold only where the heading is large text", () => {
    // `text-gold` is held to the 3:1 UI floor, so it may only paint text that
    // WCAG counts as large: the band's heading is at least 2rem × 0.85. The
    // panel's starts at 1.5rem, which is not, so it takes the ink gold.
    const band = render(() => (
      <LoginSection apiUrl="http://x" result={result([member("Chidi")])} onClaimed={noop} />
    ));
    const bandGreeting = band.getByText(/Dear Chidi/);
    expect(bandGreeting.className.split(/\s+/)).toContain("text-gold");
    cleanup();

    const panel = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={result([member("Chidi")])}
        onClaimed={noop}
        layout="panel"
      />
    ));
    const classes = panel.getByText(/Dear Chidi/).className.split(/\s+/);
    expect(classes).toContain("text-gold-ink");
    expect(classes).not.toContain("text-gold");
  });
});

describe("LoginSection household controls", () => {
  it("puts the account link inside the welcome half, before the sign-out", async () => {
    const { findByTestId, getByText, container } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={offeringLink(result([member("Chidi"), member("Ada")]))}
        onClaimed={noop}
        onSignOut={noop}
      />
    ));

    const link = await findByTestId("pulse-account-link-stub");
    const welcome = getByText(/Welcome, the Okafor Family/).parentElement as HTMLElement;
    expect(welcome.contains(link)).toBe(true);
    expect(container.querySelector("form")!.contains(link)).toBe(false);
    // The seats it offers are this household's.
    expect(link.dataset.members).toBe("g-Chidi,g-Ada");
    // Sign-out ends the session, so it closes the panel.
    const signOut = getByText(/Sign out/);
    expect(link.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    // The band's measure centres it in the column…
    ["band", ["max-w-column-sm", "mx-auto", "mb-8"], []],
    // …while the panel's card is the measure, and its copy runs flush left.
    ["panel", ["mb-8"], ["mx-auto", "max-w-column-sm"]],
  ] as const)(
    "%s: places the account link on the panel's own measure",
    async (layout, expected, absent) => {
      const { findByTestId } = render(() => (
        <LoginSection
          apiUrl="http://x"
          result={offeringLink(result([member("Chidi")]))}
          onClaimed={noop}
          layout={layout}
        />
      ));
      const classes = (await findByTestId("pulse-account-link-stub")).className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining([...expected]));
      expect(classes.filter((c) => (absent as readonly string[]).includes(c))).toEqual([]);
    },
  );

  it("points the account link at the invite's API and hands it the payload's state", async () => {
    // A wrong or missing origin here would send every link and sign-in to the
    // wrong place with nothing to report it.
    const { findByTestId } = render(() => (
      <LoginSection
        apiUrl="https://api.test"
        result={offeringLink(result([member("Chidi"), member("Ada")]), {
          signedIn: true,
          linkedGuestIds: ["g-Ada"],
        })}
        onClaimed={noop}
      />
    ));
    const link = await findByTestId("pulse-account-link-stub");
    expect(link.dataset.apiUrl).toBe("https://api.test");
    expect(link.dataset.signedIn).toBe("true");
    expect(link.dataset.linked).toBe("g-Ada");
  });

  it.each([
    ["linking is off for the household", { enabled: false }],
    ["the payload carries no link state (an API older than the site)", undefined],
    ["the link state is malformed", { enabled: true, signedIn: "yes", linkedGuestIds: [] }],
    ["the link state is a shape this build does not know", { enabled: "partly" }],
  ])("offers no account link when %s", async (_, accountLink) => {
    const { queryByTestId, getByText } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={{ ...result([member("Chidi")]), accountLink }}
        onClaimed={noop}
      />
    ));
    await settle();
    // The invite itself opens as normal: only the optional box is missing.
    expect(getByText(/Dear Chidi/)).toBeTruthy();
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();
  });

  it("offers no account link before a claim", async () => {
    const { queryByTestId } = render(() => (
      <LoginSection apiUrl="http://x" result={null} onClaimed={noop} />
    ));
    await settle();
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();
  });

  it("offers no account link in host preview — a host is not a guest seat", async () => {
    const { queryByTestId, getByText } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={{ ...offeringLink(result([member("Chidi")])), preview: true }}
        onClaimed={noop}
      />
    ));
    await settle();
    expect(getByText(/Preview mode/)).toBeTruthy();
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();
  });
});

describe("LoginSection code field", () => {
  function codeInput() {
    const { container } = render(() => (
      <LoginSection apiUrl="http://x" result={null} onClaimed={noop} />
    ));
    const input = container.querySelector("input[type=text]");
    expect(input).not.toBeNull();
    return input as HTMLInputElement;
  }

  // jsdom computes no colours, so the contrast contract is pinned as classes —
  // the same tactic the sticky-footer and grid-column contracts use. The alphas
  // were chosen by compositing over every `PALETTE_PRESETS` entry × all three
  // section tones in a real browser: the border clears WCAG SC 1.4.11's 3:1 on
  // the WORST pair (garden/ground, 3.23:1; it was 1.27:1 before), and the fill
  // lifts the field off its section from 1.00:1 — literally indistinguishable —
  // to ~1.09:1.
  it("draws the field one step off whatever surface it sits on", () => {
    const cls = codeInput().className;
    // Ink-at-alpha, NOT a surface token: the organiser chooses this section's
    // tone (ground / card / raised), so a fixed surface token would vanish on
    // the tone that matches it. Ink adapts to any palette in the right
    // direction — darkening a light scheme, lightening a dark one.
    expect(cls).toContain("bg-text/[0.045]");
    expect(cls).toContain("border-text/55");
    // `border-border` is the same ink at 0.12 — the hairline this replaced, and
    // the reason the field read as flat page on a pale scheme.
    expect(cls).not.toContain("border-border");
    // A fill means the field is no longer see-through.
    expect(cls).not.toContain("bg-transparent");
  });

  it("gives the field an accessible name that outlives the placeholder", () => {
    // A placeholder is not an accessible name and disappears on input, so
    // without this the page's only control is an unnamed edit field to a screen
    // reader or voice control (WCAG SC 3.3.2 / 4.1.2).
    expect(codeInput().getAttribute("aria-label")).toBe("Invitation code");
  });

  it("keeps the gold focus border and ring", () => {
    // The fill must not have displaced the focus affordance — this is the page's
    // only input, and the ring is what keeps keyboard users oriented.
    const cls = codeInput().className;
    expect(cls).toContain("focus:border-gold");
    expect(cls).toContain("focus-visible:outline-[var(--invite-focus)]");
  });
});

describe("LoginSection RSVP-by date", () => {
  const deadline: RsvpDeadline = {
    date: "2026-09-01",
    timezone: "Australia/Sydney",
    closesAt: "2026-09-01T13:59:59.999Z",
    closed: false,
  };

  function panel(state: RsvpDeadlineState | null, rsvpDeadline: RsvpDeadline | null = deadline) {
    const { container } = render(() => (
      <LoginSection
        apiUrl="http://x"
        result={{ ...result([member("Chidi")]), rsvpDeadline }}
        rsvpDeadlineState={state}
        onClaimed={noop}
      />
    ));
    return [...container.querySelectorAll("p")].find((p) => /RSVP/i.test(p.textContent ?? ""));
  }

  it("labels the date under the greeting once the page has a verdict", () => {
    expect(panel("open")?.textContent).toBe("RSVP by Tuesday 1 September 2026");
  });

  it("escalates with the page rather than holding a clock of its own", () => {
    // The page derives the state once and hands it down, so this copy, every
    // Respond button and the RSVP sheet can't disagree about the same date.
    expect(panel("closing-soon")?.textContent).toBe(
      "RSVP by Tuesday 1 September 2026 — closing soon",
    );
    expect(panel("closed")?.textContent).toBe("RSVPs closed on Tuesday 1 September 2026");
  });

  it("stays silent without a verdict, or without a deadline", () => {
    expect(panel(null)).toBeUndefined();
    expect(panel("open", null)).toBeUndefined();
  });

  it("never announces — the events-section notice is the only live copy", () => {
    // Two live regions would read one fact twice every time the deadline moved.
    // Silent is not hidden, though: no `aria-hidden`, or the date would be gone
    // from the panel for exactly the reader it was added for.
    const p = panel("closing-soon")!;
    expect(p.getAttribute("role")).toBeNull();
    expect(p.getAttribute("aria-hidden")).toBeNull();
    expect(p.id).toBe("");
  });
});
