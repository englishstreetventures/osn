import { ALL_COLOR_TOKENS, CONTRACT_COLOR_TOKENS } from "@shared/design-tokens";
import { Button } from "@shared/ui/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shared/ui/ui/card";
import { Chip } from "@shared/ui/ui/chip";
import { Input } from "@shared/ui/ui/input";
import { Meter } from "@shared/ui/ui/meter";
import { Notice } from "@shared/ui/ui/notice";
import { For, type JSX, Show } from "solid-js";

import { Eyebrow, Gallery, Mono, Rule, Section, Swatch, type SwatchKind } from "./chrome.tsx";
import { BG, BORDER, type ColorToken, TEXT } from "./utilities.ts";

export const meta = { title: "design-system/colour", layout: "padded" as const };

/**
 * The seven roles `tokens.css` groups the colours into, each with the rule its
 * comment states. Membership is decided by an ordered predicate list over the
 * contract's own token list rather than typed out, so a token added to the
 * contract lands in a group — or, if none claims it, in a visible `unsorted`
 * row rather than nowhere.
 */
interface Role {
  name: string;
  claims: (token: string) => boolean;
  kind: SwatchKind;
  rule: () => JSX.Element;
  /** The token in the thing it becomes. */
  inUse: () => JSX.Element;
}

const STATUS = new Set<string>(["--ui-success", "--ui-warn", "--ui-danger", "--ui-on-danger"]);

