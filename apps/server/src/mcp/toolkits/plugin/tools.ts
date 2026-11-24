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

const PluginSkillContentSchema = Schema.Struct({
  name: PluginId,
  description: Schema.optionalKey(Schema.String),
  argumentHint: Schema.optionalKey(Schema.String),
  userInvocable: Schema.optionalKey(Schema.Boolean),
  modelInvocable: Schema.optionalKey(Schema.Boolean),
  body: Schema.String,
});

const PluginReadTool = Tool.make("t3_plugin_read", {
  ...shared,
  description:
    "List installed plugins, read one plugin's parts (CSS, panels, worker, skills/commands, instructions), and get the plugin guide. Call before `t3_plugin_write`.",
  parameters: Schema.Struct({
    pluginId: Schema.optionalKey(
      PluginId.annotate({
        description:
          "Also return this plugin's manifest fields, CSS, panels, worker, skills, and instructions.",
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
        commands: Schema.optionalKey(Schema.Array(PluginId)),
        skills: Schema.optionalKey(Schema.Array(PluginId)),
        unsupported: Schema.optionalKey(Schema.Array(Schema.String)),
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
        skills: Schema.optionalKey(Schema.Array(PluginSkillContentSchema)),
        instructions: Schema.optionalKey(Schema.String),
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
    "Create or update a plugin (CSS, panels, worker, skills/commands, or AGENTS.md instructions) when asked; call `t3_plugin_read` first. Omitted parts stay unchanged. Needs a live full-access/default thread.",
  parameters: Schema.Struct({
    pluginId: PluginId,
    displayName: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
    css: Schema.optionalKey(Schema.String),
    panels: Schema.optionalKey(Schema.Array(PluginPanelContentSchema)),
    worker: Schema.optionalKey(PluginWorkerContentSchema),
    skills: Schema.optionalKey(Schema.Array(PluginSkillContentSchema)),
    instructions: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    pluginId: PluginId,
    created: Schema.Boolean,
    enabled: Schema.Boolean,
    applied: Schema.Boolean,
    contributes: Schema.Array(PluginContribution),
    worker: Schema.optionalKey(PluginChangeWorker),
    commands: Schema.optionalKey(Schema.Array(PluginId)),
    skills: Schema.optionalKey(Schema.Array(PluginId)),
    unsupported: Schema.optionalKey(Schema.Array(Schema.String)),
    before: Schema.optionalKey(Schema.String),
    after: Schema.String,
    next: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

export const PluginToolkit = Toolkit.make(PluginReadTool, PluginWriteTool);
