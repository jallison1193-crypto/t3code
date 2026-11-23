import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupProjectBoardThreadsForMembers,
  PROJECT_THREAD_BOARD_COLUMNS,
} from "@t3tools/client-runtime/project-thread-board";

import { useQuietThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useUiStateStore } from "~/uiStateStore";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { buildSinceAwayDigest } from "./sinceAwayDigest.logic";

export function useProjectThreadBoard(projectKey: string) {
  const projectGroups = useSettingsProjectGroups();
  const { presentationById } = useEnvironments();
  const shells = useQuietThreadShells();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const group = projectGroups.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const columns = groupProjectBoardThreadsForMembers(
    shells,
    group?.memberProjects ?? [],
    (environmentId) => presentationById.get(environmentId)?.serverConfig?.settings,
  );
  const digest = buildSinceAwayDigest(
    PROJECT_THREAD_BOARD_COLUMNS.flatMap((column) => columns[column]).map((thread) => {
      const lastVisitedAt = resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      );
      return lastVisitedAt === undefined ? thread : { ...thread, lastVisitedAt };
    }),
  );
  const openCount =
    columns.review.length + columns.waiting.length + columns.working.length + columns.idle.length;
  return { group, columns, openCount, digest };
}
