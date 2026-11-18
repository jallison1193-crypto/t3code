import { groupProjectBoardThreadsForMembers } from "@t3tools/client-runtime/project-thread-board";

import { useQuietThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";

export function useProjectThreadBoard(projectKey: string) {
  const projectGroups = useSettingsProjectGroups();
  const { presentationById } = useEnvironments();
  const shells = useQuietThreadShells();
  const group = projectGroups.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const columns = groupProjectBoardThreadsForMembers(
    shells,
    group?.memberProjects ?? [],
    (environmentId) => presentationById.get(environmentId)?.serverConfig?.settings,
  );
  const openCount =
    columns.review.length + columns.waiting.length + columns.working.length + columns.idle.length;
  return { group, columns, openCount };
}
