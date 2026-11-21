import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildProjectGroups,
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { AppMode, EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

import { sortScopedProjectsForSidebar } from "./components/Sidebar.logic";

export interface ChatIndexLandingThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export type ChatIndexLandingTarget =
  | {
      readonly kind: "project-home";
      readonly projectRef: ScopedProjectRef;
      readonly projectKey: string;
    }
  | {
      readonly kind: "draft-thread";
      readonly projectRef: ScopedProjectRef;
    }
  | {
      readonly kind: "empty";
    };

export function isEligibleWorkModeLandingProject(
  project: Pick<EnvironmentProject, "archivedAt" | "workspaceRoot" | "isScratch">,
  scratchWorkspaceRoot?: string | null,
): boolean {
  return project.archivedAt == null && !isScratchProject(project, scratchWorkspaceRoot);
}

export function shouldNavigateBootstrapThreadOnIndex(appMode: AppMode): boolean {
  return appMode !== "work";
}

export function resolveChatIndexLandingTarget<TThread extends ChatIndexLandingThread>(input: {
  readonly appMode: AppMode;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<TThread>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly getScratchWorkspaceRoot?: (environmentId: EnvironmentId) => string | null | undefined;
}): ChatIndexLandingTarget {
  if (input.appMode !== "work") {
    const mostRecentProject =
      sortScopedProjectsForSidebar(
        input.projects.filter((project) => project.archivedAt == null),
        input.threads,
        "updated_at",
      )[0] ?? null;
    return mostRecentProject === null
      ? { kind: "empty" }
      : {
          kind: "draft-thread",
          projectRef: scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id),
        };
  }

  const eligibleProjects = input.projects.filter((project) =>
    isEligibleWorkModeLandingProject(
      project,
      input.getScratchWorkspaceRoot?.(project.environmentId),
    ),
  );
  const mostRecentProject =
    sortScopedProjectsForSidebar(eligibleProjects, input.threads, "updated_at")[0] ?? null;
  if (mostRecentProject === null) {
    return { kind: "empty" };
  }

  const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.projectGroupingSettings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  const matchingGroup = groups.find(
    (group) =>
      !group.archived &&
      group.memberProjectRefs.some(
        (ref) =>
          ref.environmentId === projectRef.environmentId && ref.projectId === projectRef.projectId,
      ),
  );
  return {
    kind: "project-home",
    projectRef,
    projectKey:
      matchingGroup?.key ??
      deriveLogicalProjectKeyFromSettings(mostRecentProject, input.projectGroupingSettings),
  };
}
