import { For } from "solid-js";

import interestsGlyphs from "../../assets/onboarding/interests-glyphs.svg?raw";
import { INTEREST_CATEGORIES, type InterestCategory } from "../../lib/onboarding";
import { CategoryGlyph, CATEGORY_LABELS } from "./CategoryGlyph";
import { StepShell } from "./StepShell";

export interface Step3InterestsProps {
  totalSteps: number;
  selected: ReadonlySet<InterestCategory>;
  onToggle: (category: InterestCategory) => void;
  onPrimary: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const MAX_INTERESTS = 8;

export function Step3Interests(props: Step3InterestsProps) {
  return (
    <StepShell
      stepIndex={2}
      totalSteps={props.totalSteps}
      eyebrow="Step 03"
      illustration={<div innerHTML={interestsGlyphs} style={{ width: "100%", height: "100%" }} />}
      headline={
        <>
          What are you <em>into?</em>
        </>
      }
      body={`Pick up to ${MAX_INTERESTS}. We'll surface events that match — change anytime in settings.`}
      primaryLabel="Continue"
      onPrimary={props.onPrimary}
      onBack={props.onBack}
      onSkip={props.onSkip}
      skipLabel="Skip"
    >
      <div class="onb-chip-grid">
        <For each={INTEREST_CATEGORIES}>
          {(category) => {
            const isSelected = () => props.selected.has(category);
            const isAtCap = () => props.selected.size >= MAX_INTERESTS && !isSelected();
            return (
              <button
                type="button"
                class="onb-chip"
                aria-pressed={isSelected()}
                disabled={isAtCap()}
                onClick={() => props.onToggle(category)}
              >
                <CategoryGlyph category={category} />
                <span>{CATEGORY_LABELS[category]}</span>
              </button>
            );
          }}
        </For>
      </div>
    </StepShell>
  );
}
