/**
 * The handle rule in words, with no component imports, so a view that asks
 * for a handle and a placeholder that stands in for one share one wording
 * without loading each other.
 */

/** The handle field's standing hint: the rule, and what typing does to what breaks it. */
export const HANDLE_HINT =
  "Up to 30 lowercase letters, numbers and underscores. Capitals become lowercase as you type, and anything else is left out.";

/** The refusal for a handle past the limit. */
export const HANDLE_TOO_LONG = "Use 30 characters or fewer.";
