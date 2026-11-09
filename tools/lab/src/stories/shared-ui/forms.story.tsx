import { Checkbox, type ChoiceBox } from "@shared/ui/ui/checkbox";
import { Field, Fieldset } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
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
  labelled: boolean;
  autofocus: boolean;
  column: string;
}

/**
 * The six-box verification code. `verifying` and `accepted` disable the boxes
 * on their own; `error` marks every box invalid and refocuses the first one so
 * a retry can just be typed. The boxes share the column's width up to 48px
 * each: pick a column to watch them shrink. `labelled` names the group from
 * the label above it and each box "Code from your email Digit N"; `autofocus`
 * takes effect when the story mounts.
 */
export const Otp: Story<OtpArgs> = {
  args: { status: "idle", disabled: false, labelled: true, autofocus: false, column: "400px" },
  controls: {
    status: { kind: "select", options: ["idle", "error", "verifying", "accepted"] },
    column: { kind: "select", options: ["212px", "260px", "300px", "400px", "100%"] },
  },
  render: (args) => {
    const [code, setCode] = createSignal("12");
    return (
      <div class="flex flex-col gap-3" style={{ width: args.column }}>
        <Label id="lab-otp-label">Code from your email</Label>
        <OtpInput
          value={code()}
          onChange={setCode}
          status={args.status}
          disabled={args.disabled}
          autofocus={args.autofocus}
          aria-labelledby={args.labelled ? "lab-otp-label" : undefined}
        />
        <p class="text-meta text-subtle">value: {code() || "(empty)"}</p>
      </div>
    );
  },
};

/**
 * Every state at once, each named by the label above it. The error line is an
 * inline `Notice` with `alert`, so it is read when it appears, and its id goes
 * to every box through `aria-describedby`, so it is read again when focus
 * lands on one.
 */
