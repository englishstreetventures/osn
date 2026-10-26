export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// The effort the main thread's last model request carried, with the model it
// was sent to; `level` is null when that request named no level.
export type Effort = { model: string; level: EffortLevel | null };

declare module "claude-code" {
  interface PluginState {
    "prompt-row": {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `Shaped` is the engine's own name for a tagged state value
      effort: Shaped<Effort | null>;
    };
  }
}
