import type { EnvironmentId } from "@t3tools/contracts";

import { filterNonBotProjects, keepBotProjectsSeparate } from "../../bots/bots.logic";
import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";

export function useSettingsProjectGroups(options?: { readonly includeBots?: boolean }) {
  const allProjects = useProjects();
  // Avoid object selector identities that rebuild groups and every settings row on each write.
  const sidebarProjectGroupingMode = useClientSettings(
    (settings) => settings.sidebarProjectGroupingMode,
  );
  const sidebarProjectGroupingOverrides = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, presentationById } = useEnvironments();
  const getServerSettings = (environmentId: EnvironmentId) =>
    presentationById.get(environmentId)?.serverConfig?.settings;
  const includeBots = options?.includeBots === true;
  const projects = includeBots ? allProjects : filterNonBotProjects(allProjects, getServerSettings);
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  return buildSidebarProjectSnapshots({
    projects,
    settings: {
      sidebarProjectGroupingMode,
      sidebarProjectGroupingOverrides: includeBots
        ? keepBotProjectsSeparate(projects, sidebarProjectGroupingOverrides, getServerSettings)
        : sidebarProjectGroupingOverrides,
    },
    primaryEnvironmentId,
    resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
