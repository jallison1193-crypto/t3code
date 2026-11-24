import {
  InstalledPluginAgentSummary,
  InstalledPluginHookSummary,
  InstalledPluginMcpServer,
  InstalledPluginPanel,
  InstalledPluginWorker,
  OrchestratorMcpFailure,
  PLUGIN_PANEL_TITLE_MAX_LENGTH,
  PLUGIN_WORKER_CODE_MAX_CHARS,
  PluginAgentEffortLevel,
  PluginChangeWorker,
  PluginContribution,
  PluginExternalStatus,
  PluginHooksConfig,
  PluginId,
  PluginManifestWorkerFolder,
  PluginMcpServersConfig,
  PluginWorkerEveryMinutes,
} from "@t3tools/contracts";
import {
  PLUGIN_WRITE_TOOL_NAME,
  PluginChangeHook,
  PluginChangeMcpServer,
} from "@t3tools/shared/toolOutput";
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

const PluginAgentContentSchema = Schema.Struct({
  name: PluginId,
  description: Schema.String,
  tools: Schema.optionalKey(Schema.Array(Schema.String)),
  disallowedTools: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(
    Schema.Union([PluginAgentEffortLevel, Schema.Int.check(Schema.isGreaterThan(0))]),
  ),
  maxTurns: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  body: Schema.String,
});

const PluginReadTool = Tool.make("t3_plugin_read", {
  ...shared,
  description:
    "List installed plugins, read one plugin's parts (CSS, panels, worker, skills/commands, instructions, MCP servers, hooks, agents), and get the plugin guide. Call before `t3_plugin_write`.",
  parameters: Schema.Struct({
    pluginId: Schema.optionalKey(
      PluginId.annotate({
        description:
          "Also return this plugin's manifest fields, CSS, panels, worker, skills, instructions, MCP servers, hooks, and agents.",
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
        mcpServers: Schema.optionalKey(Schema.Array(InstalledPluginMcpServer)),
        hooks: Schema.optionalKey(Schema.Array(InstalledPluginHookSummary)),
        agents: Schema.optionalKey(Schema.Array(InstalledPluginAgentSummary)),
        externalStatus: Schema.optionalKey(PluginExternalStatus),
        partProblems: Schema.optionalKey(Schema.Array(Schema.String)),
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
        mcpServers: Schema.optionalKey(PluginMcpServersConfig),
        hooks: Schema.optionalKey(PluginHooksConfig),
        agents: Schema.optionalKey(Schema.Array(PluginAgentContentSchema)),
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
    "Create or update a plugin (CSS, panels, worker, skills/commands, instructions, MCP servers, hooks, or agents) when asked; call `t3_plugin_read` first. Omitted parts stay unchanged. Needs a live full-access/default thread.",
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
    mcpServers: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "MCP server map written to .mcp.json; {} removes it.",
      }),
    ),
    hooks: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Claude hooks event map written to hooks/hooks.json; {} removes it.",
      }),
    ),
    agents: Schema.optionalKey(Schema.Array(PluginAgentContentSchema)),
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
    mcpServers: Schema.optionalKey(Schema.Array(PluginChangeMcpServer)),
    hooks: Schema.optionalKey(Schema.Array(PluginChangeHook)),
    agents: Schema.optionalKey(Schema.Array(PluginId)),
    unsupported: Schema.optionalKey(Schema.Array(Schema.String)),
    before: Schema.optionalKey(Schema.String),
    after: Schema.String,
    next: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

export const PluginToolkit = Toolkit.make(PluginReadTool, PluginWriteTool);
