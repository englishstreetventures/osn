import { Checkbox } from "@shared/ui/ui/checkbox";
import { Field, Fieldset } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { OtpInput, type OtpStatus } from "@shared/ui/ui/otp-input";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { Select } from "@shared/ui/ui/select";
import { Textarea } from "@shared/ui/ui/textarea";
import { UsernameInput, type UsernameInputStatus } from "@shared/ui/ui/username-input";
import { createSignal } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";

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

  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-2">
        <span class="text-meta text-subtle tracking-wide uppercase">Checkbox</span>
        <Checkbox checked={subscribed()} onChange={setSubscribed} label="Email me about replies" />
        <Checkbox checked={false} label="Unchecked" />
        <p class="text-meta text-subtle">checked: {String(subscribed())}</p>
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