const ROLES: readonly Role[] = [
  {
    name: "Grounds",
    claims: (t) => t.startsWith("--ui-ground"),
    kind: "fill",
    rule: () => (
      <>
        <Mono>ground</Mono> is the page. <Mono>ground-deep</Mono> is what the page recedes{" "}
        <em>to</em> behind a sticky bar or under a scrim — it is not "darker", it is further away,
        which in a light theme means darker and in a dark theme can mean either. Flip the toggle and
        watch which way it goes.
      </>
    ),
    inUse: () => (
      <div class="rounded-ui-lg border-ui-hairline w-80 overflow-hidden border">
        <div class="bg-ui-ground-deep flex items-center justify-between px-4 py-2">
          <Eyebrow>sticky bar</Eyebrow>
          <Mono muted>bg-ui-ground-deep</Mono>
        </div>
        <div class="bg-ui-ground flex flex-col gap-2 p-4">
          <p class="text-ui-base text-ui-ink">The page beneath it.</p>
          <Mono muted>bg-ui-ground</Mono>
        </div>
      </div>
    ),
  },
  {
    name: "Surfaces",
    claims: (t) => t.startsWith("--ui-surface"),
    kind: "fill",
    rule: () => (
      <>
        Three, and three is the minimum: musubi and pulse both collapse shadcn's{" "}
        <Mono>secondary</Mono>/<Mono>muted</Mono>/<Mono>accent</Mono> onto one value and{" "}
        <Mono>card</Mono>/<Mono>popover</Mono>/<Mono>background</Mono> onto another, so a
        two-surface contract cannot express either app. <Mono>surface</Mono> is a card,{" "}
        <Mono>surface-raised</Mono> a menu or popover above it, <Mono>surface-sunk</Mono> a well —
        an input, a code block, a progress track.
      </>
    ),
    inUse: () => (
      <div class="flex flex-wrap items-start gap-6">
        <div class="relative w-72 pb-10">
          <Card>
            <CardHeader>
              <CardTitle>A card</CardTitle>
              <CardDescription>surface</CardDescription>
            </CardHeader>
            <CardContent>
              <p class="text-ui-base text-ui-ink-secondary">Content sits on the surface.</p>
            </CardContent>
          </Card>
          <div
            class="rounded-ui-md border-ui-hairline bg-ui-surface-raised text-ui-sm text-ui-ink absolute right-4 bottom-0 flex w-40 flex-col border py-1"
            style={{ "box-shadow": "var(--ui-elev-2)" }}
          >
            <span class="px-3 py-1">A menu</span>
            <span class="bg-ui-surface-sunk px-3 py-1">above it</span>
            <span class="text-ui-ink-secondary px-3 py-1">surface-raised</span>
          </div>
        </div>
        <div class="flex w-64 flex-col gap-3">
          <Input placeholder="A well — surface-sunk" />
          <Meter value={62} max={100} label="Track on surface-sunk" />
          <Mono muted>bg-ui-surface-sunk</Mono>
        </div>
      </div>
    ),
  },
  {
    name: "Edges",
    claims: (t) => t.startsWith("--ui-hairline"),
    kind: "edge",
    rule: () => (
      <>
        <Mono>hairline</Mono> is decoration and carries <strong>no contrast floor</strong> — a card
        is told apart by its surface, not its edge. <Mono>hairline-strong</Mono> is the visible
        boundary of a control that has no fill (an outline button, an input) and must clear 3:1
        against both grounds. A single <Mono>--ui-border</Mono> could not say which.
      </>
    ),
    inUse: () => (
      <div class="flex flex-wrap items-center gap-6">
        <div class="flex flex-col gap-2">
          <div class="rounded-ui-lg border-ui-hairline bg-ui-surface text-ui-sm text-ui-ink-secondary w-48 border p-4">
            A card's edge
          </div>
          <Mono muted>border-ui-hairline</Mono>
        </div>
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <Button variant="outline">Outline</Button>
            <Input class="w-40" placeholder="Input" />
          </div>
          <Mono muted>border-ui-hairline-strong</Mono>
        </div>
      </div>
    ),
  },
  {
    name: "Ink",
    claims: (t) => t.startsWith("--ui-ink"),
    kind: "ink",
    rule: () => (
      <>
        <Mono>ink</Mono> and <Mono>ink-secondary</Mono> clear 4.5:1 against every ground and
        surface. <Mono>ink-tertiary</Mono> clears only 3:1 and is therefore for large text, ornament
        and disabled states — <strong>never body copy</strong>. It is named <Mono>tertiary</Mono>{" "}
        rather than <Mono>faint</Mono> so the ladder reads as a ladder.
      </>
    ),
    inUse: () => (
      <div class="max-w-ui-md flex flex-col gap-3">
        <p class="text-ui-base leading-ui-normal text-ui-ink">
          Body copy in <Mono>text-ui-ink</Mono>: the paragraph someone actually reads, held to 4.5:1
          wherever it lands.
        </p>
        <p class="text-ui-base leading-ui-normal text-ui-ink-secondary">
          A description in <Mono>text-ui-ink-secondary</Mono>: still 4.5:1, still readable at
          length, quieter than the line above it.
        </p>
        <div class="flex items-baseline gap-4">
          <span class="text-ui-lg text-ui-ink-tertiary font-semibold">Large ornament</span>
          <span class="text-ui-base text-ui-ink-tertiary line-through">disabled</span>
          <Mono muted>text-ui-ink-tertiary · 3:1 only</Mono>
        </div>
      </div>
    ),
  },
  {
    name: "Accent",
    claims: (t) => t.startsWith("--ui-accent") || t === "--ui-on-accent",
    kind: "fill",
    rule: () => (
      <>
        <Mono>accent</Mono> is a <strong>fill</strong>: the ground of a primary button, the wash
        behind an active row. <Mono>on-accent</Mono> is what sits on top of it.{" "}
        <Mono>accent-ink</Mono> is the readable-on-a-page-ground variant, a different colour
        whenever the accent is dark enough to need one. <Mono>accent-soft</Mono> is a tint of the
        accent — <strong>never a neutral surface</strong>: an app that maps shadcn's neutral{" "}
        <Mono>accent</Mono> here instead of onto a surface gets a coloured hover where it wanted a
        grey one.
      </>
    ),
    inUse: () => (
      <div class="flex flex-wrap items-center gap-6">
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <Button>Primary</Button>
            <span class="rounded-ui-control bg-ui-accent-strong text-ui-base text-ui-on-accent inline-flex h-9 items-center px-4 font-medium">
              pressed
            </span>
          </div>
          <Mono muted>bg-ui-accent · bg-ui-accent-strong · text-ui-on-accent</Mono>
        </div>
        <div class="flex flex-col gap-2">
          <Button variant="link">A link on the page</Button>
          <Mono muted>text-ui-accent-ink</Mono>
        </div>
        <div class="flex flex-col gap-2">
          <div class="rounded-ui-md border-ui-hairline text-ui-sm text-ui-ink flex w-56 flex-col border">
            <span class="px-3 py-1.5">A row</span>
            <span class="bg-ui-accent-soft text-ui-accent-ink flex items-center justify-between px-3 py-1.5">
              The active row <Chip tone="accent">quoted</Chip>
            </span>
            <span class="px-3 py-1.5">A row</span>
          </div>
          <Mono muted>bg-ui-accent-soft · text-ui-accent-ink</Mono>
        </div>
      </div>
    ),
  },
  {
    name: "Status",
    claims: (t) => STATUS.has(t),
    kind: "fill",
    rule: () => (
      <>
        Separate from the accent, as status colour always should be: an app whose brand is green
        still needs a green that means "succeeded" and does not mean "primary action".{" "}
        <Mono>success</Mono> and <Mono>warn</Mono> are inks (4.5:1 on the page); <Mono>danger</Mono>{" "}
        is a fill with <Mono>on-danger</Mono> on it.
      </>
    ),
    inUse: () => (
      <div class="flex flex-wrap items-start gap-6">
        <div class="max-w-ui-sm flex flex-col gap-2">
          <Notice tone="success">Invites sent to 84 households.</Notice>
          <Notice tone="warn">Three guests have no email address.</Notice>
          <Notice tone="danger">We could not save that. Nothing was changed.</Notice>
        </div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <Button variant="destructive">Delete</Button>
            <Chip tone="success">live</Chip>
            <Chip tone="pending">awaiting</Chip>
          </div>
          <div class="w-56">
            <Meter value={130} max={100} tone="over" label="Over budget" />
          </div>
          <Mono muted>bg-ui-danger · text-ui-on-danger · text-ui-success · text-ui-warn</Mono>
        </div>
      </div>
    ),
  },
  {
    name: "Focus",
    claims: (t) => t === "--ui-focus",
    kind: "edge",
    rule: () => (
      <>
        Its own token rather than an alias of the accent, because a focus indicator has a 3:1 floor
        and plenty of brand colours do not clear it — cire learned this with gold, which is
        unreadable on its light ground. The ring below is forced on so it can be seen without a
        keyboard; a real one appears on <Mono>:focus-visible</Mono>.
      </>
    ),
    inUse: () => (
      <div class="flex flex-wrap items-center gap-6 p-1">
        <Input
          class="w-48"
          value="Focused"
          readOnly
          style={{
            outline: "var(--ui-focus-width) solid var(--ui-focus)",
            "outline-offset": "var(--ui-focus-offset)",
          }}
        />
        <Button
          variant="outline"
          style={{
            outline: "var(--ui-focus-width) solid var(--ui-focus)",
            "outline-offset": "var(--ui-focus-offset)",
          }}
        >
          Focused
        </Button>
        <Mono muted>outline: var(--ui-focus-width) solid var(--ui-focus)</Mono>
      </div>
    ),
  },
];