export const OtpStates = () => {
  const states: { label: string; value: string; status?: OtpStatus; disabled?: boolean }[] = [
    { label: "Empty", value: "" },
    { label: "Partly typed", value: "123" },
    { label: "Error", value: "123456", status: "error" },
    { label: "Verifying", value: "123456", status: "verifying" },
    { label: "Accepted", value: "123456", status: "accepted" },
    { label: "Disabled", value: "", disabled: true },
  ];
  return (
    <div class="flex max-w-sm flex-col gap-6">
      {states.map((state, n) => {
        const [code, setCode] = createSignal(state.value);
        const labelId = `lab-otp-state-${n}`;
        const errorId = `lab-otp-state-${n}-error`;
        return (
          <div class="flex flex-col gap-2">
            <Label id={labelId}>{state.label}</Label>
            <OtpInput
              value={code()}
              onChange={setCode}
              status={state.status}
              disabled={state.disabled}
              aria-labelledby={labelId}
              aria-describedby={state.status === "error" ? errorId : undefined}
            />
            {state.status === "error" && (
              <Notice size="inline" tone="danger" alert id={errorId}>
                Incorrect code. Try again.
              </Notice>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * The row in the columns it has to fit: 212px (an authenticator enrolment box
 * in Settings on a 320px phone, under Musubi's touch floor), 260px (the
 * narrowest column that keeps 40px boxes), 300px (`/authorize` at 390px) and
 * 400px, where the boxes reach their 48px and stop growing.
 */
export const OtpNarrow = () => (
  <div class="flex flex-wrap items-start gap-8">
    {["212px", "260px", "300px", "400px"].map((width) => {
      const [code, setCode] = createSignal("1234");
      return (
        <div class="flex flex-col gap-2" style={{ width }}>
          <p class="text-meta text-subtle">{width}</p>
          <OtpInput value={code()} onChange={setCode} />
        </div>
      );
    })}
  </div>
);

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
 * `labelTreatment="plain"`: the label `Label` draws by default — the words as
 * written, full ink, weight 500, the control type step — over `Field`'s wiring.
 * The first column is the sign-up form (`@osn/auth-ui`'s `Register`) drawn with
 * plain fields, two of them wrong; the second holds a field with two errors,
 * one with a hint, and a long label wrapping in a 200px column; the third is
 * the Email field in the default treatment, cire's, for comparison.
 *
 * Register's Email label also carries an `InfoPopover` beside it. `Field` has
 * no place for one, so it is not drawn here.
 */
export const PlainLabels = () => {
  const [handle, setHandle] = createSignal("ada");
  return (
    <div class="flex flex-wrap items-start gap-10">
      <div class="flex w-80 flex-col gap-4">
        <Field labelTreatment="plain" label="Email" errors={["Please enter a valid email address"]}>
          {(field) => <Input {...field} type="email" value="ada@example" />}
        </Field>
        <Field labelTreatment="plain" label="Handle">
          {(field) => (
            <UsernameInput
              {...field}
              value={handle()}
              onInput={setHandle}
              status="available"
              placeholder="lowercase, numbers, _"
            />
          )}
        </Field>
        <Field
          labelTreatment="plain"
          label="Date of birth"
          errors={["Musubi is for users 13 and older"]}
        >
          {(field) => <Input {...field} type="date" value="2020-01-01" />}
        </Field>
        <Field labelTreatment="plain" label="Display name (optional)">
          {(field) => <Input {...field} />}
        </Field>
      </div>

      <div class="flex w-80 flex-col gap-4">
        <Field
          labelTreatment="plain"
          label="Organisation handle"
          errors={["Use lowercase letters, numbers and underscores", "That handle is taken"]}
        >
          {(field) => <Input {...field} value="Acme Ltd" />}
        </Field>
        <Field
          labelTreatment="plain"
          label="Date of birth"
          hint="You must be 13 or older to use Musubi"
        >
          {(field) => <Input {...field} type="date" />}
        </Field>
        <div class="w-50">
          <Field labelTreatment="plain" label="A label long enough to wrap onto a second line">
            {(field) => <Input {...field} />}
          </Field>
        </div>
      </div>

      <div class="flex w-80 flex-col gap-4">
        <Field label="Email" errors={["Please enter a valid email address"]}>
          {(field) => <Input {...field} type="email" value="ada@example" />}
        </Field>
      </div>
    </div>
  );
};

interface FieldPlaygroundArgs extends StoryArgs {
  labelTreatment: "caps" | "plain";
  label: string;
  hint: boolean;
  errors: number;
  labelHidden: boolean;
}

const PLAYGROUND_ERRORS = ["Please enter a valid email address", "That address is already in use"];

/** Every way `Field`'s label, hint and errors combine, one control each. */
export const FieldPlayground: Story<FieldPlaygroundArgs> = {
  args: { labelTreatment: "plain", label: "Email", hint: true, errors: 1, labelHidden: false },
  controls: {
    labelTreatment: { kind: "select", options: ["caps", "plain"] },
    errors: { kind: "select", options: [0, 1, 2] },
  },
  render: (args) => (
    <div class="w-80">
      <Field
        labelTreatment={args.labelTreatment}
        label={args.label}
        labelHidden={args.labelHidden}
        hint={args.hint ? "We never show it on your profile" : undefined}
        errors={PLAYGROUND_ERRORS.slice(0, Number(args.errors))}
      >
        {(field) => <Input {...field} type="email" value="ada@example" />}
      </Field>
    </div>
  ),
};

/**
 * Five sizes, each a fixed height an input and a select share, so a date and a
 * currency line up in a column. `sm` (28px) sits in a table row or a filter
 * bar, `md` (36px) in a form; `form` (34px, md's sides and type) and
 * `form-compact` (34px, sm's) are cire's portal fields; `touch` is a guest's
 * field, 46px on a phone and 44px from 640px. The select draws its own chevron,
 * 12px in on the wide boxes and 10px on the narrow ones.
 */
export const ControlSizes = () => (
  <div class="flex flex-col gap-8">
    {(["md", "form", "form-compact", "sm", "touch"] as const).map((size) => (
      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">{size}</span>
        <div class="flex flex-wrap items-center gap-3">
          <Input size={size} class="w-48" placeholder="Text" />
          <Select size={size} class="w-40">
            <option>Select</option>
          </Select>
          <Input size={size} class="w-40" aria-invalid="true" value="Invalid" />
          <Select size={size} class="w-40" disabled>
            <option>Disabled</option>
          </Select>
        </div>
      </div>
    ))}
  </div>
);

/** Three of the guest site's palettes (`cire/theme/src/palette.ts`): a ground and its ink. */
const INK_GROUNDS = [
  { name: "chapel · light", ground: "oklch(94.5% 0.014 85)", ink: "oklch(28% 0.018 70)" },
  { name: "jewel · dark", ground: "oklch(19.5% 0.045 305)", ink: "oklch(95.5% 0.014 85)" },
  { name: "garden · coloured", ground: "oklch(93.5% 0.021 25)", ink: "oklch(30% 0.052 350)" },
] as const;

/**
 * `fill="ink"`: the edge and fill drawn from the text colour at 55% and 4.5%, so
 * a guest field reads on whatever surface the couple chose. Each panel sets
 * its own ink and ground; under it the ground fill for comparison. The claim
 * code is centred capitals at 1rem on every width, and an amount is centred.
 * Focus one to see the accent edge and the outline.
 */
export const InkFields = () => (
  <div class="flex flex-wrap items-start gap-6">
    {INK_GROUNDS.map((g) => (
      <div
        class="rounded-ui-lg flex min-w-0 flex-1 basis-72 flex-col gap-3 p-5"
        style={{ background: g.ground, color: g.ink, "--ui-ink": g.ink }}
      >
        <span class="text-meta tracking-wide uppercase">{g.name}</span>
        <Input fill="ink" size="touch" aria-label="Your name" placeholder="Your name" />
        <Input
          fill="ink"
          size="touch"
          face="claim"
          class="h-13.5"
          aria-label="Invitation code"
          placeholder="e.g. PATEL-JOY-RK97"
        />
        <Input
          fill="ink"
          size="touch"
          face="amount"
          class="mx-auto w-40"
          aria-label="Amount"
          value="150"
        />
        <Textarea
          fill="ink"
          size="touch"
          rows={3}
          aria-label="A note"
          placeholder="Anything else"
        />
        <Input fill="ink" size="touch" aria-label="Disabled" value="Disabled" disabled />
        <Input size="md" aria-label="Ground fill" placeholder="Ground fill, for comparison" />
      </div>
    ))}
  </div>
);

/**
 * The select's own chevron at every size, with a value long enough to reach it,
 * sized to its content in a squeezed row, and disabled.
 */
export const SelectChevron = () => (
  <div class="flex max-w-md flex-col gap-4">
    {(["md", "form", "form-compact", "sm"] as const).map((size) => (
      <Select size={size} aria-label={`${size} select`}>
        <option>{`A long ${size} value that runs on towards the chevron`}</option>
      </Select>
    ))}
    <label class="flex w-64 items-center gap-2">
      <span class="text-meta min-w-0 flex-1 truncate">A role for this co-host</span>
      <Select size="form-compact" class="w-auto">
        <option>Can edit everything</option>
      </Select>
    </label>
    <Select size="form" disabled aria-label="Disabled select">
      <option>Disabled</option>
    </Select>
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
