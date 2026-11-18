import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import {
  PROJECT_THREAD_BOARD_COLUMNS,
  type ProjectThreadBoardColumn,
} from "@t3tools/client-runtime/project-thread-board";
import {
  buildProjectGroups,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ServerSettings, ThreadId } from "@t3tools/contracts";

export type ProjectThreadsRouteParams = {
  readonly projectKey?: string;
  readonly environmentId?: string;
  readonly projectId?: string;
};

export interface ResolvedProjectThreadsTarget {
  readonly groupKey: string;
  readonly displayName: string;
  readonly representative: EnvironmentProject;
  readonly members: readonly EnvironmentProject[];
}

export interface ProjectThreadBoardSection<T = EnvironmentThreadShell> {
  readonly column: ProjectThreadBoardColumn;
  readonly count: number;
  readonly defaultCollapsed: boolean;
  readonly threads: readonly T[];
}

export interface ProjectCoordinatorTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}

export type ServerSettingsLookup = (
  environmentId: EnvironmentId,
) => Pick<ServerSettings, "projectSettingsOverrides"> | null | undefined;

export function resolveProjectThreadsTarget(
  projects: readonly EnvironmentProject[],
  groupingSettings: ProjectGroupingSettings,
  params: ProjectThreadsRouteParams | undefined,
): ResolvedProjectThreadsTarget | null {
  if (!params) return null;
  const groups = buildProjectGroups({ projects, settings: groupingSettings });
  const byKey = params.projectKey
    ? groups.find((group) => group.key === params.projectKey)
    : undefined;
  const group =
    byKey ??
    (params.environmentId && params.projectId
      ? groups.find((candidate) =>
          candidate.members.some(
            (member) =>
              member.project.environmentId === params.environmentId &&
              member.project.id === params.projectId,
          ),
        )
      : undefined);
  if (!group || group.members.length === 0) return null;
  const members = group.members.map((member) => member.project);
  const representative = members[0]!;
  return {
    groupKey: group.key,
    displayName: deriveProjectGroupLabel({
      groupKey: group.key,
      representative,
      members,
    }),
    representative,
    members,
  };
}

export function buildProjectThreadBoardSections<T>(
  columns: Record<ProjectThreadBoardColumn, readonly T[]>,
): ProjectThreadBoardSection<T>[] {
  const sections: ProjectThreadBoardSection<T>[] = [];
  for (const column of PROJECT_THREAD_BOARD_COLUMNS) {
    const threads = columns[column];
    if (threads.length === 0) continue;
    sections.push({
      column,
      count: threads.length,
      defaultCollapsed: column === "done",
      threads,
    });
  }
  return sections;
}

export function resolveProjectCoordinatorTarget(
  members: readonly Pick<EnvironmentProject, "environmentId" | "id">[],
  getServerSettings: ServerSettingsLookup,
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "id" | "title" | "deletedAt">[],
): ProjectCoordinatorTarget | null {
  for (const member of members) {
    const coordinatorId = coordinatorThreadIdOf(getServerSettings(member.environmentId), member.id);
    if (coordinatorId === null) continue;
    const thread = threads.find(
      (candidate) =>
        candidate.environmentId === member.environmentId &&
        candidate.id === coordinatorId &&
        candidate.deletedAt === null,
    );
    if (thread) {
      return {
        environmentId: member.environmentId,
        threadId: coordinatorId,
        title: thread.title,
      };
    }
  }
  return null;
}

export function isProjectCoordinatorThread(
  thread: { readonly id: ThreadId; readonly projectId: ProjectId } | null | undefined,
  serverSettings: Pick<ServerSettings, "projectSettingsOverrides"> | null | undefined,
): boolean {
  if (!thread) return false;
  return coordinatorThreadIdOf(serverSettings, thread.projectId) === thread.id;
}
