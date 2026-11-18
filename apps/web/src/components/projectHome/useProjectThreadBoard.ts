import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import { groupProjectThreads } from "@t3tools/client-runtime/project-thread-board";
import type { ThreadId } from "@t3tools/contracts";

import { useQuietThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";

export function useProjectThreadBoard(projectKey: string) {
  const projectGroups = useSettingsProjectGroups();
  const { presentationById } = useEnvironments();
  const shells = useQuietThreadShells();
  const group = projectGroups.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const memberKeys = new Set<string>();
  const coordinatorThreadIds = new Set<ThreadId>();
  for (const member of group?.memberProjects ?? []) {
    memberKeys.add(`${member.environmentId}:${member.id}`);
    const settings = presentationById.get(member.environmentId)?.serverConfig?.settings;
    const coordinatorId = coordinatorThreadIdOf(settings, member.id);
    if (coordinatorId !== null) coordinatorThreadIds.add(coordinatorId);
  }
  const columns = groupProjectThreads(
    shells.filter((shell) => memberKeys.has(`${shell.environmentId}:${shell.projectId}`)),
    { coordinatorThreadIds },
  );
  const openCount =
    columns.review.length + columns.waiting.length + columns.working.length + columns.idle.length;
  return { group, columns, openCount };
}
