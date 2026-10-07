import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentGate } from "../../../src/components/consent/ConsentGate";
import { readConsentFromDocument } from "../../../src/lib/consent/cookie";
import { defaultGrants } from "../../../src/lib/consent/record";
import {
  consentPreferencesOpen,
  hydrateConsent,
  isCategoryGranted,
  saveConsent,
} from "../../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../../src/lib/consent/testing";

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

  it("does NOT construct its children for an undecided guest: an embed waits to be allowed", () => {
    // Third-party content is off until the guest allows it. An undecided guest
    // gets the fallback, and no vendor request can escape before they choose.
    const { Child, mounted } = makeSpyChild();
    const { queryByTestId } = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).not.toHaveBeenCalled();
    expect(queryByTestId("gated")).toBeNull();
    // ...and the default applies WITHOUT fabricating a decision. If rendering
    // wrote a record the prompt would stop appearing and the guest would lose
    // the chance to choose.
    expect(readConsentFromDocument()).toBeNull();
  });

  it("DOES construct its children once the guest has allowed the category", () => {
    seedConsentForTest({ pinterest: true });
    const { Child, mounted } = makeSpyChild();
    const { getByTestId } = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(getByTestId("gated")).toBeTruthy();
  });

  it("does not construct its children when the guest refused", () => {
    seedConsentForTest({ pinterest: false });
    const { Child, mounted } = makeSpyChild();
    render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).not.toHaveBeenCalled();
  });

  it("renders its children when the category is granted", () => {
    seedConsentForTest({ pinterest: true });
    const { Child, mounted } = makeSpyChild();
    const { getByTestId } = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(getByTestId("gated")).toBeTruthy();
  });

  it("checks the switch it was given, not just any granted switch", () => {
    seedConsentForTest({ pinterest: true, maps: false });
    const { Child, mounted } = makeSpyChild();
    render(() => (
      <ConsentGate category="maps" vendor="google-maps">
        <Child />
      </ConsentGate>
    ));

    expect(mounted).not.toHaveBeenCalled();
  });

  it("hydrates from the cookie without needing a banner on the page", () => {
    // A gate must work on any page — including one where the guest already
    // decided, so the banner never renders and cannot be the thing that reads
    // the cookie.
    seedConsentForTest({ pinterest: true });
    const { getByTestId } = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <div data-testid="gated">content</div>
      </ConsentGate>
    ));
    expect(getByTestId("gated")).toBeTruthy();
  });

  describe("the default placeholder", () => {
    // Under opt-out the placeholder is the RESULT of a refusal, so every case
    // here starts from one.
    beforeEach(() => seedConsentForTest({ pinterest: false }));

    it("names the vendor and what it would do", () => {
      const { container } = render(() => (
        <ConsentGate category="pinterest" vendor="pinterest">
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
        <ConsentGate category="pinterest" vendor="pinterest">
          <div data-testid="gated">content</div>
        </ConsentGate>
      ));

      fireEvent.click(container.querySelector("button")!);

      expect(getByTestId("gated")).toBeTruthy();
      expect(readConsentFromDocument()?.grants.pinterest).toBe(true);
    });

    it("grants ONLY the category it names", () => {
      const { container } = render(() => (
        <ConsentGate category="pinterest" vendor="pinterest">
          <div>content</div>
        </ConsentGate>
      ));
      fireEvent.click(container.querySelector("button")!);

      const grants = readConsentFromDocument()!.grants;
      expect(grants.pinterest).toBe(true);
      expect(grants.maps).toBe(false);
    });

    it("offers the preferences dialog as an alternative to one-click accept", () => {
      const { getByText } = render(() => (
        <ConsentGate category="pinterest" vendor="pinterest">
          <div>content</div>
        </ConsentGate>
      ));

      expect(consentPreferencesOpen()).toBe(false);
      fireEvent.click(getByText("Privacy choices"));
      expect(consentPreferencesOpen()).toBe(true);
    });

    it("degrades to a neutral notice for an unknown vendor id", () => {
      const { container } = render(() => (
        <ConsentGate category="pinterest" vendor="not-in-the-registry">
          <div>content</div>
        </ConsentGate>
      ));
      expect(container.textContent ?? "").toContain("This content");
    });
  });

  describe("a custom fallback", () => {
    it("replaces the placeholder entirely", () => {
      seedConsentForTest({ pinterest: false });
      const { getByTestId, container } = render(() => (
        <ConsentGate
          category="pinterest"
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
      seedConsentForTest({ pinterest: true });
      const { getByTestId, queryByTestId } = render(() => (
        <ConsentGate
          category="pinterest"
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

  it("reveals gated content across independent gates of the same switch the moment it is allowed", () => {
    // Two gates rendered separately (as two moodboards in different event
    // sheets are) share the module-level store, so one grant unblocks both.
    seedConsentForTest({ pinterest: false });
    const a = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <div data-testid="a">A</div>
      </ConsentGate>
    ));
    const b = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <div data-testid="b">B</div>
      </ConsentGate>
    ));

    expect(a.queryByTestId("a")).toBeNull();
    expect(b.queryByTestId("b")).toBeNull();

    fireEvent.click(a.container.querySelector("button")!);

    expect(a.getByTestId("a")).toBeTruthy();
    expect(b.getByTestId("b")).toBeTruthy();
  });

  it("leaves the other switch's gates closed when one is allowed", () => {
    // Allowing the moodboard is not allowing the map.
    const moodboard = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <div data-testid="moodboard">A</div>
      </ConsentGate>
    ));
    const map = render(() => (
      <ConsentGate category="maps" vendor="google-maps">
        <div data-testid="map">B</div>
      </ConsentGate>
    ));

    fireEvent.click(moodboard.container.querySelector("button")!);

    expect(moodboard.getByTestId("moodboard")).toBeTruthy();
    expect(map.queryByTestId("map")).toBeNull();
  });

  it("DISPOSES gated children when consent is withdrawn on a mounted tree", () => {
    // The withdrawal direction, and the compliance-critical one: it is what
    // makes the standing "Privacy choices" footer link a real revocation rather
    // than a record-keeping gesture. It also reaches teardown that no
    // grant-direction test can — a `<Show>` that failed to dispose would leave
    // the gated component's timers, observers and injected script tags live.
    seedConsentForTest({ pinterest: true });
    const disposed = vi.fn();
    const Child = () => {
      onCleanup(disposed);
      return <div data-testid="gated">content</div>;
    };

    const { queryByTestId, getByTestId } = render(() => (
      <ConsentGate category="pinterest" vendor="pinterest">
        <Child />
      </ConsentGate>
    ));
    expect(getByTestId("gated")).toBeTruthy();

    saveConsent({ ...defaultGrants(), pinterest: false });

    expect(disposed).toHaveBeenCalledTimes(1);
    expect(queryByTestId("gated")).toBeNull();
  });

  it("holds at the FLOOR before hydration, even for a guest who allowed the switch", () => {
    // The subtle one. Before hydration we do not know what this guest chose,
    // so the gate must deny — and a grant on file must not be honoured before
    // it has been read either: the floor, not a guess, applies.
    //
    // A render() can't observe this directly (onMount hydrates immediately), so
    // this asserts the store contract the gate depends on.
    seedConsentForTest({ pinterest: true });
    expect(isCategoryGranted("pinterest")).toBe(false);
    expect(isCategoryGranted("necessary")).toBe(true);

    hydrateConsent();
    expect(isCategoryGranted("pinterest")).toBe(true);
    expect(isCategoryGranted("maps")).toBe(false);
  });
});
