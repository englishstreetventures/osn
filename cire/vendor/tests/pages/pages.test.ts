import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * The vendor portal's Astro pages, read as text. The portal is not on the
 * end-to-end stack, so nothing else opens these pages: a wrong `portal` on the
 * sign-in card, a body without the container its heading is sized from, or a
 * page that names the portal another way would pass every other test.
 */

function page(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/pages/${name}`, import.meta.url)), "utf8");
}

/** The rendered template alone, without the frontmatter's imports. */
function template(text: string): string {
  const end = text.indexOf("---", 3);
  return end === -1 ? text : text.slice(end + 3);
}

/** What `<body>` holds, comments left out. */
function bodyOf(text: string): string {
  const match = /<body class="@container\/frame">([\s\S]*)<\/body>/.exec(template(text));
  expect(match, 'no <body class="@container/frame"> in the page').not.toBeNull();
  return match![1]!.replaceAll(/<!--[\s\S]*?-->/g, "").trim();
}

describe("login.astro", () => {
  const source = page("login.astro");

  it("is the shared sign-in card for the vendor portal, and nothing else", () => {
    expect(source).toContain("import SignInCard from '@cire/ui/sign-in-card.astro'");
    expect(source).toContain("import { CIRE_API_URL } from '../lib/osn'");
    expect(bodyOf(source)).toBe('<SignInCard portal="vendor" apiBase={CIRE_API_URL} />');
  });

  it("names the portal in its title as the card's label does", () => {
    expect(source).toContain("<title>Sign in — Vendor portal — Cire</title>");
  });
});

describe("claim.astro", () => {
  const source = page("claim.astro");

  it("labels the page as the sign-in card labels the portal", () => {
    expect(template(source)).toContain("<p class={eyebrowClass()}>Cire · Vendor portal</p>");
    expect(source).toContain("<title>Claim your listing — Vendor portal — Cire</title>");
  });
});
