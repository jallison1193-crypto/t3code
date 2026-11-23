import {
  clampedPositiveInt,
  IsoDateTime,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HtmlLibrary from "../../../orchestration-v2/HtmlLibrary.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const LibraryPage = Schema.Struct({
  title: Schema.String,
  threadId: ThreadId,
  threadTitle: Schema.String,
  itemId: TurnItemId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  pinned: Schema.Boolean,
  pinnedAt: Schema.optionalKey(IsoDateTime),
  updatedAt: IsoDateTime,
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlLibrary.HtmlLibrary,
  ],
};

const LibraryReadTool = Tool.make("t3_library_read", {
  ...shared,
  description:
    "List HTML Library pages on this server, optionally filtered by `projectId` or `pinned: true`. Default `limit` is 20 (max 100).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    pinned: Schema.optional(Schema.Boolean),
    limit: Schema.optional(clampedPositiveInt(100)),
  }),
  success: Schema.Struct({
    pages: Schema.Array(LibraryPage),
    hasMore: Schema.Boolean,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const LibraryUpdateTool = Tool.make("t3_library_update", {
  ...shared,
  description:
    "Pin, unpin, or rename (only when the user asks) an HTML Library page by `threadId` and `itemId`. Omit `title` or pass an empty string with `rename` to restore the original title.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    action: Schema.Literals(["pin", "unpin", "rename"]),
    threadId: ThreadId,
    itemId: TurnItemId,
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  }),
  success: Schema.Struct({
    page: LibraryPage,
  }),
}).annotate(Tool.Destructive, true);

export const LibraryToolkit = Toolkit.make(LibraryReadTool, LibraryUpdateTool);
