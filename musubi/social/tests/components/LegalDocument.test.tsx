// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { PrivacyPage } from "../../src/pages/PrivacyPage";
import { TermsPage } from "../../src/pages/TermsPage";

/**
 * The legal pages name the tab after their own heading, as every page in the
 * shell does. No e2e flow opens Musubi's legal pages, so the title is held
 * here.
 */

afterEach(() => {
  cleanup();
  document.title = "Musubi";
});

describe("the legal pages' tab title", () => {
  it.each([
    ["the privacy notice", PrivacyPage, "Privacy Notice"],
    ["the terms", TermsPage, "Terms of Service"],
  ])("names %s after its heading", (_label, Page, heading) => {
    render(() => <Page />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(heading);
    expect(document.title).toBe(`${heading} · Musubi`);
  });
});
