import { assert, describe, it } from "@effect/vitest";

import {
  formatProjectInstructions,
  PROJECT_INSTRUCTIONS_LEAD,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  PROJECT_INSTRUCTIONS_TRUNCATION_NOTE,
} from "./projectInstructions.ts";

describe("formatProjectInstructions", () => {
  it("returns undefined for empty or whitespace-only input", () => {
    assert.isUndefined(formatProjectInstructions(undefined));
    assert.isUndefined(formatProjectInstructions(""));
    assert.isUndefined(formatProjectInstructions("   \n\t  "));
  });

  it("wraps trimmed text with project_instructions tags and lead line", () => {
    const formatted = formatProjectInstructions("  Use Effect services.\nRun targeted tests.  ");
    assert.equal(
      formatted,
      `<project_instructions>\n${PROJECT_INSTRUCTIONS_LEAD}\n\nUse Effect services.\nRun targeted tests.\n</project_instructions>`,
    );
  });

  it("caps output at 16 KB on a character boundary and notes truncation", () => {
    const ascii = formatProjectInstructions("a".repeat(20_000));
    assert.isDefined(ascii);
    assert.isAtMost(Buffer.byteLength(ascii!, "utf8"), PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.include(ascii!, PROJECT_INSTRUCTIONS_TRUNCATION_NOTE.trim());
    assert.isTrue(ascii!.endsWith("\n</project_instructions>"));

    const emojis = formatProjectInstructions("🦊".repeat(5_000));
    assert.isDefined(emojis);
    assert.isAtMost(Buffer.byteLength(emojis!, "utf8"), PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.include(emojis!, PROJECT_INSTRUCTIONS_TRUNCATION_NOTE.trim());
    assert.isTrue(emojis!.isWellFormed());
  });
});
