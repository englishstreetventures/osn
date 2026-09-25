import { describe, expect, it } from "bun:test";

import {
  DIETARY_PRESET_BAND,
  DIETARY_PRESET_LABEL,
  DIETARY_PRESETS,
  formatDietaryCell,
  isDietaryPreset,
  parsePresets,
  presetLabel,
  presetLabels,
  serialisePresets,
  type DietaryPreset,
} from "../src/index";

describe("the vocabulary itself", () => {
  it("labels and bands every key, and nothing else", () => {
    // The two maps are hand-written beside a hand-written list, and a key added
    // to one but not the others type-checks only because `Record` is total —
    // which it is, so this asserts the reverse direction: no orphan entries.
    expect(Object.keys(DIETARY_PRESET_LABEL).toSorted()).toEqual([...DIETARY_PRESETS].toSorted());
    expect(Object.keys(DIETARY_PRESET_BAND).toSorted()).toEqual([...DIETARY_PRESETS].toSorted());
  });

  it("has no duplicate keys", () => {
    expect(new Set(DIETARY_PRESETS).size).toBe(DIETARY_PRESETS.length);
  });

  it("uses only key characters that never need escaping in the stored column", () => {
    // serialisePresets joins on "," and parsePresets splits on it with no
    // quoting anywhere. That is only safe while every key is [a-z_]+.
    for (const key of DIETARY_PRESETS) expect(key).toMatch(/^[a-z_]+$/);
  });

  it("keeps `other` last so it renders after both bands", () => {
    expect(DIETARY_PRESETS.at(-1)).toBe("other");
  });
});

describe("isDietaryPreset", () => {
  it("accepts every real key", () => {
    for (const key of DIETARY_PRESETS) expect(isDietaryPreset(key)).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(isDietaryPreset("vegetarain")).toBe(false);
    expect(isDietaryPreset("")).toBe(false);
  });

  it("rejects inherited Object.prototype members", () => {
    // The whole reason the guard is `Object.hasOwn` and not `in`. With `in`,
    // every one of these passes and the caller then treats a prototype member
    // as a stored dietary requirement.
    for (const key of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(isDietaryPreset(key)).toBe(false);
    }
  });
});

describe("serialisePresets", () => {
  it("emits canonical order regardless of input order", () => {
    expect(serialisePresets(["nuts", "vegetarian"])).toBe("vegetarian,nuts");
    expect(serialisePresets(["vegetarian", "nuts"])).toBe("vegetarian,nuts");
  });

  it("deduplicates", () => {
    // The Effect schema bounds the array's LENGTH but cannot bound its contents,
    // so `["nuts","nuts"]` reaches the server. It is normalised, not rejected.
    expect(serialisePresets(["nuts", "nuts", "nuts"])).toBe("nuts");
  });

  it("emits the empty string for an empty selection", () => {
    expect(serialisePresets([])).toBe("");
  });
});

describe("parsePresets", () => {
  it("round-trips a selection", () => {
    const picked: DietaryPreset[] = ["vegetarian", "nuts", "other"];
    expect(parsePresets(serialisePresets(picked))).toEqual(["vegetarian", "nuts", "other"]);
  });

  it("returns an empty array for a legacy row's empty column", () => {
    expect(parsePresets("")).toEqual([]);
  });

  it("drops unknown keys instead of throwing", () => {
    // A row written before a key was renamed, or edited by hand in the D1
    // console. A guest opening their invite sees what still exists.
    expect(parsePresets("vegetarian,unicorn,nuts")).toEqual(["vegetarian", "nuts"]);
    expect(parsePresets("unicorn")).toEqual([]);
  });

  it("re-canonicalises a hand-written value", () => {
    expect(parsePresets("nuts,vegetarian")).toEqual(["vegetarian", "nuts"]);
  });

  it("tolerates whitespace and empty segments", () => {
    expect(parsePresets(" vegetarian , nuts ")).toEqual(["vegetarian", "nuts"]);
    expect(parsePresets("vegetarian,,nuts")).toEqual(["vegetarian", "nuts"]);
    expect(parsePresets(",")).toEqual([]);
  });

  it("deduplicates a repeated key", () => {
    expect(parsePresets("nuts,nuts")).toEqual(["nuts"]);
  });
});

