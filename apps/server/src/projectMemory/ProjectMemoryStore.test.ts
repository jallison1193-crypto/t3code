// @effect-diagnostics nodeBuiltinImport:off -- Tests create real temp directories and symlinks to verify traversal guards.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_FILES,
  PROJECT_MEMORY_MAX_BYTES,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import {
  applyMemorySectionReplacement,
  encodeProjectMemoryDirName,
  ProjectMemoryStore,
  layer as projectMemoryStoreLayer,
} from "./ProjectMemoryStore.ts";

function makeTempTestLayer() {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-project-memory-"));
  const configLayer = ServerConfig.layerTest(tempRoot, tempRoot);
  const storeLayer = projectMemoryStoreLayer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return { tempRoot, storeLayer };
}

describe("encodeProjectMemoryDirName", () => {
  it("produces [A-Za-z0-9_-] only and separates distinct project IDs", () => {
    const samples = [
      ProjectId.make("mcp:175059ba-1234-5678"),
      ProjectId.make("mcp_3a_175059ba-1234-5678"),
      ProjectId.make(".."),
      ProjectId.make("a/b:c*d"),
      ProjectId.make("x".repeat(200)),
    ];
    const encoded = samples.map((id) => encodeProjectMemoryDirName(id));
    for (const dirName of encoded) {
      assert.match(dirName, /^[A-Za-z0-9_-]+$/);
    }
    assert.equal(new Set(encoded).size, samples.length);
  });
});

describe("applyMemorySectionReplacement", () => {
  it("replaces an existing ## section while keeping surrounding sections intact", () => {
    const initial = [
      "# Project Memory",
      "",
      "## Architecture",
      "Old arch",
      "### Details",
      "Old detail",
      "",
      "## Conventions",
      "Keep me",
      "",
    ].join("\n");

    const updated = applyMemorySectionReplacement(
      initial,
      "Architecture",
      "New arch\n### Details\nNew detail",
    );

    assert.equal(
      updated,
      [
        "# Project Memory",
        "",
        "## Architecture",
        "New arch",
        "### Details",
        "New detail",
        "",
        "## Conventions",
        "Keep me",
        "",
      ].join("\n"),
    );
  });

  it("ignores ## headings inside fenced code blocks and creates missing sections", () => {
    const initial = ["## Notes", "```md", "## Target", "inside fence", "```", ""].join("\n");

    const updated = applyMemorySectionReplacement(initial, "Target", "Real section body");
    assert.include(updated, "```md\n## Target\ninside fence\n```");
    assert.include(updated, "\n## Target\nReal section body\n");
  });
});

