import {
  InstalledPluginPanel,
  InstalledPluginWorker,
  OrchestratorMcpFailure,
  PLUGIN_PANEL_TITLE_MAX_LENGTH,
  PLUGIN_WORKER_CODE_MAX_CHARS,
  PluginChangeWorker,
  PluginContribution,
  PluginId,
  PluginManifestWorkerFolder,
  PluginWorkerEveryMinutes,
} from "@t3tools/contracts";
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

const PluginPanelContentSchema = Schema.Struct({
  id: PluginId,
  title: Schema.String.annotate({
    description: `Tab title: one line, at most ${PLUGIN_PANEL_TITLE_MAX_LENGTH} characters.`,
  }),
  html: Schema.String,
});

const PluginWorkerContentSchema = Schema.Struct({
  code: Schema.String.annotate({
    description: `Worker ESM source (default export receives t3), up to ${PLUGIN_WORKER_CODE_MAX_CHARS} characters.`,
  }),
  everyMinutes: Schema.optionalKey(PluginWorkerEveryMinutes),
  folders: Schema.optionalKey(Schema.Array(PluginManifestWorkerFolder)),
  network: Schema.optionalKey(Schema.Boolean),
});

const PluginReadTool = Tool.make("t3_plugin_read", {
  ...shared,
  description:
    "List installed plugins, read one plugin's CSS, panels, or worker, and get the guide to build plugins. Call before `t3_plugin_write`.",
  parameters: Schema.Struct({
    pluginId: Schema.optionalKey(
      PluginId.annotate({
        description: "Also return this plugin's manifest fields, CSS, panels, and worker.",
      }),
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
        panels: Schema.optionalKey(Schema.Array(InstalledPluginPanel)),
        worker: Schema.optionalKey(InstalledPluginWorker),
        revision: Schema.optionalKey(Schema.String),
        problem: Schema.optionalKey(Schema.String),
      }),
    ),
    plugin: Schema.optionalKey(
      Schema.Struct({
        displayName: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        version: Schema.optionalKey(Schema.String),
        css: Schema.optionalKey(Schema.String),
        panels: Schema.optionalKey(Schema.Array(PluginPanelContentSchema)),
        worker: Schema.optionalKey(PluginWorkerContentSchema),
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
    "Create or update a plugin with CSS, right panel tabs, and/or a background worker, only when the user asks; call `t3_plugin_read` first. New plugins start off until Install, edits apply with Undo, and writes need a live full-access/default caller thread.",
  parameters: Schema.Struct({
    pluginId: PluginId,
    displayName: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
    css: Schema.optionalKey(Schema.String),
    panels: Schema.optionalKey(Schema.Array(PluginPanelContentSchema)),
    worker: Schema.optionalKey(PluginWorkerContentSchema),
  }),
  success: Schema.Struct({
    pluginId: PluginId,
    created: Schema.Boolean,
    enabled: Schema.Boolean,
    applied: Schema.Boolean,
    contributes: Schema.Array(PluginContribution),
    worker: Schema.optionalKey(PluginChangeWorker),
    before: Schema.optionalKey(Schema.String),
    after: Schema.String,
    next: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

export const PluginToolkit = Toolkit.make(PluginReadTool, PluginWriteTool);