describe("presetLabel", () => {
  it("gives every key in the vocabulary its own label", () => {
    for (const key of DIETARY_PRESETS) expect(presetLabel(key)).toBe(DIETARY_PRESET_LABEL[key]);
  });

  it("humanises a key this build does not know", () => {
    // The vocabulary grows on the server first, and an open page keeps the build
    // it loaded. The key is still the guest's answer, so it has to read as words
    // rather than vanish.
    expect(presetLabel("lupin")).toBe("Lupin");
    expect(presetLabel("a_future_key")).toBe("A future key");
    expect(presetLabel("tree__nuts_")).toBe("Tree nuts");
  });

  it("humanises inherited Object.prototype names instead of reading the prototype", () => {
    expect(presetLabel("constructor")).toBe("Constructor");
    expect(presetLabel("__proto__")).toBe("Proto");
    expect(presetLabel("toString")).toBe("ToString");
  });

  it("returns a key of only underscores as itself", () => {
    expect(presetLabel("___")).toBe("___");
  });

  it("returns an empty label for a key that is empty or only whitespace", () => {
    expect(presetLabel("")).toBe("");
    expect(presetLabel("   ")).toBe("");
  });
});

describe("presetLabels", () => {
  it("returns labels in canonical order", () => {
    expect(presetLabels(["nuts", "vegetarian"])).toEqual(["Vegetarian", "Nuts"]);
  });

  it("returns nothing for an empty selection", () => {
    expect(presetLabels([])).toEqual([]);
  });

  it("appends a key this build does not know after the ones it does", () => {
    expect(presetLabels(["lupin", "nuts", "vegetarian"])).toEqual(["Vegetarian", "Nuts", "Lupin"]);
  });

  it("keeps unknown keys in the order they arrived, once each", () => {
    expect(presetLabels(["future_b", "vegan", "future_a", "future_b"])).toEqual([
      "Vegan",
      "Future b",
      "Future a",
    ]);
  });

  it("labels a selection made only of unknown keys", () => {
    expect(presetLabels(["no_mustard"])).toEqual(["No mustard"]);
  });

  it("skips an empty or blank key rather than emitting a blank label", () => {
    expect(presetLabels(["", "vegan"])).toEqual(["Vegan"]);
    expect(presetLabels(["  ", "vegan"])).toEqual(["Vegan"]);
    expect(formatDietaryCell(["  "], "")).toBe("");
  });
});

describe("formatDietaryCell", () => {
  it("joins presets and free text", () => {
    expect(formatDietaryCell(["vegetarian", "nuts"], "low salt please")).toBe(
      "Vegetarian; Nuts; low salt please",
    );
  });

  it("emits no trailing separator when there is no free text", () => {
    // A trailing "; " would show up in every caterer's sheet.
    expect(formatDietaryCell(["vegetarian"], "")).toBe("Vegetarian");
    expect(formatDietaryCell(["vegetarian"], "   ")).toBe("Vegetarian");
  });

  it("emits no leading separator for a legacy prose-only row", () => {
    // The case that keeps the existing rsvp-export assertions green: a row
    // written before this column existed must render exactly as it always did.
    expect(formatDietaryCell([], "Coeliac — strictly gluten free.")).toBe(
      "Coeliac — strictly gluten free.",
    );
  });

  it("is empty when the guest answered nothing", () => {
    expect(formatDietaryCell([], "")).toBe("");
  });

  it("shows a key this build does not know rather than an empty cell", () => {
    // An empty cell reads as "no requirement" on the organiser's table, which is
    // where a couple checks allergies before the caterer's sheet goes out.
    expect(formatDietaryCell(["lupin"], "")).toBe("Lupin");
    expect(formatDietaryCell(["lupin", "vegan"], "no garlic")).toBe("Vegan; Lupin; no garlic");
  });
});
