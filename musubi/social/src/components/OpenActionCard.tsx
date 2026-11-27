import type { AccountDeletionOpenAction } from "@osn/client";
import { clsx } from "@shared/ui/lib/utils";
import { buttonVariants } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Field } from "@shared/ui/ui/field";
import { Notice } from "@shared/ui/ui/notice";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
import { Select } from "@shared/ui/ui/select";
import { createUniqueId, For, Match, Show, Switch } from "solid-js";

import {
  appName,
  followableLink,
  formatDay,
  needsAnswer,
  type Answer,
} from "../lib/account-deletion";

/**
 * Why an action is marked: it needs an answer and has none, its `successor`
 * answer names no member, or the server refused the answer it was sent.
 */
export type ActionMark = "unanswered" | "no_successor" | "refused";

const MARK_LINE = {
  unanswered: "Choose what happens to this.",
  refused: "That answer can't be used now. Choose again.",
} as const;

/** A member a `successor` answer can name, as the picker lists them. */
function memberName(member: {
  handle: string;
  display_name: string | null;
  role: "admin" | "member";
}): string {
  const who = member.display_name
    ? `${member.display_name} (@${member.handle})`
    : `@${member.handle}`;
  return member.role === "admin" ? `${who} · Admin` : who;
}

export interface OpenActionCardProps {
  action: AccountDeletionOpenAction;
  answer: Answer | undefined;
  /** "Delete everything" is on: the answer is not sent, and cannot be changed. */
  disabled: boolean;
  mark: ActionMark | undefined;
  /** A new answer, or null to take it back. */
  onAnswer: (answer: Answer | null) => void;
}

/**
 * One open action in the deletion flow: what the app says (`label`), the
 * choices it offers with each one's words as the app wrote them and the day
 * it deletes what it keeps, the member picker for an organisation passed to
 * someone named, and the app's own link to deal with it there.
 *
 * Several choices are radios; one choice that must be answered is a box to
 * tick; one with a default needs nothing and shows its words alone.
 */
export function OpenActionCard(props: OpenActionCardProps) {
  const labelId = createUniqueId();
  const markId = createUniqueId();
  const shown = () => props.answer?.choice ?? props.action.default_choice ?? "";
  const only = () => (props.action.choices.length === 1 ? props.action.choices[0] : undefined);
  const lineMark = () =>
    props.mark === "unanswered" || props.mark === "refused" ? props.mark : undefined;
  const link = () => followableLink(props.action.link);

  const choose = (choice: string) =>
    props.onAnswer({
      choice,
      // A member already named stays named if the person comes back to it.
      successorProfileId: choice === "successor" ? props.answer?.successorProfileId : undefined,
    });

  return (
    <Card
      padding="md"
      class="flex flex-col gap-4"
      data-action={props.action.id}
      data-marked={props.mark ? "" : undefined}
    >
      {/* The app wrote these words, so they break anywhere: a name with no
          spaces must not push the page sideways. */}
      <p id={labelId} class="text-foreground text-body wrap-anywhere">
        {props.action.label}
      </p>

      {/* While "Delete everything" is on, each choice's words dim to 50%
          (`ChoiceWords`) and each circle or box dims itself as it is
          disabled, so the choices read as out of play at one strength. The
          label above stays, since what the app holds is still what goes. */}
      <Switch>
        <Match when={props.action.choices.length > 1}>
          <RadioGroup
            value={shown()}
            onChange={choose}
            orientation="vertical"
            size="sm"
            touch
            disabled={props.disabled}
            aria-labelledby={labelId}
            aria-describedby={lineMark() ? markId : undefined}
            aria-invalid={lineMark() ? "true" : undefined}
          >
            <For each={props.action.choices}>
              {(choice) => (
                <RadioGroupItem
                  value={choice.choice}
                  label={
                    <ChoiceWords
                      description={choice.description}
                      erasedOn={choice.erased_on}
                      dimmed={props.disabled}
                    />
                  }
                />
              )}
            </For>
          </RadioGroup>
        </Match>
        <Match when={needsAnswer(props.action) ? only() : undefined}>
          {(choice) => (
            <Checkbox
              size="sm"
              touch
              checked={props.answer?.choice === choice().choice}
              onChange={(on) => props.onAnswer(on ? { choice: choice().choice } : null)}
              disabled={props.disabled}
              label={
                <ChoiceWords
                  description={choice().description}
                  erasedOn={choice().erased_on}
                  dimmed={props.disabled}
                />
              }
              aria-describedby={lineMark() ? markId : undefined}
              aria-invalid={lineMark() ? "true" : undefined}
            />
          )}
        </Match>
        {/* One choice with a default: it happens whatever is answered, so
            "Delete everything" takes nothing out of play and its words stay. */}
        <Match when={only()}>
          {(choice) => (
            <ChoiceWords
              description={choice().description}
              erasedOn={choice().erased_on}
              dimmed={false}
            />
          )}
        </Match>
      </Switch>

      <Show when={shown() === "successor" && props.action.candidates}>
        {(candidates) => (
          <Field
            labelTreatment="plain"
            label="New owner"
            errors={props.mark === "no_successor" ? ["Choose who becomes the owner."] : undefined}
          >
            {(field) => (
              <Select
                {...field}
                disabled={props.disabled}
                onChange={(event) =>
                  props.onAnswer({
                    choice: "successor",
                    successorProfileId: event.currentTarget.value || undefined,
                  })
                }
              >
                <option value="" disabled selected={!props.answer?.successorProfileId}>
                  Choose a member
                </option>
                <For each={candidates()}>
                  {(member) => (
                    <option
                      value={member.profile_id}
                      selected={member.profile_id === props.answer?.successorProfileId}
                    >
                      {memberName(member)}
                    </option>
                  )}
                </For>
              </Select>
            )}
          </Field>
        )}
      </Show>

      <Show when={lineMark()}>
        {(mark) => (
          <Notice tone="danger" size="inline" id={markId}>
            {MARK_LINE[mark()]}
          </Notice>
        )}
      </Show>

      <Show when={link()}>
        {(href) => (
          // Its own tab, so the flow and its answers stay where they are.
          <a
            href={href()}
            target="_blank"
            rel="noopener noreferrer"
            aria-describedby={labelId}
            class={clsx(
              buttonVariants({ variant: "secondary", size: "sm" }),
              "self-start max-md:h-10",
            )}
          >
            Open in {appName(props.action.app)}
          </a>
        )}
      </Show>
    </Card>
  );
}

/**
 * A choice's words as the app wrote them, breaking anywhere, and the day it
 * deletes what it keeps: the one look of that day under a radio, a box or a
 * choice with nothing to pick. Dimmed with the choice it names.
 */
function ChoiceWords(props: { description: string; erasedOn: number | null; dimmed: boolean }) {
  return (
    <span class="flex flex-col gap-0.5 wrap-anywhere" classList={{ "opacity-50": props.dimmed }}>
      <span>{props.description}</span>
      <Show when={props.erasedOn}>
        {(day) => (
          <span class="text-muted-foreground text-meta">Deleted on {formatDay(day())}</span>
        )}
      </Show>
    </span>
  );
}
