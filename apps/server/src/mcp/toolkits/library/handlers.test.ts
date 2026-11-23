import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { createAttachmentId } from "../../../attachmentStore.ts";
import * as HtmlLibrary from "../../../orchestration-v2/HtmlLibrary.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as LibraryHandlers from "./handlers.ts";
import { LibraryToolkit } from "./tools.ts";

const ENV_ID = EnvironmentId.make("env:library");
const PROJECT_A = ProjectId.make("project:alpha");
const PROJECT_B = ProjectId.make("project:beta");
const THREAD_A = ThreadId.make("thread:alpha");
const THREAD_B = ThreadId.make("thread:beta");
const SUPERVISED_THREAD = ThreadId.make("thread:supervised");
const ITEM_1 = TurnItemId.make("item-1");
const ITEM_2 = TurnItemId.make("item-2");
const ITEM_3 = TurnItemId.make("item-3");

const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [THREAD_A, { ...liveThreadShell(THREAD_A), projectId: PROJECT_A }],
  [THREAD_B, { ...liveThreadShell(THREAD_B), projectId: PROJECT_B }],
  [
    SUPERVISED_THREAD,
    {
      ...liveThreadShell(SUPERVISED_THREAD, { runtimeMode: "approval-required" }),
      projectId: PROJECT_A,
    },
  ],
]);

