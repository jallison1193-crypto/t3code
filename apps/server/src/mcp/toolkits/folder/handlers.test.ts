import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ThreadSectionId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as FolderHandlers from "./handlers.ts";
import { FolderToolkit } from "./tools.ts";

const LOCAL_ENV = EnvironmentId.make("env:local");
const REMOTE_ENV = EnvironmentId.make("env:remote");
const CALLER_THREAD = ThreadId.make("thread:caller");
const OTHER_THREAD = ThreadId.make("thread:other");
const FULL_ACCESS_THREAD = ThreadId.make("thread:full-access");
const SUPERVISED_THREAD = ThreadId.make("thread:supervised");
const REMOTE_THREAD = ThreadId.make("thread:remote");
const MISSING_FOLDER = ThreadSectionId.make("00000000-0000-4000-8000-000000000099");

const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [CALLER_THREAD, liveThreadShell(CALLER_THREAD)],
  [OTHER_THREAD, liveThreadShell(OTHER_THREAD)],
  [FULL_ACCESS_THREAD, liveThreadShell(FULL_ACCESS_THREAD, { runtimeMode: "full-access" })],
  [SUPERVISED_THREAD, liveThreadShell(SUPERVISED_THREAD, { runtimeMode: "approval-required" })],
]);

const threadScope = (
  threadId: ThreadId = CALLER_THREAD,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: LOCAL_ENV,
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
  environmentId: LOCAL_ENV,
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Test Client", access },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const expectFolderId = (result: unknown): ThreadSectionId => {
  if (
    typeof result === "object" &&
    result !== null &&
    "folder" in result &&
    typeof result.folder === "object" &&
    result.folder !== null &&
    "id" in result.folder &&
    typeof result.folder.id === "string"
  ) {
    return ThreadSectionId.make(result.folder.id);
  }
  throw new Error(`Expected folder result, got: ${JSON.stringify(result)}`);
};

const makeHarness = Effect.fn("FolderToolkitTest.makeHarness")(function* () {
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest(),
    NodeCrypto.layer,
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    }),
  );
  const context = yield* Layer.build(layerDependencies);
  const toolkit = yield* FolderToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FolderHandlers.layer).pipe(
        Layer.provide(Layer.succeedContext(context)),
      ),
    ),
  );
  const call = <Name extends keyof typeof FolderToolkit.tools>(
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
  return { call };
});

