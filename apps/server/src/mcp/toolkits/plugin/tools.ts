import { OrchestratorMcpFailure, PluginContribution, PluginId } from "@t3tools/contracts";
import { PLUGIN_WRITE_TOOL_NAME } from "@t3tools/shared/toolOutput";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PluginRegistry.PluginRegistry,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const PluginReadTool = Tool.make("t3_plugin_read", {
  ...shared,
  description:
    "List installed plugins, read one plugin's CSS, and get the guide to restyle T3 Code. Call before `t3_plugin_write`.",
  parameters: Schema.Struct({
    pluginId: Schema.optionalKey(
      PluginId.annotate({ description: "Also return this plugin's manifest fields and CSS." }),
    ),
  }),
  success: Schema.Struct({
    pluginsDir: Schema.String,
    plugins: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        displayName: Schema.optionalKey(Schema.String),
        enabled: Schema.Boolean,
        contributes: Schema.Array(PluginContribution),
        revision: Schema.optionalKey(Schema.String),
        problem: Schema.optionalKey(Schema.String),
      }),
    ),
    plugin: Schema.optionalKey(
      Schema.Struct({
        displayName: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        version: Schema.optionalKey(Schema.String),
        css: Schema.String,
      }),
    ),
    guide: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PluginWriteTool = Tool.make(PLUGIN_WRITE_TOOL_NAME, {
  ...shared,
  description:
    "Create or update a CSS plugin, only when the user asks; call `t3_plugin_read` first. New plugins start off until the user installs them from the card in the chat, edits apply with Undo, and writes need a live full-access/default caller thread.",
  parameters: Schema.Struct({
    pluginId: PluginId,
    displayName: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
    css: Schema.String,
  }),
  success: Schema.Struct({
    pluginId: PluginId,
    created: Schema.Boolean,
    enabled: Schema.Boolean,
    applied: Schema.Boolean,
    contributes: Schema.Array(PluginContribution),
    before: Schema.optionalKey(Schema.String),
    after: Schema.String,
    next: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

export const PluginToolkit = Toolkit.make(PluginReadTool, PluginWriteTool);