const threadScope = (threadId: ThreadId = THREAD_A): McpInvocationContext.McpInvocationScope => ({
  environmentId: ENV_ID,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: ENV_ID,
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Test Client", access },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const seedLibrary = Effect.fn("LibraryToolkitTest.seedLibrary")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const createdAt = "2026-11-20T10:00:00.000Z";
  for (const [id, title] of [
    [PROJECT_A, "Alpha"],
    [PROJECT_B, "Beta"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, ${title}, ${`/workspace/${id}`}, '[]', ${createdAt}, ${createdAt})
    `;
  }
  for (const [id, projectId, title] of [
    [THREAD_A, PROJECT_A, "Alpha thread"],
    [THREAD_B, PROJECT_B, "Beta thread"],
  ] as const) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json)
      VALUES (${id}, ${projectId}, ${title}, 'codex', 'full-access', 'default',
        ${createdAt}, ${createdAt}, '{}')
    `;
  }
  const addPage = (itemId: TurnItemId, threadId: ThreadId, title: string, updatedAt: string) => {
    const attachmentId = createAttachmentId(threadId, "html")!;
    const payload = JSON.stringify({
      toolName: "html_render",
      output: { htmlRender: { attachmentId, title, height: 320 } },
    });
    return sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json, inline_work_output)
      VALUES (${itemId}, ${threadId}, 1, 'dynamic_tool', 'completed', ${updatedAt}, ${payload}, 1)
    `;
  };
  yield* addPage(ITEM_1, THREAD_A, "Revenue chart", "2026-11-21T10:00:00.000Z");
  yield* addPage(ITEM_2, THREAD_A, "Latency breakdown", "2026-11-21T11:00:00.000Z");
  yield* addPage(ITEM_3, THREAD_B, "Deploy checklist", "2026-11-21T12:00:00.000Z");
});

const makeHarness = Effect.fn("LibraryToolkitTest.makeHarness")(function* () {
  const baseServices = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    }),
  );
  const layerDependencies = HtmlLibrary.layer.pipe(Layer.provideMerge(baseServices));
  const context = yield* Layer.build(layerDependencies);
  yield* seedLibrary().pipe(Effect.provide(context));
  const toolkit = yield* LibraryToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(LibraryHandlers.layer).pipe(
        Layer.provide(Layer.succeedContext(context)),
      ),
    ),
  );
  const call = <Name extends keyof typeof LibraryToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = threadScope(),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(context),
    );
  return { call, context };
});

describe("library MCP toolkit handlers", () => {
  it.effect(
    "reads with project, pinned, and limit filters; pins, unpins, renames, and resets",
    () =>
      Effect.gen(function* () {
        const { call, context } = yield* makeHarness();

        const all = yield* call("t3_library_read", {});
        expect(all).toEqual({
          pages: [
            {
              title: "Deploy checklist",
              threadId: THREAD_B,
              threadTitle: "Beta thread",
              itemId: ITEM_3,
              projectId: PROJECT_B,
              projectTitle: "Beta",
              pinned: false,
              updatedAt: "2026-11-21T12:00:00.000Z",
            },
            {
              title: "Latency breakdown",
              threadId: THREAD_A,
              threadTitle: "Alpha thread",
              itemId: ITEM_2,
              projectId: PROJECT_A,
              projectTitle: "Alpha",
              pinned: false,
              updatedAt: "2026-11-21T11:00:00.000Z",
            },
            {
              title: "Revenue chart",
              threadId: THREAD_A,
              threadTitle: "Alpha thread",
              itemId: ITEM_1,
              projectId: PROJECT_A,
              projectTitle: "Alpha",
              pinned: false,
              updatedAt: "2026-11-21T10:00:00.000Z",
            },
          ],
          hasMore: false,
        });

        const limited = yield* call("t3_library_read", { limit: 2 });
        expect(limited).toMatchObject({
          pages: [{ itemId: ITEM_3 }, { itemId: ITEM_2 }],
          hasMore: true,
        });

        const projectA = yield* call("t3_library_read", { projectId: PROJECT_A });
        expect(projectA).toMatchObject({
          pages: [{ itemId: ITEM_2 }, { itemId: ITEM_1 }],
          hasMore: false,
        });

        expect(yield* call("t3_library_read", { pinned: true })).toEqual({
          pages: [],
          hasMore: false,
        });

        // Pin two pages at distinct TestClock timestamps so newest pin sorts first.
        yield* TestClock.setTime(Date.parse("2026-11-22T01:00:00.000Z"));
        const pinnedFirst = yield* call("t3_library_update", {
          action: "pin",
          threadId: THREAD_A,
          itemId: ITEM_1,
        });
        expect(pinnedFirst).toMatchObject({
          page: {
            itemId: ITEM_1,
            title: "Revenue chart",
            pinned: true,
            pinnedAt: "2026-11-22T01:00:00.000Z",
          },
        });

        yield* TestClock.adjust(Duration.hours(1));
        yield* call("t3_library_update", {
          action: "pin",
          threadId: THREAD_B,
          itemId: ITEM_3,
        });

        expect(yield* call("t3_library_read", { pinned: true, limit: 1 })).toMatchObject({
          pages: [{ itemId: ITEM_3, pinned: true, pinnedAt: "2026-11-22T02:00:00.000Z" }],
          hasMore: true,
        });

        // Rename preserves pinned state; unpin preserves renamed title.
        expect(
          yield* call("t3_library_update", {
            action: "rename",
            threadId: THREAD_A,
            itemId: ITEM_1,
            title: "  Q4 Revenue  ",
          }),
        ).toMatchObject({
          page: {
            itemId: ITEM_1,
            title: "Q4 Revenue",
            pinned: true,
            pinnedAt: "2026-11-22T01:00:00.000Z",
          },
        });

        expect(
          yield* call("t3_library_update", {
            action: "unpin",
            threadId: THREAD_A,
            itemId: ITEM_1,
          }),
        ).toMatchObject({
          page: { itemId: ITEM_1, title: "Q4 Revenue", pinned: false },
        });
        expect(yield* call("t3_library_read", { pinned: true })).toMatchObject({
          pages: [{ itemId: ITEM_3 }],
          hasMore: false,
        });

        // Reset title with empty string restores original title and clears the override.
        expect(
          yield* call("t3_library_update", {
            action: "rename",
            threadId: THREAD_A,
            itemId: ITEM_1,
            title: "",
          }),
        ).toMatchObject({
          page: { itemId: ITEM_1, title: "Revenue chart", pinned: false },
        });

        // Rename again and reset with omitted title.
        yield* call("t3_library_update", {
          action: "rename",
          threadId: THREAD_A,
          itemId: ITEM_1,
          title: "Temporary title",
        });
        expect(
          yield* call("t3_library_update", {
            action: "rename",
            threadId: THREAD_A,
            itemId: ITEM_1,
          }),
        ).toMatchObject({
          page: { itemId: ITEM_1, title: "Revenue chart", pinned: false },
        });

        // Unpinning the last pinned entry clears its override entry completely.
        yield* call("t3_library_update", {
          action: "unpin",
          threadId: THREAD_B,
          itemId: ITEM_3,
        });
        const settings = yield* ServerSettings.ServerSettingsService.pipe(
          Effect.flatMap((service) => service.getSettings),
          Effect.provide(context),
        );
        expect(settings.htmlLibraryEntries).toEqual({});
      }).pipe(Effect.scoped),
  );

  it.effect("rejects missing pages, invalid titles, and unauthorized mutations", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();

      expect(
        yield* call("t3_library_update", {
          action: "pin",
          threadId: THREAD_A,
          itemId: TurnItemId.make("missing-item"),
        }),
      ).toMatchObject({
        code: "invalid_request",
        message: "The HTML Library page was not found.",
      });

      expect(
        yield* call("t3_library_update", {
          action: "rename",
          threadId: THREAD_A,
          itemId: ITEM_1,
          title: "Line 1\nLine 2",
        }),
      ).toMatchObject({
        code: "invalid_request",
        message: "Page title must be a single line.",
      });

      expect(yield* call("t3_library_read", {}, clientScope("read-only"))).toMatchObject({
        hasMore: false,
      });
      expect(
        yield* call(
          "t3_library_update",
          { action: "pin", threadId: THREAD_A, itemId: ITEM_1 },
          clientScope("read-only"),
        ),
      ).toMatchObject({ code: "capability_denied" });

      expect(
        yield* call(
          "t3_library_update",
          { action: "pin", threadId: THREAD_A, itemId: ITEM_1 },
          threadScope(SUPERVISED_THREAD),
        ),
      ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(Effect.scoped),
  );
});
