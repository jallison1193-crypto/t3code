import { assert, describe, it } from "@effect/vitest";

import {
  COORDINATOR_INSTRUCTIONS_LEAD,
  COORDINATOR_INSTRUCTIONS_TRUNCATION_NOTE,
  formatProjectContext,
  formatProjectInstructions,
  PROJECT_INSTRUCTIONS_LEAD,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  PROJECT_INSTRUCTIONS_TRUNCATION_NOTE,
  PROJECT_KNOWLEDGE_LIST_MAX_BYTES,
  PROJECT_KNOWLEDGE_TRUNCATION_NOTE,
  PROJECT_MEMORY_HEAD_MAX_BYTES,
  PROJECT_MEMORY_TOOLS_NOTE,
  PROJECT_MEMORY_TRUNCATION_NOTE,
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

    const emojis = formatProjectInstructions("\u{1F680}".repeat(5_000));
    assert.isDefined(emojis);
    assert.isAtMost(Buffer.byteLength(emojis!, "utf8"), PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.include(emojis!, PROJECT_INSTRUCTIONS_TRUNCATION_NOTE.trim());
    assert.isTrue(emojis!.isWellFormed());
  });
});

describe("formatProjectContext", () => {
  it("returns undefined when all parts are empty", () => {
    assert.isUndefined(formatProjectContext({}));
    assert.isUndefined(
      formatProjectContext({
        instructions: "  ",
        memoryHead: "\n",
        knowledgeFiles: ["  ", ""],
      }),
    );
  });

  it("omits empty parts and formats memory and knowledge in one block", () => {
    const memoryOnly = formatProjectContext({
      memoryHead: "## Decisions\n- Use Effect",
    });
    assert.isDefined(memoryOnly);
    assert.include(memoryOnly!, "## Project memory");
    assert.include(memoryOnly!, "- Use Effect");
    assert.include(memoryOnly!, PROJECT_MEMORY_TOOLS_NOTE);
    assert.notInclude(memoryOnly!, PROJECT_INSTRUCTIONS_LEAD);
    assert.notInclude(memoryOnly!, "## Coordinator");
    assert.notInclude(memoryOnly!, "## Project knowledge");

    const combined = formatProjectContext({
      instructions: "Run tests.",
      coordinator: { instructions: "Delegate long tasks." },
      memoryHead: "Memory line",
      knowledgeFiles: ["arch.md", "api.md"],
    });
    assert.isDefined(combined);
    assert.isTrue(combined!.startsWith("<project_instructions>\n"));
    assert.isTrue(combined!.endsWith("\n</project_instructions>"));
    assert.include(combined!, PROJECT_INSTRUCTIONS_LEAD);
    assert.include(combined!, "## Coordinator");
    assert.include(combined!, COORDINATOR_INSTRUCTIONS_LEAD);
    assert.include(combined!, "Delegate long tasks.");
    assert.include(combined!, "## Project memory");
    assert.include(combined!, "## Project knowledge");
    assert.include(combined!, "- arch.md\n- api.md");
  });

  it("formats the coordinator block alone and truncates within 16 KB limit", () => {
    const coordinatorOnly = formatProjectContext({
      coordinator: { instructions: "  Coordinate subthreads carefully.  " },
    });
    assert.equal(
      coordinatorOnly,
      `<project_instructions>\n## Coordinator\n\n${COORDINATOR_INSTRUCTIONS_LEAD}\n\nCoordinate subthreads carefully.\n</project_instructions>`,
    );
    assert.equal(
      formatProjectContext({ coordinator: { instructions: " " } }),
      `<project_instructions>\n## Coordinator\n\n${COORDINATOR_INSTRUCTIONS_LEAD}\n</project_instructions>`,
    );

    const oversized = formatProjectContext({
      instructions: "Keep PRs small.",
      coordinator: { instructions: "c".repeat(20_000) },
      memoryHead: "Memory that won't fit",
    });
    assert.isDefined(oversized);
    assert.isAtMost(Buffer.byteLength(oversized!, "utf8"), PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.include(oversized!, COORDINATOR_INSTRUCTIONS_TRUNCATION_NOTE.trim());
    assert.isTrue(oversized!.endsWith("\n</project_instructions>"));
  });

  it("caps memory preview at 2 KB and knowledge file list at 1 KB", () => {
    const longMemory = "m".repeat(5_000);
    const manyFiles = Array.from({ length: 80 }, (_, i) => `knowledge-document-${i}-notes.md`);
    const formatted = formatProjectContext({
      instructions: "Keep changes small.",
      memoryHead: longMemory,
      knowledgeFiles: manyFiles,
    });
    assert.isDefined(formatted);
    assert.isAtMost(Buffer.byteLength(formatted!, "utf8"), PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.include(formatted!, PROJECT_MEMORY_TRUNCATION_NOTE.trim());
    assert.include(formatted!, PROJECT_KNOWLEDGE_TRUNCATION_NOTE);

    const memoryStart =
      formatted!.indexOf("## Project memory\n\n") + "## Project memory\n\n".length;
    const memoryEnd = formatted!.indexOf(`\n\n${PROJECT_MEMORY_TOOLS_NOTE}`);
    const memoryPreview = formatted!.slice(memoryStart, memoryEnd);
    assert.isAtMost(Buffer.byteLength(memoryPreview, "utf8"), PROJECT_MEMORY_HEAD_MAX_BYTES);

    const knowledgeStart =
      formatted!.indexOf("## Project knowledge\n\n") + "## Project knowledge\n\n".length;
    const knowledgeEnd = formatted!.indexOf("\n</project_instructions>");
    const knowledgeList = formatted!.slice(knowledgeStart, knowledgeEnd);
    assert.isAtMost(Buffer.byteLength(knowledgeList, "utf8"), PROJECT_KNOWLEDGE_LIST_MAX_BYTES);
  });

  it("prioritizes instructions within the 16 KB total cap", () => {
    const bigInstructions = "i".repeat(15_900);
    const formatted = formatProjectContext({
      instructions: bigInstructions,
      coordinator: { instructions: "Should not push over 16 KB" },
      memoryHead: "Should not push over 16 KB",
      knowledgeFiles: ["spec.md"],
    });
    assert.isDefined(formatted);
    assert.isAtMost(Buffer.byteLength(formatted!, "utf8"), PROJECT_INSTRUCTIONS_MAX_BYTES);
    assert.include(formatted!, bigInstructions.slice(0, 100));
  });
});
