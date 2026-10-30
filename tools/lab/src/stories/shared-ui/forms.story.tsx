import { Checkbox, type ChoiceBox } from "@shared/ui/ui/checkbox";
import { Field, Fieldset } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { OtpInput, type OtpStatus } from "@shared/ui/ui/otp-input";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { Select } from "@shared/ui/ui/select";
import { Switch } from "@shared/ui/ui/switch";
import { Textarea } from "@shared/ui/ui/textarea";
import { UsernameInput, type UsernameInputStatus } from "@shared/ui/ui/username-input";
import { createSignal, type JSX } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { type CireTheme, cireStyle } from "../cire-ui/cire-mapping.ts";

export const meta = { title: "shared/ui/forms", layout: "padded" as const };

export const TextFields = () => (
  <div class="flex max-w-sm flex-col gap-5">
    <div class="flex flex-col gap-1.5">
      <Label for="lab-name">Display name</Label>
      <Input id="lab-name" placeholder="Ada Lovelace" />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="lab-email">Email</Label>
      <Input id="lab-email" type="email" value="ada@example.com" />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="lab-disabled">Disabled</Label>
      <Input id="lab-disabled" value="Locked" disabled />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="lab-bio">Bio</Label>
      <Textarea id="lab-bio" rows={4} placeholder="A sentence or two." />
    </div>
  </div>
);

export const Choices = () => {
  const [subscribed, setSubscribed] = createSignal(true);
  const [visibility, setVisibility] = createSignal("friends");
  const [allowed, setAllowed] = createSignal(false);

  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">Checkbox</span>
        <Checkbox checked={subscribed()} onChange={setSubscribed} label="Email me about replies" />
        <Checkbox checked={false} label="Unchecked" />
        <p class="text-meta text-subtle">checked: {String(subscribed())}</p>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">Switch</span>
        <Switch checked={allowed()} onChange={setAllowed} label="May bring a plus-one" />
        <Switch checked readOnly label="Read-only, on" />
        <Switch checked={false} readOnly label="Read-only, off" />
        <Switch checked busy label="Saving" />
        <Switch checked={false} disabled label="Disabled" />
        <p class="text-meta text-subtle">checked: {String(allowed())}</p>
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">Radio group</span>
        <RadioGroup value={visibility()} onChange={setVisibility}>
          <RadioGroupItem value="public" label="Public" />
          <RadioGroupItem value="friends" label="Friends" />
          <RadioGroupItem value="private" label="Private" />
        </RadioGroup>
        <p class="text-meta text-subtle">value: {visibility()}</p>
      </div>
    </div>
  );
};

interface UsernameArgs extends StoryArgs {
  status: UsernameInputStatus;
  invalidMessage: string;
}

/**
 * Every availability state the handle field can be in. `status` is the
 * caller's to drive — the component does no checking of its own — so the
 * control here stands in for a debounced lookup.
 */
export const Username: Story<UsernameArgs> = {
  args: { status: "available", invalidMessage: "Letters, numbers and underscores only." },
  controls: {
    status: {
      kind: "select",
      options: ["idle", "checking", "available", "taken", "invalid", "error"],
    },
  },
  render: (args) => {
    const [value, setValue] = createSignal("ada");
    return (
      <div class="max-w-sm">
        <UsernameInput
          value={value()}
          onInput={setValue}
          status={args.status}
          invalidMessage={args.invalidMessage}
        />
      </div>
    );
  },
};

interface OtpArgs extends StoryArgs {
  status: OtpStatus;
  disabled: boolean;
}

/**
 * The six-box verification code. `verifying` and `accepted` disable the boxes
 * on their own; `error` re-focuses the first one so a retry can just be typed.
 */
export const Otp: Story<OtpArgs> = {
  args: { status: "idle", disabled: false },
  controls: {
    status: { kind: "select", options: ["idle", "error", "verifying", "accepted"] },
  },
  render: (args) => {
    const [code, setCode] = createSignal("12");
    return (
      <div class="flex flex-col gap-3">
        <OtpInput value={code()} onChange={setCode} status={args.status} disabled={args.disabled} />
        <p class="text-meta text-subtle">value: {code() || "(empty)"}</p>
      </div>
    );
  },
};

/**
 * `Field` is the label-hint-error scaffolding, and the thing to notice is what
 * it does *not* do: the hint is a sibling of the control, not a child of the
 * `<label>`. Put a hint inside a label and it becomes part of the input's
 * accessible **name** — so the box below would be announced as "Wedding name,
 * shown to guests", and a hint that updates as you type would re-announce the
 * whole name on every keystroke.
 *
 * Which is why `children` is a function: the field mints the id and hands back
 * the wiring to spread onto whatever control the caller wants.
 */
