import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertTargetWithinLimits,
  readCaller,
  threadNotFound,
  unavailable,
} from "../../threadAccess.ts";
import { FolderToolkit } from "./tools.ts";

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

const mapFolderError = (
  error: ServerSettingsError | ServerSettings.ThreadFolderInvalidNameError,
): OrchestratorMcpFailure => {
  if (error._tag === "ThreadFolderInvalidNameError") {
    return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
  }
  if (error.operation === "thread-section-not-found") {
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The thread folder was not found.",
    });
  }
  if (error.operation === "write-managed-setting") {
    return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
  }
  return unavailable();
};

const handleFolderUpdate = Effect.fn("FolderToolkit.update")(function* (input: {
  readonly action: "create" | "rename" | "delete" | "add_thread" | "remove_thread";
  readonly folderId?: string | undefined;
  readonly name?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly environmentId?: EnvironmentId | undefined;
}) {
  const context = yield* readCaller();
  switch (input.action) {
    case "create": {
      const name = yield* required(input.name, "name");
      return yield* ServerSettings.updateThreadFolder({ action: "create", name }).pipe(
        Effect.mapError(mapFolderError),
      );
    }
    case "rename": {
      const folderId = yield* required(input.folderId, "folderId");
      const name = yield* required(input.name, "name");
      return yield* ServerSettings.updateThreadFolder({ action: "rename", folderId, name }).pipe(
        Effect.mapError(mapFolderError),
      );
    }
    case "delete": {
      const folderId = yield* required(input.folderId, "folderId");
      return yield* ServerSettings.updateThreadFolder({ action: "delete", folderId }).pipe(
        Effect.mapError(mapFolderError),
      );
    }
    case "add_thread":
    case "remove_thread": {
      if (
        input.threadId === undefined &&
        input.environmentId !== undefined &&
        input.environmentId !== context.scope.environmentId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass `threadId` when specifying a different `environmentId`.",
        });
      }
      const threadId = input.threadId ?? context.caller?.id;
      if (threadId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass threadId: this MCP client is not running inside a T3 thread.",
        });
      }
      const environmentId = input.environmentId ?? context.scope.environmentId;
      if (environmentId === context.scope.environmentId) {
        const shell = yield* context.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (input.action === "add_thread" && (shell === null || shell.deletedAt !== null)) {
          return yield* threadNotFound(
            context.threads,
            context.scope,
            threadId,
            "The thread was not found.",
          );
        }
        // `writes` handled explicit `environmentId`; enforce target-thread limits for local refs too.
        if (
          input.environmentId !== undefined &&
          threadId !== context.scope.thread?.threadId &&
          shell !== null &&
          shell.deletedAt === null
        ) {
          yield* assertTargetWithinLimits(context.limits, shell);
          yield* assertSameLink(context, shell);
        }
      }
      const thread = { environmentId, threadId };
      if (input.action === "add_thread") {
        const folderId = yield* required(input.folderId, "folderId");
        return yield* ServerSettings.updateThreadFolder({
          action: "add_thread",
          serverEnvironmentId: context.scope.environmentId,
          folderId,
          thread,
        }).pipe(Effect.mapError(mapFolderError));
      }
      return yield* ServerSettings.updateThreadFolder({
        action: "remove_thread",
        serverEnvironmentId: context.scope.environmentId,
        thread,
      }).pipe(Effect.mapError(mapFolderError));
    }
  }
});

export const layer = McpToolAccess.toLayer(FolderToolkit, {
  t3_folder_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const folders = yield* ServerSettings.listThreadFolders({ threadId: input.threadId }).pipe(
        Effect.mapError(unavailable),
      );
      return { folders };
    }),
  ),
  t3_folder_update: McpToolAccess.either(
    (input) =>
      (input.action === "add_thread" || input.action === "remove_thread") &&
      input.environmentId === undefined,
    McpToolAccess.writesThreads((input) => [input.threadId], handleFolderUpdate),
    McpToolAccess.writes(handleFolderUpdate),
  ),
});
