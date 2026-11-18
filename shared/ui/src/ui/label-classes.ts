/**
 * The classes `Label` draws by default. A file of their own, with no variant
 * helper, so `Field`'s plain label takes the same strings without bringing
 * `class-variance-authority` into the apps that import only `Field`.
 */

/** Weight 500, line height 1: every `Label`. */
export const LABEL_BASE = "base:font-medium base:leading-none";

/** The full ink: `Label`'s default tone. */
export const LABEL_TONE_DEFAULT = "base:text-ui-ink";

/** The control type step: `Label`'s default size. */
export const LABEL_SIZE_MD = "base:text-ui-base";
