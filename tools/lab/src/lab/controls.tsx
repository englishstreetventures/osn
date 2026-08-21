import { For, Match, Show, Switch } from "solid-js";

import type { ArgValue, ControlSpec, StoryArgs } from "./types.ts";

interface ControlRowProps {
  name: string;
  spec: ControlSpec;
  value: ArgValue;
  onChange: (value: ArgValue) => void;
}

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-meta text-foreground outline-none focus:ring-2 focus:ring-ring";

function NumberControl(props: ControlRowProps) {
  const spec = () => props.spec as Extract<ControlSpec, { kind: "number" | "range" }>;
  return (
    <div class="flex items-center gap-2">
      <input
        type={spec().kind === "range" ? "range" : "number"}
        class={spec().kind === "range" ? "accent-primary w-full" : INPUT_CLASS}
        min={spec().min}
        max={spec().max}
        step={spec().step}
        value={Number(props.value)}
        // `valueAsNumber` is NaN for an empty box; keep the last good number
        // rather than handing the story NaN mid-typing.
        onInput={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (!Number.isNaN(next)) props.onChange(next);
        }}
      />
      <Show when={spec().kind === "range"}>
        <span class="text-meta text-subtle w-10 shrink-0 text-right tabular-nums">
          {String(props.value)}
        </span>
      </Show>
    </div>
  );
}

function SelectControl(props: ControlRowProps) {
  const options = () => (props.spec as Extract<ControlSpec, { kind: "select" }>).options;
  return (
    <select
      class={INPUT_CLASS}
      value={String(props.value)}
      onChange={(event) => {
        // Round-trip through the original option so a numeric select hands the
        // story a number, not the string the DOM gives back.
        const picked = options().find((option) => String(option) === event.currentTarget.value);
        props.onChange(picked ?? event.currentTarget.value);
      }}
    >
      <For each={options()}>
        {(option) => <option value={String(option)}>{String(option)}</option>}
      </For>
    </select>
  );
}

function ControlRow(props: ControlRowProps) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-meta text-muted-foreground">{props.name}</span>
      <Switch>
        <Match when={props.spec.kind === "boolean"}>
          <input
            type="checkbox"
            class="accent-primary size-4"
            checked={props.value === true}
            onChange={(event) => props.onChange(event.currentTarget.checked)}
          />
        </Match>

        <Match when={props.spec.kind === "color"}>
          <div class="flex items-center gap-2">
            <input
              type="color"
              class="border-border bg-background size-7 cursor-pointer rounded border"
              value={String(props.value)}
              onInput={(event) => props.onChange(event.currentTarget.value)}
            />
            <input
              class={INPUT_CLASS}
              value={String(props.value)}
              onInput={(event) => props.onChange(event.currentTarget.value)}
            />
          </div>
        </Match>

        <Match when={props.spec.kind === "number" || props.spec.kind === "range"}>
          <NumberControl {...props} />
        </Match>

        <Match when={props.spec.kind === "select"}>
          <SelectControl {...props} />
        </Match>

        <Match when={props.spec.kind === "textarea"}>
          <textarea
            class={INPUT_CLASS}
            rows={4}
            value={String(props.value)}
            onInput={(event) => props.onChange(event.currentTarget.value)}
          />
        </Match>

        <Match when={props.spec.kind === "text"}>
          <input
            class={INPUT_CLASS}
            value={String(props.value)}
            onInput={(event) => props.onChange(event.currentTarget.value)}
          />
        </Match>
      </Switch>
    </label>
  );
}

interface ControlsPanelProps {
  args: StoryArgs;
  specs: Record<string, ControlSpec>;
  onChange: (name: string, value: ArgValue) => void;
  onReset: () => void;
}

export function ControlsPanel(props: ControlsPanelProps) {
  const names = () => Object.keys(props.specs);

  return (
    <div class="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div class="flex items-center justify-between">
        <span class="text-meta text-subtle font-medium tracking-wide uppercase">Args</span>
        <button
          class="text-meta text-muted-foreground hover:bg-muted cursor-pointer rounded px-1.5 py-0.5"
          onClick={props.onReset}
        >
          reset
        </button>
      </div>
      <For each={names()} fallback={<p class="text-meta text-subtle">No args on this story.</p>}>
        {(name) => (
          <ControlRow
            name={name}
            spec={props.specs[name]!}
            value={props.args[name]!}
            onChange={(value) => props.onChange(name, value)}
          />
        )}
      </For>
    </div>
  );
}