interface RoleGroup {
  role: Role;
  tokens: string[];
}

/** Every contract token sorted into a role, plus any that no role claimed. */
interface RoleSorting {
  groups: RoleGroup[];
  unsorted: string[];
}

function roleGroups(): RoleSorting {
  const groups: RoleGroup[] = ROLES.map((role) => ({ role, tokens: [] }));
  const unsorted: string[] = [];
  for (const token of ALL_COLOR_TOKENS) {
    const group = groups.find((g) => g.role.claims(token));
    if (group) group.tokens.push(token);
    else unsorted.push(token);
  }
  return { groups, unsorted };
}

/** `ALL_COLOR_TOKENS` is typed `string[]`; the utility tables are keyed by the literal union. */
function isColorToken(token: string): token is ColorToken {
  return Object.hasOwn(BG, token);
}

/** The utility to show under a swatch, by the way the role uses the token. */
function utilityFor(token: string, kind: SwatchKind): string | undefined {
  if (!isColorToken(token)) return undefined;
  return kind === "ink" ? TEXT[token] : kind === "edge" ? BORDER[token] : BG[token];
}

/** An on-fill ink is shown on the fill it names: `--ui-on-accent` on `--ui-accent`. */
function groundFor(token: string): string | undefined {
  return token.startsWith("--ui-on-") ? token.replace("--ui-on-", "--ui-") : undefined;
}

/**
 * Every colour role, in use. Each group is the rule from `tokens.css`, the
 * swatches — measured from what the browser painted — and the thing the token
 * becomes. Flip the light · dark toggle: the captions re-measure.
 */
