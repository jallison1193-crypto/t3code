import {
  PLUGIN_COMMAND_PATTERN,
  PLUGIN_PANEL_COMMAND_PATTERN,
  type KeybindingCommand,
  type PluginId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isPluginSlashCommandKeybinding = Schema.is(PLUGIN_COMMAND_PATTERN);
const isPluginPanelKeybinding = Schema.is(PLUGIN_PANEL_COMMAND_PATTERN);

interface PluginCommandKeybindingTarget {
  readonly pluginId: PluginId;
  readonly commandName: PluginId;
}

interface PluginPanelKeybindingTarget {
  readonly pluginId: PluginId;
  readonly panelId: PluginId;
}

export function commandForPluginCommand(
  pluginId: string,
  commandName: string,
): KeybindingCommand | null {
  const command = `plugin.${pluginId}.command.${commandName}`;
  return isPluginSlashCommandKeybinding(command) ? command : null;
}

export function commandForPluginPanel(pluginId: string, panelId: string): KeybindingCommand | null {
  const command = `plugin.${pluginId}.panel.${panelId}`;
  return isPluginPanelKeybinding(command) ? command : null;
}

export function pluginCommandFromKeybinding(command: string): PluginCommandKeybindingTarget | null {
  const trimmed = command.trim();
  if (!isPluginSlashCommandKeybinding(trimmed)) {
    return null;
  }
  const parts = trimmed.split(".");
  const pluginId = parts[1];
  const commandName = parts[3];
  if (parts.length !== 4 || !pluginId || !commandName) {
    return null;
  }
  return { pluginId, commandName };
}

export function pluginPanelFromKeybinding(command: string): PluginPanelKeybindingTarget | null {
  const trimmed = command.trim();
  if (!isPluginPanelKeybinding(trimmed)) {
    return null;
  }
  const parts = trimmed.split(".");
  const pluginId = parts[1];
  const panelId = parts[3];
  if (parts.length !== 4 || !pluginId || !panelId) {
    return null;
  }
  return { pluginId, panelId };
}

export function isPluginKeybindingCommand(command: string): boolean {
  return (
    pluginCommandFromKeybinding(command) !== null || pluginPanelFromKeybinding(command) !== null
  );
}
