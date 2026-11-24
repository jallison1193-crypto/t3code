import type { EnvironmentPlugin, PluginId, ProjectId } from "@t3tools/contracts";

const BUILT_IN_SLASH_COMMAND_NAMES = new Set(["model", "side", "btw", "clear", "compact"]);

interface ResolvedPluginSlashCommand {
  readonly pluginId: PluginId;
  readonly pluginName: string;
  readonly commandName: PluginId;
  readonly invocation: string;
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
}

export function applicableEnvironmentPlugins(
  environmentPlugins: ReadonlyArray<EnvironmentPlugin>,
  activeProjectIds: ProjectId | ReadonlySet<ProjectId> | null,
): ReadonlyArray<EnvironmentPlugin> {
  const globalPlugins = environmentPlugins.filter((plugin) => plugin.projectId === undefined);
  if (activeProjectIds === null) {
    return globalPlugins;
  }
  const repoPlugins =
    typeof activeProjectIds === "string"
      ? environmentPlugins.filter((plugin) => plugin.projectId === activeProjectIds)
      : activeProjectIds.size === 0
        ? []
        : environmentPlugins.filter(
            (plugin) => plugin.projectId !== undefined && activeProjectIds.has(plugin.projectId),
          );
  return [...globalPlugins, ...repoPlugins];
}

export function resolveSlashCommandsFromApplicablePlugins(
  applicablePlugins: ReadonlyArray<EnvironmentPlugin>,
): ReadonlyArray<ResolvedPluginSlashCommand> {
  const pluginCommandsByKey = new Map<
    string,
    {
      readonly pluginId: PluginId;
      readonly pluginName: string;
      readonly commandName: PluginId;
      readonly description?: string | undefined;
      readonly argumentHint?: string | undefined;
    }
  >();
  for (const plugin of applicablePlugins) {
    for (const command of plugin.commands ?? []) {
      pluginCommandsByKey.set(`${plugin.id}:${command.name}`, {
        pluginId: plugin.id,
        pluginName: plugin.displayName ?? plugin.id,
        commandName: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
      });
    }
  }
  const pluginNameCounts = new Map<string, number>();
  for (const entry of pluginCommandsByKey.values()) {
    pluginNameCounts.set(entry.commandName, (pluginNameCounts.get(entry.commandName) ?? 0) + 1);
  }
  return [...pluginCommandsByKey.values()].map((entry) => {
    const useShort =
      (pluginNameCounts.get(entry.commandName) ?? 0) === 1 &&
      !BUILT_IN_SLASH_COMMAND_NAMES.has(entry.commandName);
    const invocation = useShort ? entry.commandName : `${entry.pluginId}:${entry.commandName}`;
    return {
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      commandName: entry.commandName,
      invocation,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.argumentHint !== undefined ? { argumentHint: entry.argumentHint } : {}),
    };
  });
}

export function resolvePluginSlashCommands(
  environmentPlugins: ReadonlyArray<EnvironmentPlugin>,
  activeProjectId: ProjectId | null,
): ReadonlyArray<ResolvedPluginSlashCommand> {
  return resolveSlashCommandsFromApplicablePlugins(
    applicableEnvironmentPlugins(environmentPlugins, activeProjectId),
  );
}

export function applyPluginCommandShortcut(
  value: string,
  invocation: string,
): { readonly value: string; readonly cursor: number } {
  const prefix = `/${invocation}`;
  if (value.trim().length === 0) {
    const next = `${prefix} `;
    return { value: next, cursor: next.length };
  }
  const slashMatch = /^\s*\/\S*/.exec(value);
  if (slashMatch) {
    const rest = value.slice(slashMatch[0].length);
    const next =
      rest.trim().length === 0
        ? `${prefix} `
        : /^\s/.test(rest)
          ? `${prefix}${rest}`
          : `${prefix} ${rest}`;
    return { value: next, cursor: next.length };
  }
  const next = `${prefix} ${value}`;
  return { value: next, cursor: next.length };
}
