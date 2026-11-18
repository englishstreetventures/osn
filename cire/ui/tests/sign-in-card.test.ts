import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import source from "../src/sign-in-card.astro?raw";

/*
 * The sign-in page's body, as both portals render it: the label naming the
 * portal, a roman "Sign in", and the card holding the panel. The page is
 * static HTML painted before any script, so these read the template as text.
 * Three of these are the owner's choices: the two labels, and a 30rem measure
 * set at the top of the page rather than centred, so the header never moves
 * when the panel mounts or a notice appears.
 */

/** The rendered template alone, without the frontmatter's imports and comments. */
function template(text: string): string {
  const end = text.indexOf("---", 3);
  return end === -1 ? text : text.slice(end + 3);
}

const body = template(source);

/** The opening tag of the first `<tag …>` in the template. */
function openingTag(tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>`).exec(body);
  expect(match, `no <${tag}> in the template`).not.toBeNull();
  return match![0];
}

describe("sign-in-card.astro", () => {
  it("holds the panel as an island inside the sign-in card", () => {
    expect(body).toMatch(
      /<div class=\{signInCardClass\}>\s*<SignInPanel client:only="solid-js" apiBase=\{apiBase\} \/>\s*<\/div>/,
    );
  });

  it("names each portal under the one product", () => {
    expect(source).toContain('host: "Cire · Host portal"');
    expect(source).toContain('vendor: "Cire · Vendor portal"');
    expect(body).toMatch(/<p class=\{eyebrowClass\(\)\}>\{LABEL\[portal\]\}<\/p>/);
  });

  it("sets the heading roman", () => {
    expect(openingTag("h1")).not.toMatch(/\bitalic\b/);
  });

  it("sits at a 30rem measure at the top of the page, never centred", () => {
    // The frame's classes are exported beside the card's, for the host
    // portal's page in the same shape; read as text, as the template is.
    expect(openingTag("main")).toBe("<main class={signInFrameClass}>");
    const classes = readFileSync(new URL("../src/sign-in-card-class.ts", import.meta.url), "utf8");
    const frame = /export const signInFrameClass = "([^"]*)";/.exec(classes)?.[1];
    expect(frame).toBeDefined();
    expect(frame).toMatch(/\bpy-24\b/);
    expect(frame).toContain("[--page-max:30rem]");
    expect(frame).not.toMatch(/justify-center|min-h-dvh|my-auto/);
  });
});
