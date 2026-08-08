import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginSection } from "./LoginSection";
import type { ClaimResult, FamilyMember } from "./types";

afterEach(cleanup);

function member(firstName: string, nickname: string | null = null): FamilyMember {
  return { guestId: `g-${firstName}`, firstName, lastName: "Okafor", nickname, eventIds: [] };
}

function result(members: FamilyMember[], familyName = "Okafor"): ClaimResult {
  return { publicId: "OKAFOR-LILY-AB12CD", familyName, members, events: [], rsvps: [] };
}

const noop = () => {};

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
  // Anchored to content, not to sibling order (T-S3): a positional
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
