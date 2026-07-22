import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

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
