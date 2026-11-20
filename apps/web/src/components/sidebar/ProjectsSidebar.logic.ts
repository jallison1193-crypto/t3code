import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import {
  groupProjectBoardThreadsForMembers,
  projectThreadBoardColumn,
  type ProjectGroupServerSettingsLookup,
} from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { filterThreadsByMode } from "@t3tools/client-runtime/state/thread-mode";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { SidebarModeFilter } from "@t3tools/contracts/settings";

export const OTHER_THREADS_LIMIT = 10;
const PROJECTS_SIDEBAR_EXPANDED_STORAGE_KEY = "t3code:projects-sidebar-expanded-projects";

export type ProjectsSidebarThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "lastVisitedAt"
  | "updatedAt"
  | "pinnedAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly source?: Pick<EnvironmentThreadShell["source"], "tags"> | undefined;
};

export interface ProjectsSidebarGroupMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly isScratch?: boolean;
}

export interface ProjectsSidebarGroupInput {
  readonly projectKey: string;
  readonly displayName: string;
  readonly archived: boolean;
  readonly isScratch?: boolean;
  readonly memberProjects: ReadonlyArray<ProjectsSidebarGroupMember>;
}

export interface ProjectsSidebarProjectEntry<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
> {
  readonly group: TGroup;
  readonly activeThreads: ReadonlyArray<TThread>;
  readonly attentionCount: number;
  readonly attentionTone: "waiting" | "review" | null;
}

export interface ProjectsSidebarSections<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
> {
  readonly needsYou: ReadonlyArray<TThread>;
  readonly projects: ReadonlyArray<ProjectsSidebarProjectEntry<TGroup, TThread>>;
  readonly pinned: ReadonlyArray<TThread>;
  readonly otherThreads: ReadonlyArray<TThread>;
}

function isScratchProjectGroup(group: ProjectsSidebarGroupInput): boolean {
  return (
    group.isScratch === true ||
    (group.memberProjects.length > 0 &&
      group.memberProjects.every((member) => member.isScratch === true))
  );
}

function compareThreadsNewestFirst(
  a: Pick<ProjectsSidebarThread, "updatedAt">,
  b: Pick<ProjectsSidebarThread, "updatedAt">,
): number {
  return (toSortableTimestamp(b.updatedAt) ?? 0) - (toSortableTimestamp(a.updatedAt) ?? 0);
}

export function buildProjectsSidebarSections<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
>(input: {
  readonly projectGroups: ReadonlyArray<TGroup>;
  readonly threads: ReadonlyArray<TThread>;
  readonly getServerSettings: ProjectGroupServerSettingsLookup;
  readonly modeFilter?: SidebarModeFilter;
}): ProjectsSidebarSections<TGroup, TThread> {
  const knownProjectMemberKeys = new Set<string>();
  const projects: ProjectsSidebarProjectEntry<TGroup, TThread>[] = [];
  const modeFilteredThreads = filterThreadsByMode(input.threads, input.modeFilter ?? "all");

  for (const group of input.projectGroups) {
    if (isScratchProjectGroup(group)) continue;
    for (const member of group.memberProjects) {
      knownProjectMemberKeys.add(`${member.environmentId}:${member.id}`);
    }
    if (group.archived) continue;

    const columns = groupProjectBoardThreadsForMembers(
      modeFilteredThreads,
      group.memberProjects,
      input.getServerSettings,
    );
    const activeThreads = [...columns.waiting, ...columns.working];
    const attentionCount = columns.waiting.length + columns.review.length;
    const attentionTone =
      columns.waiting.length > 0 ? "waiting" : columns.review.length > 0 ? "review" : null;
    projects.push({ group, activeThreads, attentionCount, attentionTone });
  }

  const eligibleThreads = input.threads
    .filter((thread) => {
      if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
      if (!isListedThreadLineage(thread.lineage)) return false;
      const coordinatorId = coordinatorThreadIdOf(
        input.getServerSettings(thread.environmentId),
        thread.projectId,
      );
      return coordinatorId !== thread.id;
    })
    .toSorted(compareThreadsNewestFirst);

  const needsYou = eligibleThreads.filter(
    (thread) => projectThreadBoardColumn(thread) === "waiting",
  );
  const modeEligibleThreads = filterThreadsByMode(eligibleThreads, input.modeFilter ?? "all");
  const pinned = modeEligibleThreads.filter((thread) => thread.pinnedAt !== null);
  const otherThreads = modeEligibleThreads
    .filter((thread) => !knownProjectMemberKeys.has(`${thread.environmentId}:${thread.projectId}`))
    .slice(0, OTHER_THREADS_LIMIT);

  return { needsYou, projects, pinned, otherThreads };
}

export function readExpandedProjectKeys(
  storage: Pick<Storage, "getItem"> | null | undefined = typeof window !== "undefined"
    ? window.localStorage
    : null,
): Record<string, boolean> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PROJECTS_SIDEBAR_EXPANDED_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const expanded: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") expanded[key] = value;
    }
    return expanded;
  } catch {
    return {};
  }
}

export function writeExpandedProjectKeys(
  expanded: Record<string, boolean>,
  storage: Pick<Storage, "setItem"> | null | undefined = typeof window !== "undefined"
    ? window.localStorage
    : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(PROJECTS_SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify(expanded));
  } catch {
    // Ignore storage quota or private browsing errors.
  }
}

export function toggleExpandedProjectKey(
  expanded: Record<string, boolean>,
  projectKey: string,
): Record<string, boolean> {
  return {
    ...expanded,
    [projectKey]: !expanded[projectKey],
  };
}
