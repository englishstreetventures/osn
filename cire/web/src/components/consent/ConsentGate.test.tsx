import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readConsentFromDocument } from "../../lib/consent/cookie";
import { defaultGrants } from "../../lib/consent/record";
import {
  consentPreferencesOpen,
  hydrateConsent,
  isCategoryGranted,
  resetConsentStoreForTest,
  saveConsent,
} from "../../lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../lib/consent/testing";
import { ConsentGate } from "./ConsentGate";

/**
 * A child that records whether it was ever constructed. This is the assertion
 * that matters for the whole framework: a gate that merely HIDES its children
 * would still have run their side effects — mounted an iframe, injected a
 * tracker — before anything was hidden. Consent has to prevent construction,
 * not appearance.
 */
function makeSpyChild() {
  const mounted = vi.fn();
  const Child = () => {
    mounted();
    return <div data-testid="gated">gated content</div>;
  };
  return { Child, mounted };
}

describe("ConsentGate", () => {
  beforeEach(resetConsentForTest);

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  it("does not construct its children for a category that is off by default", () => {
    // `analytics` is the opt-IN category — nothing has been disclosed about it,
    // so nothing may load under it until the guest says so.
    const { Child, mounted } = makeSpyChild();
    const { queryByTestId } = render(() => (
      <ConsentGate category="analytics" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).not.toHaveBeenCalled();
    expect(queryByTestId("gated")).toBeNull();
  });

  it("DOES construct its children for a category that is on by default", () => {
    // `embeds` is opt-OUT: an undecided guest gets the content, and the banner
    // tells them so. This is the behaviour the whole posture rests on.
    const { Child, mounted } = makeSpyChild();
    const { getByTestId } = render(() => (
      <ConsentGate category="embeds" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(getByTestId("gated")).toBeTruthy();
    // ...and the default applies WITHOUT fabricating a decision. If rendering
    // wrote a record the banner would stop appearing and the guest would lose
    // the chance to refuse.
    expect(readConsentFromDocument()).toBeNull();
  });

  it("does not construct its children when the guest refused", () => {
    seedConsentForTest({ embeds: false });
    const { Child, mounted } = makeSpyChild();
    render(() => (
      <ConsentGate category="embeds" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).not.toHaveBeenCalled();
  });

  it("renders its children when the category is granted", () => {
    seedConsentForTest({ embeds: true });
    const { Child, mounted } = makeSpyChild();
    const { getByTestId } = render(() => (
      <ConsentGate category="embeds" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(getByTestId("gated")).toBeTruthy();
  });

  it("checks the category it was given, not just any granted category", () => {
    seedConsentForTest({ embeds: true, analytics: false });
    const { Child, mounted } = makeSpyChild();
    render(() => (
      <ConsentGate category="analytics" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).not.toHaveBeenCalled();
  });

  it("hydrates from the cookie without needing a banner on the page", () => {
    // A gate must work on any page — including one where the guest already
    // decided, so the banner never renders and cannot be the thing that reads
    // the cookie.
    seedConsentForTest({ embeds: true });
    const { getByTestId } = render(() => (
      <ConsentGate category="embeds" vendor="pinterest">
        <div data-testid="gated">content</div>
      </ConsentGate>
    ));
    expect(getByTestId("gated")).toBeTruthy();
  });

  describe("the default placeholder", () => {
    // Under opt-out the placeholder is the RESULT of a refusal, so every case
    // here starts from one.
    beforeEach(() => seedConsentForTest({ embeds: false }));

    it("names the vendor and what it would do", () => {
      const { container } = render(() => (
        <ConsentGate category="embeds" vendor="pinterest">
          <div>content</div>
        </ConsentGate>
      ));

      const text = container.textContent ?? "";
      expect(text).toContain("Pinterest");
      expect(text).toContain("inspiration moodboard");
      expect(text).toContain("IP address");
    });

    it("grants the category — and persists it — when the allow button is clicked", () => {
      const { container, getByTestId } = render(() => (
        <ConsentGate category="embeds" vendor="pinterest">
          <div data-testid="gated">content</div>
        </ConsentGate>
      ));

      fireEvent.click(container.querySelector("button")!);

      expect(getByTestId("gated")).toBeTruthy();
      expect(readConsentFromDocument()?.grants.embeds).toBe(true);
    });

    it("grants ONLY the category it names", () => {
      const { container } = render(() => (
        <ConsentGate category="embeds" vendor="pinterest">
          <div>content</div>
        </ConsentGate>
      ));
      fireEvent.click(container.querySelector("button")!);

      const grants = readConsentFromDocument()!.grants;
      expect(grants.embeds).toBe(true);
      expect(grants.analytics).toBe(false);
      expect(grants.functional).toBe(false);
    });

    it("offers the preferences dialog as an alternative to one-click accept", () => {
      const { getByText } = render(() => (
        <ConsentGate category="embeds" vendor="pinterest">
          <div>content</div>
        </ConsentGate>
      ));

      expect(consentPreferencesOpen()).toBe(false);
      fireEvent.click(getByText("Privacy choices"));
      expect(consentPreferencesOpen()).toBe(true);
    });

    it("degrades to a neutral notice for an unknown vendor id", () => {
      const { container } = render(() => (
        <ConsentGate category="embeds" vendor="not-in-the-registry">
          <div>content</div>
        </ConsentGate>
      ));
      expect(container.textContent ?? "").toContain("This content");
    });
  });

  describe("a custom fallback", () => {
    it("replaces the placeholder entirely", () => {
      seedConsentForTest({ embeds: false });
      const { getByTestId, container } = render(() => (
        <ConsentGate
          category="embeds"
          vendor="google-maps"
          fallback={<div data-testid="fallback">a perfectly good map card</div>}
        >
          <div data-testid="gated">the real embed</div>
        </ConsentGate>
      ));

      expect(getByTestId("fallback")).toBeTruthy();
      expect(container.textContent ?? "").not.toContain("Allow third-party content");
    });

    it("is dropped once consent is granted", () => {
      seedConsentForTest({ embeds: true });
      const { getByTestId, queryByTestId } = render(() => (
        <ConsentGate
          category="embeds"
          vendor="google-maps"
          fallback={<div data-testid="fallback">card</div>}
        >
          <div data-testid="gated">embed</div>
        </ConsentGate>
      ));

      expect(getByTestId("gated")).toBeTruthy();
      expect(queryByTestId("fallback")).toBeNull();
    });
  });

  it("reveals gated content across independent gates the moment consent lands", () => {
    // Two gates rendered separately (as two embeds in different modal sections
    // are) share the module-level store, so one grant unblocks both.
    seedConsentForTest({ embeds: false });
    const a = render(() => (
      <ConsentGate category="embeds" vendor="pinterest">
        <div data-testid="a">A</div>
      </ConsentGate>
    ));
    const b = render(() => (
      <ConsentGate category="embeds" vendor="google-maps">
        <div data-testid="b">B</div>
      </ConsentGate>
    ));

    expect(a.queryByTestId("a")).toBeNull();
    expect(b.queryByTestId("b")).toBeNull();

    fireEvent.click(a.container.querySelector("button")!);

    expect(a.getByTestId("a")).toBeTruthy();
    expect(b.getByTestId("b")).toBeTruthy();
  });

  it("DISPOSES gated children when consent is withdrawn on a mounted tree", () => {
    // The withdrawal direction, and the compliance-critical one: it is what
    // makes the standing "Privacy choices" footer link a real revocation rather
    // than a record-keeping gesture. It also reaches teardown that no
    // grant-direction test can — a `<Show>` that failed to dispose would leave
    // the gated component's timers, observers and injected script tags live.
    seedConsentForTest({ embeds: true });
    const disposed = vi.fn();
    const Child = () => {
      onCleanup(disposed);
      return <div data-testid="gated">content</div>;
    };

    const { queryByTestId, getByTestId } = render(() => (
      <ConsentGate category="embeds" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));
    expect(getByTestId("gated")).toBeTruthy();

    saveConsent({ ...defaultGrants(), embeds: false });

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(queryByTestId("gated")).toBeNull();
  });

  it("holds at the FLOOR before hydration, even for an opt-out category", () => {
    // The subtle one. `embeds` is on by default, but "on by default" only
    // applies once we have READ the cookie and found no decision. Before that
    // we do not know whether this guest refused, so the gate must deny — a
    // refusal that were ignored for one tick on every page load would be a
    // refusal ignored, full stop.
    //
    // A render() can't observe this directly (onMount hydrates immediately), so
    // this asserts the store contract the gate depends on.
    resetConsentStoreForTest();
    expect(isCategoryGranted("embeds")).toBe(false);
    expect(isCategoryGranted("necessary")).toBe(true);

    hydrateConsent();
    expect(isCategoryGranted("embeds")).toBe(true);
  });
});