export const Fields = () => {
  const [name, setName] = createSignal("Ada & Grace");
  const [budget, setBudget] = createSignal("not a number");

  return (
    <div class="flex max-w-sm flex-col gap-6">
      <Field label="Wedding name" hint="Shown to guests on every page">
        {(field) => (
          <Input {...field} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        )}
      </Field>

      <Field
        label="Total budget"
        hint="Whole dollars"
        errors={Number.isNaN(Number(budget())) ? ["Must be a number"] : []}
      >
        {(field) => (
          <Input {...field} value={budget()} onInput={(e) => setBudget(e.currentTarget.value)} />
        )}
      </Field>

      <Field label="Timezone">
        {(field) => (
          <Select {...field}>
            <option>Australia/Sydney</option>
            <option>Australia/Perth</option>
            <option>Pacific/Auckland</option>
          </Select>
        )}
      </Field>

      <Field label="Note to guests" hint="Optional">
        {(field) => <Textarea {...field} rows={3} />}
      </Field>
    </div>
  );
};

/**
 * Two sizes and no more. `sm` is for a control sitting inside a table row, `md`
 * for a form — and the point of having exactly two is that an input, a select
 * and a textarea at the same size share one box, so a date and a currency line
 * up in a column instead of being three near-misses.
 */
export const ControlSizes = () => (
  <div class="flex flex-col gap-8">
    {(["md", "sm"] as const).map((size) => (
      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">{size}</span>
        <div class="flex flex-wrap items-center gap-3">
          <Input size={size} class="w-48" placeholder="Text" />
          <Select size={size} class="w-40">
            <option>Select</option>
          </Select>
          <Input size={size} class="w-40" aria-invalid="true" value="Invalid" />
        </div>
      </div>
    ))}
  </div>
);

/**
 * A `<fieldset>` rather than a `<div>` with a heading, because the grouping is
 * what makes a screen reader announce "Guest code style" before each option
 * rather than reading four unrelated radios.
 */
export const Groups = () => {
  const [style, setStyle] = createSignal("words");

  return (
    <div class="flex max-w-sm flex-col gap-6">
      <Fieldset legend="Guest code style">
        <RadioGroup value={style()} onChange={setStyle}>
          <RadioGroupItem value="words" label="Two words" />
          <RadioGroupItem value="digits" label="Six digits" />
        </RadioGroup>
      </Fieldset>

      <Fieldset legend="Categories">
        <Checkbox checked label="Photography" />
        <Checkbox checked={false} label="Catering" />
        <Checkbox checked={false} label="Florist" />
      </Fieldset>
    </div>
  );
};

/* ── Checkbox and RadioGroup, state by state ─────────────────────────────── */

type ChoiceTheme = CireTheme | "lab";

/**
 * A panel for one look: the lab's own mapping for the drawn box, or cire's
 * mapping in one theme for the native box. `color-scheme` follows the panel,
 * as cire's pages set it, so a ticked native box is the browser's own for that
 * scheme.
 */
function ChoicePanel(props: { theme: ChoiceTheme; children: JSX.Element }) {
  return (
    <div
      class="rounded-ui-lg border-ui-hairline bg-ui-ground text-ui-ink flex min-w-0 flex-1 basis-80 flex-col gap-4 border p-5"
      style={
        props.theme === "lab"
          ? undefined
          : { ...cireStyle(props.theme), "color-scheme": props.theme }
      }
      data-theme-panel={props.theme}
    >
      <span class="text-meta text-subtle tracking-wide uppercase">
        {props.theme === "lab" ? "drawn · lab mapping" : `native · cire ${props.theme}`}
      </span>
      {props.children}
    </div>
  );
}

const NOTICE_LINK = "text-ui-accent-ink underline underline-offset-2";