describe("ProjectMemoryStore", () => {
  it.effect("reads empty memory initially, writes atomically, appends, and replaces sections", () =>
    Effect.gen(function* () {
      const { tempRoot, storeLayer } = makeTempTestLayer();
      try {
        yield* Effect.gen(function* () {
          const store = yield* ProjectMemoryStore;
          const projectId = ProjectId.make("mcp:proj-alpha");

          const empty = yield* store.readMemory(projectId);
          assert.isFalse(empty.exists);
          assert.equal(empty.content, "");
          assert.isNull(empty.updatedAt);

          const written = yield* store.writeMemory(projectId, "# Memory\nLine 1");
          assert.isAbove(written.sizeBytes, 0);

          yield* store.appendMemory(projectId, "## Decisions\nUse Effect");
          const afterAppend = yield* store.readMemory(projectId);
          assert.isTrue(afterAppend.exists);
          assert.equal(afterAppend.content, "# Memory\nLine 1\n## Decisions\nUse Effect");

          yield* store.replaceMemorySection(projectId, "## Decisions", "Use Effect v4");
          const afterReplace = yield* store.readMemory(projectId);
          assert.equal(afterReplace.content, "# Memory\nLine 1\n## Decisions\nUse Effect v4\n");

          const config = yield* ServerConfig;
          const dirName = encodeProjectMemoryDirName(projectId);
          assert.match(dirName, /^[A-Za-z0-9_-]+$/);
          assert.isTrue(
            NodeFS.existsSync(NodePath.join(config.stateDir, "projects", dirName, "MEMORY.md")),
          );
        }).pipe(Effect.provide(storeLayer));
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rejects path traversal and invalid knowledge file names", () =>
    Effect.gen(function* () {
      const { tempRoot, storeLayer } = makeTempTestLayer();
      try {
        yield* Effect.gen(function* () {
          const store = yield* ProjectMemoryStore;
          const projectId = ProjectId.make("proj-traversal");

          for (const badName of [
            "../secret.md",
            "..\\secret.md",
            "nested/file.md",
            "nested\\file.md",
            ".",
            "..",
            "CON.txt",
            "bad:name.md",
            "file.staging-123",
            "   ",
          ]) {
            const exit = yield* Effect.exit(store.addKnowledge(projectId, badName, "hello"));
            assert.isTrue(Exit.isFailure(exit));
          }
        }).pipe(Effect.provide(storeLayer));
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("enforces memory size, knowledge file size, and 100-file caps", () =>
    Effect.gen(function* () {
      const { tempRoot, storeLayer } = makeTempTestLayer();
      try {
        yield* Effect.gen(function* () {
          const store = yield* ProjectMemoryStore;
          const projectId = ProjectId.make("proj-caps");

          const memoryOverExit = yield* Effect.exit(
            store.writeMemory(projectId, "a".repeat(PROJECT_MEMORY_MAX_BYTES + 1)),
          );
          assert.isTrue(Exit.isFailure(memoryOverExit));

          const knowledgeOverExit = yield* Effect.exit(
            store.addKnowledge(
              projectId,
              "huge.txt",
              "b".repeat(PROJECT_KNOWLEDGE_FILE_MAX_BYTES + 1),
            ),
          );
          assert.isTrue(Exit.isFailure(knowledgeOverExit));

          for (let i = 0; i < PROJECT_KNOWLEDGE_MAX_FILES; i += 1) {
            yield* store.addKnowledge(
              projectId,
              `doc-${String(i).padStart(3, "0")}.md`,
              `doc ${i}`,
            );
          }

          // Overwriting an existing file at the 100-file cap succeeds.
          yield* store.addKnowledge(projectId, "doc-000.md", "updated doc 0");

          // Adding a 101st distinct file fails.
          const extraExit = yield* Effect.exit(
            store.addKnowledge(projectId, "doc-100.md", "too many"),
          );
          assert.isTrue(Exit.isFailure(extraExit));

          const listed = yield* store.listKnowledge(projectId);
          assert.equal(listed.length, PROJECT_KNOWLEDGE_MAX_FILES);
        }).pipe(Effect.provide(storeLayer));
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "reads line ranges, deletes files, and ranks search matches across 40-line chunks",
    () =>
      Effect.gen(function* () {
        const { tempRoot, storeLayer } = makeTempTestLayer();
        try {
          yield* Effect.gen(function* () {
            const store = yield* ProjectMemoryStore;
            const projectId = ProjectId.make("proj-search");

            const chunkedLines = Array.from({ length: 85 }, (_, i) => {
              const lineNum = i + 1;
              if (lineNum === 50) return "sqlite projection replay architecture";
              return `spacer line ${lineNum}`;
            }).join("\n");

            yield* store.addKnowledge(projectId, "architecture.md", chunkedLines);
            yield* store.addKnowledge(
              projectId,
              "notes.md",
              "mentioning sqlite once without the other terms",
            );

            const range = yield* store.readKnowledge(projectId, "architecture.md", {
              startLine: 49,
              endLine: 51,
            });
            assert.equal(range.startLine, 49);
            assert.equal(range.endLine, 51);
            assert.equal(range.totalLines, 85);
            assert.include(range.content, "sqlite projection replay architecture");

            const matches = yield* store.searchKnowledge(projectId, "sqlite replay", 5);
            assert.isAtLeast(matches.length, 2);
            assert.equal(matches[0]!.name, "architecture.md");
            assert.equal(matches[0]!.startLine, 41);
            assert.equal(matches[0]!.endLine, 80);
            assert.include(matches[0]!.snippet, "sqlite projection replay architecture");

            const deleted = yield* store.deleteKnowledge(projectId, "notes.md");
            assert.isTrue(deleted.deleted);
            const remaining = yield* store.listKnowledge(projectId);
            assert.deepEqual(
              remaining.map((f) => f.name),
              ["architecture.md"],
            );
          }).pipe(Effect.provide(storeLayer));
        } finally {
          NodeFS.rmSync(tempRoot, { recursive: true, force: true });
        }
      }),
  );
});
