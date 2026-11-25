import {
  isBotPaused,
  isBotProject,
  isListedThreadLineage,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";

import type {
  ProjectsSidebarGroupInput,
  ProjectsSidebarThread,
} from "../components/sidebar/ProjectsSidebar.logic";

type BotServerSettingsLike =
  | (Pick<ServerSettings, "projectSettingsOverrides"> & {
      readonly botsEnabled?: boolean | undefined;
    })
  | null
  | undefined;

export type BotSettingsLookup = (environmentId: EnvironmentId) => BotServerSettingsLike;

export function isAnyBotsEnabled(
  environments: ReadonlyArray<{
    readonly serverConfig?: {
      readonly settings?: { readonly botsEnabled?: boolean | undefined } | undefined;
    } | null;
  }>,
): boolean {
  return environments.some(
    (environment) =>
      environment.serverConfig != null && environment.serverConfig.settings?.botsEnabled !== false,
  );
}

export function isBotEnvironmentEnabled(
  settings: { readonly botsEnabled?: boolean | undefined } | null | undefined,
): boolean {
  return settings != null && settings.botsEnabled !== false;
}

export function isBotProjectGroup(
  group: Pick<ProjectsSidebarGroupInput, "memberProjects">,
  getServerSettings: BotSettingsLookup,
): boolean {
  return (
    group.memberProjects.length > 0 &&
    group.memberProjects.every((member) =>
      isBotProject(getServerSettings(member.environmentId), member.id),
    )
  );
}

export function isBotThreadVisibleInNeedsYou(
  settings: BotServerSettingsLike,
  projectId: ProjectId,
): boolean {
  if (!isBotProject(settings, projectId)) return true;
  return isBotEnvironmentEnabled(settings);
}

export function filterNonBotProjects<
  TProject extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  projects: ReadonlyArray<TProject>,
  getServerSettings: BotSettingsLookup,
): ReadonlyArray<TProject> {
  return projects.filter(
    (project) => !isBotProject(getServerSettings(project.environmentId), project.id),
  );
}

// A bot folder can sit inside a repository; repository grouping would merge it with that repo's project.
export function keepBotProjectsSeparate(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>,
  overrides: Record<string, SidebarProjectGroupingMode>,
  getServerSettings: BotSettingsLookup,
): Record<string, SidebarProjectGroupingMode> {
  const botProjects = projects.filter((project) =>
    isBotProject(getServerSettings(project.environmentId), project.id),
  );
  if (botProjects.length === 0) return overrides;
  const next = { ...overrides };
  for (const project of botProjects) next[derivePhysicalProjectKey(project)] = "separate";
  return next;
}

export function filterNonBotThreads<
  TThread extends { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
>(threads: ReadonlyArray<TThread>, getServerSettings: BotSettingsLookup): ReadonlyArray<TThread> {
  return threads.filter(
    (thread) => !isBotProject(getServerSettings(thread.environmentId), thread.projectId),
  );
}

export interface BotSidebarEntry<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
> {
  readonly group: TGroup;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly paused: boolean;
  readonly runThreads: ReadonlyArray<TThread>;
}

function compareThreadsNewestFirst(
  a: Pick<ProjectsSidebarThread, "updatedAt">,
  b: Pick<ProjectsSidebarThread, "updatedAt">,
): number {
  return (toSortableTimestamp(b.updatedAt) ?? 0) - (toSortableTimestamp(a.updatedAt) ?? 0);
}

export function deriveBotSidebarEntries<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
>(input: {
  readonly projectGroups: ReadonlyArray<TGroup>;
  readonly threads: ReadonlyArray<TThread>;
  readonly getServerSettings: BotSettingsLookup;
}): ReadonlyArray<BotSidebarEntry<TGroup, TThread>> {
  const listedThreads = input.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        isListedThreadLineage(thread.lineage),
    )
    .toSorted(compareThreadsNewestFirst);

  const entries: BotSidebarEntry<TGroup, TThread>[] = [];
  for (const group of input.projectGroups) {
    if (group.archived || !isBotProjectGroup(group, input.getServerSettings)) continue;
    const primary = group.memberProjects[0];
    if (!primary) continue;
    const settings = input.getServerSettings(primary.environmentId);
    if (!isBotEnvironmentEnabled(settings)) continue;
    const memberKeys = new Set(
      group.memberProjects.map((member) => `${member.environmentId}:${member.id}`),
    );
    const runThreads = listedThreads.filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    entries.push({
      group,
      environmentId: primary.environmentId,
      projectId: primary.id,
      name: group.displayName,
      paused: isBotPaused(settings, primary.id),
      runThreads,
    });
  }
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}