describe("folder MCP toolkit handlers", () => {
  it.effect(
    "creates, renames, moves threads between folders, removes threads, and deletes folders",
    () =>
      Effect.gen(function* () {
        const { call } = yield* makeHarness();

        expect(yield* call("t3_folder_read", {})).toEqual({ folders: [] });

        const inboxResult = yield* call("t3_folder_update", { action: "create", name: "Inbox" });
        expect(inboxResult).toMatchObject({ folder: { name: "Inbox", members: [] } });
        const inboxId = expectFolderId(inboxResult);

        const readingResult = yield* call("t3_folder_update", {
          action: "create",
          name: "Reading",
        });
        const readingId = expectFolderId(readingResult);

        expect(
          yield* call("t3_folder_update", {
            action: "rename",
            folderId: inboxId,
            name: "Triage",
          }),
        ).toEqual({ folder: { id: inboxId, name: "Triage", members: [] } });

        // Omitted threadId targets the caller thread.
        expect(
          yield* call("t3_folder_update", {
            action: "add_thread",
            folderId: inboxId,
          }),
        ).toEqual({
          folder: {
            id: inboxId,
            name: "Triage",
            members: [{ environmentId: LOCAL_ENV, threadId: CALLER_THREAD }],
          },
          thread: { environmentId: LOCAL_ENV, threadId: CALLER_THREAD },
        });

        expect(yield* call("t3_folder_read", { threadId: CALLER_THREAD })).toEqual({
          folders: [
            {
              id: inboxId,
              name: "Triage",
              members: [{ environmentId: LOCAL_ENV, threadId: CALLER_THREAD }],
            },
          ],
        });

        // add_thread moves the caller thread out of Triage and into Reading.
        expect(
          yield* call("t3_folder_update", {
            action: "add_thread",
            folderId: readingId,
          }),
        ).toEqual({
          folder: {
            id: readingId,
            name: "Reading",
            members: [{ environmentId: LOCAL_ENV, threadId: CALLER_THREAD }],
          },
          thread: { environmentId: LOCAL_ENV, threadId: CALLER_THREAD },
        });

        expect(yield* call("t3_folder_read", {})).toEqual({
          folders: [
            { id: inboxId, name: "Triage", members: [] },
            {
              id: readingId,
              name: "Reading",
              members: [{ environmentId: LOCAL_ENV, threadId: CALLER_THREAD }],
            },
          ],
        });

        // Supports threads on another server via explicit environmentId.
        expect(
          yield* call("t3_folder_update", {
            action: "add_thread",
            folderId: readingId,
            threadId: REMOTE_THREAD,
            environmentId: REMOTE_ENV,
          }),
        ).toEqual({
          folder: {
            id: readingId,
            name: "Reading",
            members: [
              { environmentId: LOCAL_ENV, threadId: CALLER_THREAD },
              { environmentId: REMOTE_ENV, threadId: REMOTE_THREAD },
            ],
          },
          thread: { environmentId: REMOTE_ENV, threadId: REMOTE_THREAD },
        });

        // remove_thread with omitted threadId removes the caller thread.
        expect(yield* call("t3_folder_update", { action: "remove_thread" })).toEqual({
          folderId: null,
          thread: { environmentId: LOCAL_ENV, threadId: CALLER_THREAD },
        });
        expect(yield* call("t3_folder_read", { threadId: CALLER_THREAD })).toEqual({ folders: [] });

        // remove_thread with explicit remote environmentId removes the remote thread.
        expect(
          yield* call("t3_folder_update", {
            action: "remove_thread",
            threadId: REMOTE_THREAD,
            environmentId: REMOTE_ENV,
          }),
        ).toEqual({
          folderId: null,
          thread: { environmentId: REMOTE_ENV, threadId: REMOTE_THREAD },
        });

        expect(yield* call("t3_folder_update", { action: "delete", folderId: inboxId })).toEqual({
          deleted: true,
          folderId: inboxId,
        });
        expect(yield* call("t3_folder_read", {})).toEqual({
          folders: [{ id: readingId, name: "Reading", members: [] }],
        });
      }).pipe(Effect.scoped),
  );

  it.effect("rejects unknown folder ids, invalid names, and unauthorized mutations", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness();

      for (const badId of [MISSING_FOLDER, "not-a-uuid"]) {
        expect(
          yield* call("t3_folder_update", { action: "rename", folderId: badId, name: "Nope" }),
        ).toMatchObject({
          code: "invalid_request",
          message: "The thread folder was not found.",
        });
        expect(
          yield* call("t3_folder_update", { action: "delete", folderId: badId }),
        ).toMatchObject({
          code: "invalid_request",
          message: "The thread folder was not found.",
        });
        expect(
          yield* call("t3_folder_update", {
            action: "add_thread",
            folderId: badId,
            threadId: OTHER_THREAD,
          }),
        ).toMatchObject({
          code: "invalid_request",
          message: "The thread folder was not found.",
        });
      }

      expect(
        yield* call("t3_folder_update", { action: "create", name: "Line 1\nLine 2" }),
      ).toMatchObject({ code: "invalid_request" });

      const created = yield* call("t3_folder_update", { action: "create", name: "Work" });
      const folderId = expectFolderId(created);

      // Outside client omitting threadId gets target_required.
      expect(
        yield* call(
          "t3_folder_update",
          { action: "add_thread", folderId },
          clientScope("full-access"),
        ),
      ).toMatchObject({ code: "target_required" });

      // Read-only client can read folders but cannot mutate them.
      expect(yield* call("t3_folder_read", {}, clientScope("read-only"))).toEqual({
        folders: [{ id: folderId, name: "Work", members: [] }],
      });
      expect(
        yield* call(
          "t3_folder_update",
          { action: "create", name: "Blocked" },
          clientScope("read-only"),
        ),
      ).toMatchObject({ code: "capability_denied" });

      // Supervised thread cannot assign a full-access thread (with omitted or explicit local env).
      expect(
        yield* call(
          "t3_folder_update",
          { action: "add_thread", folderId, threadId: FULL_ACCESS_THREAD },
          threadScope(SUPERVISED_THREAD),
        ),
      ).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(
        yield* call(
          "t3_folder_update",
          {
            action: "add_thread",
            folderId,
            threadId: FULL_ACCESS_THREAD,
            environmentId: LOCAL_ENV,
          },
          threadScope(SUPERVISED_THREAD),
        ),
      ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(Effect.scoped),
  );
});
