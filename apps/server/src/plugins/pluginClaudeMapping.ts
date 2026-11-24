import type {
  AgentDefinition as ClaudeSdkAgentDefinition,
  Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import type { PluginHookHandler, PluginHookMatcherGroup } from "@t3tools/contracts";
import type { ProviderAdapterV2PluginAgent } from "@t3tools/provider-core/server/ProviderAdapter";

type ClaudeSdkHooksMap = NonNullable<ClaudeSdkSettings["hooks"]>;
type ClaudeSdkHookMatcherGroup = ClaudeSdkHooksMap[string][number];
type ClaudeSdkHookHandler = ClaudeSdkHookMatcherGroup["hooks"][number];

const ALLOWED_AGENT_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function cloneHookHandler(handler: PluginHookHandler): ClaudeSdkHookHandler {
  switch (handler.type) {
    case "command": {
      const { args, ...rest } = handler;
      return {
        ...rest,
        ...(args !== undefined ? { args: [...args] } : {}),
      };
    }
    case "http": {
      const { headers, allowedEnvVars, ...rest } = handler;
      return {
        ...rest,
        ...(headers !== undefined ? { headers: { ...headers } } : {}),
        ...(allowedEnvVars !== undefined ? { allowedEnvVars: [...allowedEnvVars] } : {}),
      };
    }
    case "mcp_tool": {
      const { input, ...rest } = handler;
      return {
        ...rest,
        ...(input !== undefined ? { input: { ...input } } : {}),
      };
    }
    case "prompt":
      return { ...handler };
    case "agent":
      return { ...handler };
  }
}

export function mergeClaudePluginHooks(
  existing: ClaudeSdkSettings["hooks"] | undefined,
  pluginHooks: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>> | undefined,
): ClaudeSdkHooksMap | undefined {
  const hasPluginHooks =
    pluginHooks !== undefined && Object.values(pluginHooks).some((groups) => groups.length > 0);
  if (!hasPluginHooks) {
    return existing;
  }

  const merged: Record<string, Array<ClaudeSdkHookMatcherGroup>> = {};
  if (existing !== undefined) {
    for (const [event, groups] of Object.entries(existing)) {
      if (Array.isArray(groups)) {
        merged[event] = [...groups];
      }
    }
  }

  for (const [event, groups] of Object.entries(pluginHooks)) {
    if (groups.length === 0) continue;
    const current = merged[event] ?? [];
    const mapped: Array<ClaudeSdkHookMatcherGroup> = groups.map((group) => ({
      ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
      hooks: group.hooks.map(cloneHookHandler),
    }));
    merged[event] = [...current, ...mapped];
  }

  return merged;
}

export function mapClaudePluginAgents(
  agents: ReadonlyArray<ProviderAdapterV2PluginAgent> | undefined,
): Record<string, ClaudeSdkAgentDefinition> | undefined {
  if (agents === undefined || agents.length === 0) {
    return undefined;
  }
  const result: Record<string, ClaudeSdkAgentDefinition> = {};
  for (const agent of agents) {
    const key = `${agent.pluginId}:${agent.name}`;
    const effort =
      typeof agent.effort === "number"
        ? Number.isInteger(agent.effort) && agent.effort > 0
          ? agent.effort
          : undefined
        : typeof agent.effort === "string" && ALLOWED_AGENT_EFFORTS.has(agent.effort)
          ? agent.effort
          : undefined;
    const maxTurns =
      typeof agent.maxTurns === "number" && Number.isInteger(agent.maxTurns) && agent.maxTurns > 0
        ? agent.maxTurns
        : undefined;
    result[key] = {
      description: agent.description,
      prompt: agent.prompt,
      ...(agent.tools !== undefined && agent.tools.length > 0 ? { tools: [...agent.tools] } : {}),
      ...(agent.disallowedTools !== undefined && agent.disallowedTools.length > 0
        ? { disallowedTools: [...agent.disallowedTools] }
        : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
