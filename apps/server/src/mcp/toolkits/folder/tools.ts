import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ScopedThreadRef,
  ThreadId,
  ThreadSectionId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const FolderEntry = Schema.Struct({
  id: ThreadSectionId,
  name: Schema.String,
  members: Schema.Array(ScopedThreadRef),
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    SecureRandom.SecureRandom,
  ],
};

const FolderReadTool = Tool.make("t3_folder_read", {
  ...shared,
  description:
    "List this server's thread folders and their member threads. Pass `threadId` to see which folder holds that thread.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({
    folders: Schema.Array(FolderEntry),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FolderUpdateTool = Tool.make("t3_folder_update", {
  ...shared,
  description:
    "Create, rename, or delete (only when the user asks) a thread folder, or add or remove a thread; adding moves it from any other folder. Omit `threadId` for this thread, and pass `environmentId` only for a thread on another server.",
  parameters: Schema.Struct({
    action: Schema.Literals(["create", "rename", "delete", "add_thread", "remove_thread"]),
    folderId: Schema.optional(TrimmedNonEmptyString),
    name: Schema.optional(TrimmedNonEmptyString),
    threadId: Schema.optional(ThreadId),
    environmentId: Schema.optional(
      EnvironmentId.annotate({
        description: "Member thread's server when on another server.",
      }),
    ),
  }),
  success: Schema.Union([
    Schema.Struct({
      folder: FolderEntry,
      thread: Schema.optionalKey(ScopedThreadRef),
    }),
    Schema.Struct({
      deleted: Schema.Literal(true),
      folderId: ThreadSectionId,
    }),
    Schema.Struct({
      folderId: Schema.Null,
      thread: ScopedThreadRef,
    }),
  ]),
}).annotate(Tool.Destructive, true);

export const FolderToolkit = Toolkit.make(FolderReadTool, FolderUpdateTool);