export const Roles = () => {
  const { groups, unsorted } = roleGroups();
  return (
    <Gallery
      title="Colour roles"
      intro={
        <>
          Twenty tokens, seven roles. A swatch says what a colour <em>is</em>; the panel beside it
          says what it is <em>for</em>. Each caption is read back from the painted element with{" "}
          <Mono>getComputedStyle</Mono>, so it shows the lab's own mapping (musubi's) in whichever
          theme is on, not the stylesheet's fallback.
        </>
      }
    >
      <For each={groups}>
        {({ role, tokens }) => (
          <Section
            title={role.name}
            eyebrow={`${tokens.length} token${tokens.length === 1 ? "" : "s"}`}
          >
            <Rule>{role.rule()}</Rule>
            <div class="flex flex-wrap gap-4">
              <For each={tokens}>
                {(token) => (
                  <Swatch
                    token={token}
                    kind={token.startsWith("--ui-on-") ? "ink" : role.kind}
                    utility={utilityFor(token, token.startsWith("--ui-on-") ? "ink" : role.kind)}
                    on={groundFor(token)}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-col gap-2">
              <Eyebrow>in use</Eyebrow>
              {role.inUse()}
            </div>
          </Section>
        )}
      </For>
      <Show when={unsorted.length > 0}>
        <Section title="Unsorted" eyebrow="in the contract, claimed by no role above">
          <Rule>
            These tokens exist in <Mono>CONTRACT_COLOR_TOKENS</Mono> and no role here claims them.
            Add a predicate, or the story is describing a smaller contract than the one that ships.
          </Rule>
          <div class="flex flex-wrap gap-4">
            <For each={unsorted}>{(token) => <Swatch token={token} />}</For>
          </div>
        </Section>
      </Show>
    </Gallery>
  );
};

/** What the conformance harness asserts about each group — the TSDoc on `CONTRACT_COLOR_TOKENS`, restated. */
const OBLIGATION = {
  grounds:
    "Backgrounds a reader's eye rests on. Nothing is asserted about them; they are what other tokens are asserted against.",
  surfaces: "Raised planes. Also grounds for contrast purposes.",
  ink: "Body-copy ink. Must clear 4.5:1 against every ground and surface — nine assertions per token.",
  inkLarge: "Large-text, ornament and disabled ink. Clears 3:1 only — never body copy.",
  ui: "Non-text UI that must be perceivable: control boundaries, the focus ring. Clears 3:1.",
  decorative:
    "Decoration with no contrast floor. A card is told apart by its surface, not its edge.",
  fills: "Fills. What sits on them is asserted, not they themselves.",
  onFill: "Ink that sits on a fill. Asserted against the fill it names, never against the page.",
  chromaticInk: "Accent and status colours used as ink on a ground. Clears 4.5:1.",
} as const satisfies Record<keyof typeof CONTRACT_COLOR_TOKENS, string>;

const OBLIGATION_KIND = {
  grounds: "fill",
  surfaces: "fill",
  ink: "ink",
  inkLarge: "ink",
  ui: "edge",
  decorative: "fill",
  fills: "fill",
  onFill: "ink",
  chromaticInk: "ink",
} as const satisfies Record<keyof typeof CONTRACT_COLOR_TOKENS, SwatchKind>;

/**
 * The same twenty tokens, grouped the way `CONTRACT_COLOR_TOKENS` groups them
 * — by the contrast obligation each carries, which is what the conformance
 * harness reads. Iterated straight off the export.
 */
export const Obligations = () => (
  <Gallery
    title="Contrast obligations"
    intro={
      <>
        <Mono>CONTRACT_COLOR_TOKENS</Mono> groups tokens by what an app has to prove about them, not
        by what they look like. Moving a token between these groups changes what{" "}
        <Mono>assertContractConformance</Mono> asserts. The pairs themselves are measured live in
        the <em>contrast</em> story.
      </>
    }
  >
    <For
      each={
        Object.entries(CONTRACT_COLOR_TOKENS) as [
          keyof typeof CONTRACT_COLOR_TOKENS,
          readonly string[],
        ][]
      }
    >
      {([group, tokens]) => (
        <Section title={group} eyebrow={`${tokens.length} token${tokens.length === 1 ? "" : "s"}`}>
          <Rule>{OBLIGATION[group]}</Rule>
          <div class="flex flex-wrap gap-4">
            <For each={tokens}>
              {(token) => (
                <Swatch
                  token={token}
                  kind={OBLIGATION_KIND[group]}
                  utility={utilityFor(token, OBLIGATION_KIND[group])}
                  on={groundFor(token)}
                />
              )}
            </For>
          </div>
        </Section>
      )}
    </For>
  </Gallery>
);
