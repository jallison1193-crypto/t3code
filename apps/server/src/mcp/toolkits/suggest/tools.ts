import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  THREAD_SUGGEST_TOOL_NAME,
  ThreadSuggestion,
  ThreadSuggestionsList,
} from "@t3tools/shared/toolOutput";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadSuggestTool = Tool.make(THREAD_SUGGEST_TOOL_NAME, {
  description:
    "Propose new threads for the user to start, each with a title and the first prompt. Use when you see follow-up work worth its own thread and the user hasn't asked you to start it; the user decides.",
  parameters: Schema.Struct({
    suggestions: ThreadSuggestionsList,
  }),
  success: Schema.Struct({
    suggestions: Schema.Array(ThreadSuggestion),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Suggest threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const SuggestToolkit = Toolkit.make(ThreadSuggestTool);