/** Every checkbox state, in one box and one panel. */
function CheckboxStates(props: { box: ChoiceBox }) {
  const [florals, setFlorals] = createSignal(true);
  const [catering, setCatering] = createSignal(false);
  const [remove, setRemove] = createSignal(false);
  const [maps, setMaps] = createSignal(false);
  const [attest, setAttest] = createSignal(false);
  return (
    <div class="flex flex-col gap-3">
      <Checkbox box={props.box} checked={florals()} onChange={setFlorals} label="Checked" />
      <Checkbox box={props.box} checked={catering()} onChange={setCatering} label="Unchecked" />
      <Checkbox box={props.box} checked disabled label="Disabled, checked" />
      <Checkbox box={props.box} checked={false} disabled label="Disabled, unchecked" />
      <div class="flex items-center gap-2">
        <Checkbox
          box={props.box}
          checked={catering()}
          onChange={setCatering}
          aria-label="Deposit paid"
        />
        <span class="text-ui-sm text-ui-ink-secondary">Named only by aria-label</span>
      </div>
      <Checkbox
        box={props.box}
        size="sm"
        align="start"
        class="max-w-72"
        checked={remove()}
        onChange={setRemove}
        label={
          <>
            Also remove these three tasks from the checklist. See the{" "}
            <a href="#help" class={NOTICE_LINK} onClick={(e) => e.preventDefault()}>
              help page
            </a>
            .
          </>
        }
      />
      <Checkbox
        box={props.box}
        align="start"
        checked={maps()}
        onChange={setMaps}
        label="Google Maps"
        description="Shows an interactive map of each venue. It loads from Google's servers."
        note={
          <span class="text-ui-xs leading-ui-snug text-ui-ink-secondary">
            Google LLC (US) ·{" "}
            <a href="#policy" class={NOTICE_LINK} onClick={(e) => e.preventDefault()}>
              privacy policy
            </a>
          </span>
        }
      />
      <Checkbox
        box={props.box}
        size="sm"
        align="start"
        checked={attest()}
        onChange={setAttest}
        label="I confirm the plus-one consented to their dietary requirements being stored and shared with the caterers."
        note={
          <p class="text-ui-sm leading-ui-normal text-ui-ink-secondary">
            Share our privacy notice with them:{" "}
            <a href="#privacy" class={NOTICE_LINK} onClick={(e) => e.preventDefault()}>
              example.com/privacy
            </a>
          </p>
        }
      />
    </div>
  );
}

/**
 * `Checkbox`, every state: checked, unchecked, disabled both ways, named only
 * by `aria-label`, a two-line label holding a link (`align="start"`, the box on
 * its first line), a `description` inside the label, and a `note` under it,
 * outside the label. The drawn box under the lab's mapping, as pulse draws it;
 * the native box under cire's, light and dark.
 */
export const CheckboxBoxes = () => (
  <div class="flex flex-wrap items-start gap-6">
    <ChoicePanel theme="lab">
      <CheckboxStates box="drawn" />
    </ChoicePanel>
    <ChoicePanel theme="dark">
      <CheckboxStates box="native" />
    </ChoicePanel>
    <ChoicePanel theme="light">
      <CheckboxStates box="native" />
    </ChoicePanel>
  </div>
);

function RadioStates(props: { box: ChoiceBox }) {
  const [scope, setScope] = createSignal("every");
  const [shown, setShown] = createSignal("guests");
  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <span class="text-ui-xs text-ui-ink-secondary">Row, one item disabled</span>
        <RadioGroup
          box={props.box}
          size="sm"
          value={shown()}
          onChange={setShown}
          aria-label="Who sees the list"
        >
          <RadioGroupItem value="guests" label="Guests" />
          <RadioGroupItem value="hosts" label="Only hosts" />
          <RadioGroupItem value="nobody" label="Nobody" disabled />
        </RadioGroup>
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-ui-xs text-ui-ink-secondary">Column</span>
        <RadioGroup
          box={props.box}
          size="sm"
          orientation="vertical"
          value={scope()}
          onChange={setScope}
          aria-label="Count guests at"
        >
          <RadioGroupItem value="every" label="Every event" />
          <RadioGroupItem value="these" label="Only these events" />
        </RadioGroup>
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-ui-xs text-ui-ink-secondary">Disabled group, md labels</span>
        <RadioGroup box={props.box} value="a" disabled aria-label="Locked">
          <RadioGroupItem value="a" label="Chosen" />
          <RadioGroupItem value="b" label="Not chosen" />
        </RadioGroup>
      </div>
    </div>
  );
}

/**
 * `RadioGroup`, every state: a row (16px apart in the native box, 8px in the
 * drawn) with one radio disabled, a column (8px apart), and a whole group
 * disabled. The drawn circle under the lab's mapping; the native radio under
 * cire's, light and dark.
 */
export const RadioBoxes = () => (
  <div class="flex flex-wrap items-start gap-6">
    <ChoicePanel theme="lab">
      <RadioStates box="drawn" />
    </ChoicePanel>
    <ChoicePanel theme="dark">
      <RadioStates box="native" />
    </ChoicePanel>
    <ChoicePanel theme="light">
      <RadioStates box="native" />
    </ChoicePanel>
  </div>
);
