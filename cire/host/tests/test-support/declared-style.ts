import { vi } from "vitest";

/**
 * What an element actually declares in its `style`, whichever path Solid took
 * to put it there.
 *
 * Solid splits a `style={{…}}` object by KEY: entries whose value is a literal
 * are compiled into the cloned template's `style` attribute, while entries
 * whose value is computed are applied at runtime through
 * `CSSStyleDeclaration.setProperty`. happy-dom's value parser accepts a
 * `var()` reference in the attribute but DISCARDS it from `setProperty` for
 * `font-weight`, `font-style` and `font-size` — so a declaration that is
 * perfectly valid in a browser becomes invisible to the DOM in tests, purely
 * because its value came from a function call rather than a string literal.
 *
 * That is a property of the test environment, not of the code, and it should
 * not decide how the components are written — the typography samples resolve
 * their fallbacks through `@cire/theme` precisely so no call site retypes
 * them, and that made their style objects computed. This helper reads both
 * paths and merges them, so the assertions describe what the browser will
 * apply.
 *
 * Install BEFORE rendering — the spy has to be in place when Solid mounts:
 *
 * ```ts
 * const styles = captureDeclaredStyles();
 * render(() => <SectionSample … />);
 * expect(styles.of(heading)["font-weight"]).toBe(typographyVar("headingWeight"));
 * ```
 *
 * Call `vi.restoreAllMocks()` (or the returned `restore`) in `afterEach`.
 */
export function captureDeclaredStyles() {
  const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");

  return {
    /** Every property this element declares, runtime-applied ones included. */
    of(element: HTMLElement) {
      const declared: Record<string, string> = {};

      // Compiled into the template's attribute (the literal-valued entries).
      for (const rule of (element.getAttribute("style") ?? "").split(";")) {
        const at = rule.indexOf(":");
        if (at === -1) continue;
        declared[rule.slice(0, at).trim()] = rule.slice(at + 1).trim();
      }

      // Applied at runtime — matched by declaration identity, so a call on a
      // sibling element can never be mistaken for one on this element.
      for (const [index, call] of spy.mock.calls.entries()) {
        if (spy.mock.contexts[index] !== element.style) continue;
        declared[String(call[0])] = String(call[1]);
      }

      return declared;
    },
    restore: () => spy.mockRestore(),
  };
}
