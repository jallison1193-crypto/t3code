import {
  McpAppHostRefusal,
  type McpAppCallToolResult,
  type McpAppDisplayMode,
} from "@t3tools/client-runtime/mcp-apps";
import type { InstalledPlugin, PluginStateScope, ProjectId } from "@t3tools/contracts";

export interface PluginPanelLauncherItem {
  readonly id: `plugin:${string}:${string}`;
  readonly pluginId: string;
  readonly panelId: string;
  readonly title: string;
  readonly pluginTitle: string;
}

export type PluginPanelStatus =
  | { readonly status: "loading" }
  | { readonly status: "enabled"; readonly title: string; readonly pluginTitle: string }
  | { readonly status: "disabled"; readonly title: string };

export function pluginPanelLauncherItems(
  plugins: ReadonlyArray<InstalledPlugin> | null | undefined,
): ReadonlyArray<PluginPanelLauncherItem> {
  if (!plugins) return [];
  const items: Array<PluginPanelLauncherItem> = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.problem !== undefined || !plugin.panels?.length) continue;
    const pluginTitle = plugin.displayName ?? plugin.id;
    for (const panel of plugin.panels) {
      items.push({
        id: `plugin:${plugin.id}:${panel.id}`,
        pluginId: plugin.id,
        panelId: panel.id,
        title: panel.title,
        pluginTitle,
      });
    }
  }
  return items;
}

export function resolvePluginPanelStatus(
  plugins: ReadonlyArray<InstalledPlugin> | null | undefined,
  pluginId: string,
  panelId: string,
): PluginPanelStatus {
  if (plugins === null || plugins === undefined) return { status: "loading" };
  const plugin = plugins.find((entry) => entry.id === pluginId);
  const panel = plugin?.panels?.find((entry) => entry.id === panelId);
  if (
    plugin !== undefined &&
    plugin.enabled &&
    plugin.problem === undefined &&
    panel !== undefined
  ) {
    return {
      status: "enabled",
      title: panel.title,
      pluginTitle: plugin.displayName ?? plugin.id,
    };
  }
  return {
    status: "disabled",
    title: panel?.title ?? panelId,
  };
}

export function resolvePluginPanelTitle(
  plugins: ReadonlyArray<InstalledPlugin> | null | undefined,
  pluginId: string,
  panelId: string,
): string {
  const plugin = plugins?.find((entry) => entry.id === pluginId);
  const panel = plugin?.panels?.find((entry) => entry.id === panelId);
  return panel?.title ?? panelId;
}

function resolvePluginPanelScope(
  scope: unknown,
  projectId: ProjectId | undefined,
): PluginStateScope {
  if (scope === "global") return "global";
  if (scope === "project") {
    if (projectId === undefined) {
      throw new McpAppHostRefusal({
        message: "Project state is only available inside a project thread.",
      });
    }
    return { projectId };
  }
  throw new McpAppHostRefusal({ message: 'Scope must be "global" or "project".' });
}

export interface PluginPanelBridgeDeps {
  readonly projectId: ProjectId | undefined;
  readonly getState: (scope: PluginStateScope) => Promise<unknown>;
  readonly setState: (scope: PluginStateScope, value: unknown) => Promise<void>;
}

const jsonToolResult = (structuredContent: Record<string, unknown>): McpAppCallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  structuredContent,
});

export async function handlePluginPanelToolCall(
  input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  },
  deps: PluginPanelBridgeDeps,
): Promise<McpAppCallToolResult> {
  switch (input.name) {
    case "t3_plugin_state_get": {
      const scope = resolvePluginPanelScope(input.arguments.scope, deps.projectId);
      const value = await deps.getState(scope);
      return jsonToolResult({ value });
    }
    case "t3_plugin_state_set": {
      const scope = resolvePluginPanelScope(input.arguments.scope, deps.projectId);
      if (!Object.hasOwn(input.arguments, "value")) {
        throw new McpAppHostRefusal({ message: "t3_plugin_state_set requires a value." });
      }
      await deps.setState(scope, input.arguments.value);
      return jsonToolResult({ ok: true });
    }
    default:
      throw new McpAppHostRefusal({ message: "This panel cannot call that tool." });
  }
}

export function createPluginPanelRefusedHandlers(currentDisplayMode: McpAppDisplayMode = "inline") {
  return {
    readResource: async () => {
      throw new McpAppHostRefusal({
        message: "Reading resources is not supported in plugin panels.",
      });
    },
    sendMessage: async () => {
      throw new McpAppHostRefusal({
        message: "Sending messages is not supported in plugin panels.",
      });
    },
    updateModelContext: async () => {
      throw new McpAppHostRefusal({
        message: "Updating model context is not supported in plugin panels.",
      });
    },
    downloadFile: async () => {
      throw new McpAppHostRefusal({
        message: "Downloading files is not supported in plugin panels.",
      });
    },
    requestDisplayMode: async () => currentDisplayMode,
  };
}
