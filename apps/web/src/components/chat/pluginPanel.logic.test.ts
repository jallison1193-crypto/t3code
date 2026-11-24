import { McpAppHostRefusal } from "@t3tools/client-runtime/mcp-apps";
import { ProjectId, type InstalledPlugin, type PluginStateScope } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPluginPanelRefusedHandlers,
  handlePluginPanelToolCall,
  pluginPanelLauncherItems,
  resolvePluginPanelStatus,
  resolvePluginPanelTitle,
} from "./pluginPanel.logic";

const PLUGINS: ReadonlyArray<InstalledPlugin> = [
  {
    id: "pomodoro",
    displayName: "Pomodoro",
    enabled: true,
    contributes: ["panel"],
    panels: [
      { id: "timer", title: "Pomodoro Timer" },
      { id: "log", title: "Focus Log" },
    ],
  },
  {
    id: "disabled-plugin",
    displayName: "Disabled",
    enabled: false,
    contributes: ["panel"],
    panels: [{ id: "main", title: "Hidden Panel" }],
  },
  {
    id: "broken-plugin",
    displayName: "Broken",
    enabled: true,
    problem: "Manifest invalid",
    contributes: [],
    panels: [{ id: "main", title: "Broken Panel" }],
  },
  {
    id: "css-only",
    displayName: "CSS Only",
    enabled: true,
    contributes: ["css"],
  },
];

describe("pluginPanel.logic", () => {
  it("lists launcher items only for enabled, problem-free plugins with panels", () => {
    expect(pluginPanelLauncherItems(undefined)).toEqual([]);
    expect(pluginPanelLauncherItems(PLUGINS)).toEqual([
      {
        id: "plugin:pomodoro:timer",
        pluginId: "pomodoro",
        panelId: "timer",
        title: "Pomodoro Timer",
        pluginTitle: "Pomodoro",
      },
      {
        id: "plugin:pomodoro:log",
        pluginId: "pomodoro",
        panelId: "log",
        title: "Focus Log",
        pluginTitle: "Pomodoro",
      },
    ]);
  });

  it("resolves panel status and fallback titles across loading, enabled, off, broken, and missing plugins", () => {
    expect(resolvePluginPanelStatus(null, "pomodoro", "timer")).toEqual({ status: "loading" });
    expect(resolvePluginPanelStatus(PLUGINS, "pomodoro", "timer")).toEqual({
      status: "enabled",
      title: "Pomodoro Timer",
      pluginTitle: "Pomodoro",
    });
    expect(resolvePluginPanelStatus(PLUGINS, "disabled-plugin", "main")).toEqual({
      status: "disabled",
      title: "Hidden Panel",
    });
    expect(resolvePluginPanelStatus(PLUGINS, "broken-plugin", "main")).toEqual({
      status: "disabled",
      title: "Broken Panel",
    });
    expect(resolvePluginPanelStatus(PLUGINS, "uninstalled", "notes")).toEqual({
      status: "disabled",
      title: "notes",
    });

    expect(resolvePluginPanelTitle(PLUGINS, "pomodoro", "log")).toBe("Focus Log");
    expect(resolvePluginPanelTitle(PLUGINS, "uninstalled", "notes")).toBe("notes");
  });

  it("allows only t3_plugin_state_get and t3_plugin_state_set and refuses unknown tools or missing project", async () => {
    const projectId = ProjectId.make("project-1");
    const calls: Array<{
      readonly op: "get" | "set";
      readonly scope: PluginStateScope;
      readonly value?: unknown;
    }> = [];
    const deps = {
      projectId,
      getState: vi.fn(async (scope: PluginStateScope) => {
        calls.push({ op: "get", scope });
        return scope === "global" ? { count: 2 } : { task: "ship" };
      }),
      setState: vi.fn(async (scope: PluginStateScope, value: unknown) => {
        calls.push({ op: "set", scope, value });
      }),
    };

    expect(
      await handlePluginPanelToolCall(
        { name: "t3_plugin_state_get", arguments: { scope: "global" } },
        deps,
      ),
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify({ value: { count: 2 } }) }],
      structuredContent: { value: { count: 2 } },
    });

    expect(
      await handlePluginPanelToolCall(
        { name: "t3_plugin_state_set", arguments: { scope: "project", value: { done: true } } },
        deps,
      ),
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      structuredContent: { ok: true },
    });

    expect(calls).toEqual([
      { op: "get", scope: "global" },
      { op: "set", scope: { projectId }, value: { done: true } },
    ]);

    await expect(
      handlePluginPanelToolCall(
        { name: "t3_plugin_state_get", arguments: { scope: "project" } },
        { ...deps, projectId: undefined },
      ),
    ).rejects.toBeInstanceOf(McpAppHostRefusal);

    await expect(
      handlePluginPanelToolCall(
        { name: "t3_plugin_state_get", arguments: { scope: "thread" } },
        deps,
      ),
    ).rejects.toBeInstanceOf(McpAppHostRefusal);

    await expect(
      handlePluginPanelToolCall(
        { name: "t3_plugin_state_set", arguments: { scope: "global" } },
        deps,
      ),
    ).rejects.toBeInstanceOf(McpAppHostRefusal);

    await expect(
      handlePluginPanelToolCall({ name: "t3_plugin_write", arguments: {} }, deps),
    ).rejects.toBeInstanceOf(McpAppHostRefusal);
  });

  it("refuses resources/read, ui/message, ui/update-model-context, and ui/download-file and preserves display mode", async () => {
    const handlers = createPluginPanelRefusedHandlers("inline");
    await expect(handlers.readResource()).rejects.toBeInstanceOf(McpAppHostRefusal);
    await expect(handlers.sendMessage()).rejects.toBeInstanceOf(McpAppHostRefusal);
    await expect(handlers.updateModelContext()).rejects.toBeInstanceOf(McpAppHostRefusal);
    await expect(handlers.downloadFile()).rejects.toBeInstanceOf(McpAppHostRefusal);
    expect(await handlers.requestDisplayMode()).toBe("inline");
  });
});
