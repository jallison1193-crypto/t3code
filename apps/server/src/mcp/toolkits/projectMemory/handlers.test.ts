// @effect-diagnostics nodeBuiltinImport:off -- Tests create real temp directories for the store.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import { ServerConfig } from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectMemoryStore from "../../../projectMemory/ProjectMemoryStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ProjectMemoryHandlers from "./handlers.ts";
import { ProjectMemoryToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-memory-1");
const OTHER_PROJECT_ID = ProjectId.make("project-memory-2");
const MISSING_PROJECT_ID = ProjectId.make("project-missing");
const THREAD_ID = ThreadId.make("thread-memory-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

const makeProject = (id: ProjectId): Project => ({
  id,
  title: `Project ${id}`,
  workspaceRoot: `/workspace/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null,
});

const callerThread: OrchestrationV2ThreadShell = {
  ...liveThreadShell(THREAD_ID),
  projectId: PROJECT_ID,
};

const makeScope = (
  access: "read-only" | "full-access" = "full-access",
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: PROVIDER_INSTANCE_ID,
  },
  client:
    access === "read-only"
      ? { sessionId: "client-ro", label: "RO", access: "read-only" }
      : undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeProjectMemoryToolkitHarness")(function* () {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-memory-"));
  const storeLayer = ProjectMemoryStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(tempRoot, tempRoot)),
    Layer.provideMerge(NodeServices.layer),
  );
  const layerDependencies = Layer.mergeAll(
    storeLayer,
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === PROJECT_ID || id === OTHER_PROJECT_ID
            ? Option.some(makeProject(id))
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(id === THREAD_ID ? callerThread : null),
    }),
  );
  const toolkit = yield* ProjectMemoryToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectMemoryHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof ProjectMemoryToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = makeScope(),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ProjectMemoryToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );
  return {
    call,
    cleanup: () => NodeFS.rmSync(tempRoot, { recursive: true, force: true }),
  };
});

describe("projectMemory MCP toolkit handlers", () => {
  it.effect("defaults to caller thread project and supports memory & knowledge round-trips", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      try {
        const empty = yield* harness.call("t3_project_memory_read", {});
        assert.equal(empty.projectId, PROJECT_ID);
        assert.isFalse(empty.exists);

        yield* harness.call("t3_project_memory_write", {
          mode: "replace",
          content: "# Project Memory\n\n## Decisions\nInitial",
        });
        yield* harness.call("t3_project_memory_write", {
          mode: "replace_section",
          heading: "Decisions",
          content: "Updated decision",
        });
        yield* harness.call("t3_project_memory_write", {
          mode: "append",
          content: "## Tail\nMore notes",
        });

        const mem = yield* harness.call("t3_project_memory_read", {});
        assert.isTrue(mem.exists);
        assert.include(mem.content, "Updated decision");
        assert.include(mem.content, "More notes");

        yield* harness.call("t3_project_knowledge_add", {
          name: "guide.md",
          content: "line 1\nkeyword alpha beta\nline 3",
        });
        const list = yield* harness.call("t3_project_knowledge_list", {});
        assert.deepEqual(
          list.files.map((f) => f.name),
          ["guide.md"],
        );

        const search = yield* harness.call("t3_project_knowledge_search", { query: "alpha beta" });
        assert.equal(search.matches.length, 1);
        assert.equal(search.matches[0]!.name, "guide.md");

        const read = yield* harness.call("t3_project_knowledge_read", {
          name: "guide.md",
          startLine: 2,
          endLine: 2,
        });
        assert.equal(read.content, "keyword alpha beta");

        const deleted = yield* harness.call("t3_project_knowledge_delete", { name: "guide.md" });
        assert.isTrue(deleted.deleted);
      } finally {
        harness.cleanup();
      }
    }),
  );

  it.effect(
    "targets explicit projectId, rejects missing projects, and blocks read-only writes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        try {
          yield* harness.call("t3_project_memory_write", {
            projectId: OTHER_PROJECT_ID,
            mode: "replace",
            content: "Other project memory",
          });
          const otherMem = yield* harness.call("t3_project_memory_read", {
            projectId: OTHER_PROJECT_ID,
          });
          assert.equal(otherMem.content, "Other project memory");

          const missing = yield* harness.call("t3_project_memory_read", {
            projectId: MISSING_PROJECT_ID,
          });
          expect(missing).toMatchObject({ code: "invalid_request" });

          // Read works under read-only MCP client; write is refused.
          const roRead = yield* harness.call(
            "t3_project_memory_read",
            { projectId: OTHER_PROJECT_ID },
            makeScope("read-only"),
          );
          assert.equal(roRead.content, "Other project memory");

          const roWrite = yield* harness.call(
            "t3_project_memory_write",
            { mode: "append", content: "nope" },
            makeScope("read-only"),
          );
          expect(roWrite).toMatchObject({ code: "capability_denied" });
        } finally {
          harness.cleanup();
        }
      }),
  );
});
