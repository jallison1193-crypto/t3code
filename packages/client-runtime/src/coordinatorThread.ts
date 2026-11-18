import type { ProjectId, ServerSettings, ServerSettingsPatch, ThreadId } from "@t3tools/contracts";

export function coordinatorThreadIdOf(
  settings: Pick<ServerSettings, "projectSettingsOverrides"> | null | undefined,
  projectId: ProjectId | null | undefined,
): ThreadId | null {
  if (!settings || !projectId) return null;
  return settings.projectSettingsOverrides[projectId]?.coordinatorThreadId ?? null;
}

export function buildCoordinatorPatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  threadId: ThreadId | null,
): ServerSettingsPatch {
  const current = settings.projectSettingsOverrides[projectId];
  if (threadId === null) {
    if (!current) {
      return { projectSettingsOverrides: { [projectId]: null } };
    }
    const { coordinatorThreadId: _removed, ...rest } = current;
    return {
      projectSettingsOverrides: {
        [projectId]: Object.keys(rest).length === 0 ? null : rest,
      },
    };
  }
  return {
    projectSettingsOverrides: {
      [projectId]: {
        ...current,
        coordinatorThreadId: threadId,
      },
    },
  };
}
